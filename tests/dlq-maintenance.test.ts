/** Replay de la DLQ (API, bajo RLS) y limpieza de Idempotency-Keys caducadas (worker). */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimBatch } from "../worker/src/claim";
import { purgeIdempotencyKeys } from "../worker/src/maintenance";
import { processPost } from "../worker/src/process";
import { adminPool, bearer, deps, makeAmbassador, makePost, makeTenant, resetDb, startMock, workerPool } from "./helpers";

const admin = adminPool();
const pool = workerPool();
afterAll(async () => {
  await admin.end();
  await pool.end();
});
beforeEach(() => resetDb(admin));

const claimOpts = { workerId: "w", max: 10, globalConcurrency: 10, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 };

async function replay(auth: string, id: number) {
  const route = await import("../app/src/app/api/v1/dead-letters/[id]/replay/route");
  return route.POST(new Request(`http://x/api/v1/dead-letters/${id}/replay`, { method: "POST", headers: { authorization: auth } }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

describe("DLQ replay", () => {
  it("reencola un post agotado una sola vez y otro tenant no puede tocarlo", async () => {
    const mock = await startMock({ fail5xxRate: 1 });
    const t = await makeTenant(admin, "A");
    const other = await makeTenant(admin, "B");
    const a = await makeAmbassador(admin, t);
    const b = await makeAmbassador(admin, other);
    const p = await makePost(admin, t, a);
    for (let i = 0; i < 5; i++) {
      await admin.query("UPDATE posts SET run_at = now() WHERE id = $1 AND status = 'scheduled'", [p]);
      for (const c of await claimBatch(pool, claimOpts)) await processPost(deps(pool, mock.url, "w"), c);
    }
    await mock.close();
    const dl = (await admin.query("SELECT id FROM dead_letters WHERE post_id = $1", [p])).rows[0];

    expect((await replay(await bearer(other, b), dl.id)).status).toBe(404); // RLS: no la ve
    const ok = await replay(await bearer(t, a), dl.id);
    expect(ok.status).toBe(202);
    expect((await admin.query("SELECT status, attempts FROM posts WHERE id = $1", [p])).rows[0]).toEqual({ status: "scheduled", attempts: 0 });
    expect((await replay(await bearer(t, a), dl.id)).status).toBe(409); // ALREADY_REPLAYED
  });

  it("no reprocesa TOKEN_REVOKED mientras el token siga revocado", async () => {
    const mock = await startMock();
    const t = await makeTenant(admin);
    const a = await makeAmbassador(admin, t, "revoked");
    await makePost(admin, t, a);
    for (const c of await claimBatch(pool, claimOpts)) await processPost(deps(pool, mock.url, "w"), c);
    await mock.close();
    const dl = (await admin.query("SELECT id FROM dead_letters")).rows[0];
    const r = await replay(await bearer(t, a), dl.id);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("TOKEN_STILL_REVOKED");
  });
});

describe("limpieza de Idempotency-Keys", () => {
  it("borra solo las claves más antiguas que el TTL, por lotes", async () => {
    const t = await makeTenant(admin);
    await admin.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, created_at)
       SELECT $1, 'old-' || g, 'h', now() - interval '25 hours' FROM generate_series(1, 25) g`,
      [t],
    );
    await admin.query(`INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, 'fresh', 'h')`, [t]);
    expect(await purgeIdempotencyKeys(pool, 24, 10)).toBe(25);
    expect((await admin.query("SELECT key FROM idempotency_keys")).rows.map((r) => r.key)).toEqual(["fresh"]);
  });
});
