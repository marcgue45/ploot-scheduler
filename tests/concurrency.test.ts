/**
 * Requisito duro 2: seguro con N réplicas. Ni dos workers publican el mismo post, ni un crash a
 * mitad de publicación provoca doble publicación.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimBatch, reapExpiredLeases } from "../worker/src/claim";
import { runWorker } from "../worker/src/main";
import { processPost } from "../worker/src/process";
import { adminPool, deps, makeAmbassador, makePost, makeTenant, resetDb, startMock, waitFor, workerPool } from "./helpers";

const admin = adminPool();
afterAll(() => admin.end());
beforeEach(() => resetDb(admin));

describe("N réplicas", () => {
  it("4 workers concurrentes publican 60 posts exactamente una vez cada uno", async () => {
    const mock = await startMock({ latencyMaxMs: 30 });
    const postIds: string[] = [];
    for (let t = 0; t < 3; t++) {
      const tenant = await makeTenant(admin, `t${t}`);
      for (let a = 0; a < 4; a++) {
        const amb = await makeAmbassador(admin, tenant);
        for (let p = 0; p < 5; p++) postIds.push(await makePost(admin, tenant, amb, { minutesFromNow: -10 + p }));
      }
    }
    const pools = Array.from({ length: 4 }, () => workerPool());
    let running = true;
    const workers = pools.map((pool, i) => runWorker(deps(pool, mock.url, `w${i}`), () => running));

    await waitFor(async () => (await admin.query("SELECT count(*)::int AS n FROM posts WHERE status = 'published'")).rows[0].n === postIds.length);
    running = false;
    await Promise.all(workers);
    await Promise.all(pools.map((p) => p.end()));
    await mock.close();

    expect(mock.stats.publishedTotal).toBe(postIds.length);
    expect([...mock.stats.publishesByKey.values()].every((n) => n === 1)).toBe(true);
    const ext = await admin.query("SELECT count(DISTINCT external_id)::int AS n FROM posts WHERE status = 'published'");
    expect(ext.rows[0].n).toBe(postIds.length);
    // Una sola transición publishing->published por post (nadie lo finalizó dos veces).
    const ev = await admin.query(
      "SELECT post_id, count(*)::int AS n FROM post_events WHERE to_status = 'published' GROUP BY post_id HAVING count(*) > 1",
    );
    expect(ev.rowCount).toBe(0);
  });

  it("un claim concurrente nunca entrega el mismo post a dos workers", async () => {
    const tenant = await makeTenant(admin);
    for (let a = 0; a < 20; a++) await makePost(admin, tenant, await makeAmbassador(admin, tenant));
    const pools = Array.from({ length: 5 }, () => workerPool());
    const opts = { max: 10, globalConcurrency: 100, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 };
    const results = await Promise.all(
      pools.flatMap((pool, i) => [0, 1, 2].map((j) => claimBatch(pool, { ...opts, workerId: `w${i}-${j}` }))),
    );
    await Promise.all(pools.map((p) => p.end()));
    const ids = results.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("crash a mitad de publicación", () => {
  it("el proveedor publicó pero el worker murió antes de guardar: el reintento no duplica", async () => {
    const mock = await startMock();
    const tenant = await makeTenant(admin);
    const amb = await makeAmbassador(admin, tenant);
    const postId = await makePost(admin, tenant, amb);

    // Worker A: el proveedor responde 200 y el proceso "muere" antes de escribir en la BD.
    const poolA = workerPool();
    let externalSeenByA: string | undefined;
    const depsA = deps(poolA, mock.url, "worker-A", {}, {
      afterProviderCall: (_p, result) => {
        if (result.kind === "ok") externalSeenByA = result.externalId;
        throw new Error("simulated crash (SIGKILL) after provider call");
      },
    });
    const [claimed] = await claimBatch(poolA, { workerId: "worker-A", max: 1, globalConcurrency: 10, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 });
    await processPost(depsA, claimed);
    await poolA.end();
    expect(externalSeenByA).toBeDefined();
    expect((await admin.query("SELECT status FROM posts WHERE id = $1", [postId])).rows[0].status).toBe("publishing");

    // Mientras el lease está vivo, nadie más puede cogerlo.
    const poolB = workerPool();
    const claimOpts = { workerId: "worker-B", max: 5, globalConcurrency: 10, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 };
    expect(await claimBatch(poolB, claimOpts)).toHaveLength(0);

    // El lease caduca -> el reaper lo devuelve a la cola.
    await admin.query("UPDATE posts SET lease_until = now() - interval '1 second' WHERE id = $1", [postId]);
    expect(await reapExpiredLeases(poolB, 5, "worker-B")).toBe(1);
    const reaped = (await admin.query("SELECT status, attempts, last_error_code FROM posts WHERE id = $1", [postId])).rows[0];
    expect(reaped).toMatchObject({ status: "scheduled", attempts: 1, last_error_code: "LEASE_EXPIRED" });

    // Worker B lo reintenta con el mismo Idempotency-Key: el proveedor devuelve la publicación original.
    const [again] = await claimBatch(poolB, claimOpts);
    await processPost(deps(poolB, mock.url, "worker-B"), again);
    await poolB.end();
    await mock.close();

    const final = (await admin.query("SELECT status, external_id FROM posts WHERE id = $1", [postId])).rows[0];
    expect(final.status).toBe("published");
    expect(final.external_id).toBe(externalSeenByA);
    expect(mock.stats.publishedTotal).toBe(1);
  });

  it("un worker zombi (lease perdido) no puede pisar el resultado del que lo reclamó después", async () => {
    const mock = await startMock();
    const tenant = await makeTenant(admin);
    const amb = await makeAmbassador(admin, tenant);
    const postId = await makePost(admin, tenant, amb);
    const pool = workerPool();
    const opts = { max: 1, globalConcurrency: 10, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 };
    const [zombie] = await claimBatch(pool, { ...opts, workerId: "zombie" });
    await admin.query("UPDATE posts SET lease_until = now() - interval '1 second' WHERE id = $1", [postId]);
    await reapExpiredLeases(pool, 5, "reaper");
    const [fresh] = await claimBatch(pool, { ...opts, workerId: "fresh" });
    expect(fresh.claim_id).not.toBe(zombie.claim_id);

    await processPost(deps(pool, mock.url, "zombie"), zombie); // su UPDATE no casa con el claim_id actual
    expect((await admin.query("SELECT status, locked_by FROM posts WHERE id = $1", [postId])).rows[0]).toMatchObject({ status: "publishing", locked_by: "fresh" });
    await processPost(deps(pool, mock.url, "fresh"), fresh);
    expect((await admin.query("SELECT status FROM posts WHERE id = $1", [postId])).rows[0].status).toBe("published");
    expect(mock.stats.publishedTotal).toBe(1); // mismo Idempotency-Key -> una sola publicación real
    await pool.end();
    await mock.close();
  });
});
