/** Taxonomía de errores y tokens: 429, 5xx con backoff -> DLQ, token expirado y revocado. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimBatch } from "../worker/src/claim";
import { processPost } from "../worker/src/process";
import { adminPool, deps, makeAmbassador, makePost, makeTenant, resetDb, startMock, workerPool } from "./helpers";

const admin = adminPool();
const pool = workerPool();
afterAll(async () => {
  await admin.end();
  await pool.end();
});
beforeEach(() => resetDb(admin));

const claimOpts = { workerId: "w", max: 10, globalConcurrency: 10, leaseSeconds: 30, ambassadorMinIntervalS: 0, ambassadorJitterS: 0 };
const row = async (id: string) => (await admin.query("SELECT * FROM posts WHERE id = $1", [id])).rows[0];
async function tick(url: string) {
  const claimed = await claimBatch(pool, claimOpts);
  await Promise.all(claimed.map((p) => processPost(deps(pool, url, "w"), p)));
  return claimed;
}

describe("worker", () => {
  it("429: respeta Retry-After, no gasta intento y no adelanta la cola del Embajador", async () => {
    const mock = await startMock({ random429Rate: 1, random: () => 0.5 }); // Retry-After = 6s
    const t = await makeTenant(admin);
    const a = await makeAmbassador(admin, t);
    const head = await makePost(admin, t, a, { minutesFromNow: -2 });
    const second = await makePost(admin, t, a, { minutesFromNow: -1 });
    await tick(mock.url);
    expect(await row(head)).toMatchObject({ status: "scheduled", attempts: 0, last_error_code: "RATE_LIMITED" });
    const amb = (await admin.query("SELECT paused_until, pause_reason FROM ambassadors WHERE id = $1", [a])).rows[0];
    const pausedFor = (Date.parse(amb.paused_until) - Date.now()) / 1000;
    expect(pausedFor).toBeGreaterThan(4);
    expect(pausedFor).toBeLessThanOrEqual(6);
    expect(await claimBatch(pool, claimOpts)).toHaveLength(0); // ni la cabeza ni el segundo
    // Pasada la pausa, sale primero la cabeza, no el segundo.
    await admin.query("UPDATE ambassadors SET paused_until = now() - interval '1 second' WHERE id = $1", [a]);
    const [next] = await claimBatch(pool, claimOpts);
    expect(next.id).toBe(head);
    expect((await row(second)).status).toBe("scheduled");
    await mock.close();
  });

  it("5xx: backoff exponencial y, al 5º intento, failed + DLQ", async () => {
    const mock = await startMock({ fail5xxRate: 1 });
    const t = await makeTenant(admin);
    const a = await makeAmbassador(admin, t);
    const p = await makePost(admin, t, a);
    for (let i = 1; i <= 5; i++) {
      await admin.query("UPDATE posts SET run_at = now() WHERE id = $1 AND status = 'scheduled'", [p]);
      expect(await tick(mock.url)).toHaveLength(1);
      const r = await row(p);
      if (i < 5) {
        expect(r).toMatchObject({ status: "scheduled", attempts: i, last_error_code: "PROVIDER_5XX" });
        expect(Date.parse(r.run_at)).toBeGreaterThan(Date.now() - 1000);
      }
    }
    expect(await row(p)).toMatchObject({ status: "failed", attempts: 5, last_error_code: "MAX_ATTEMPTS_EXCEEDED" });
    expect((await admin.query("SELECT count(*)::int AS n FROM dead_letters WHERE post_id = $1", [p])).rows[0].n).toBe(1);
    await mock.close();
  });

  it("token expirado: se refresca antes de publicar", async () => {
    const mock = await startMock();
    const t = await makeTenant(admin);
    const a = await makeAmbassador(admin, t, "expired");
    const p = await makePost(admin, t, a);
    await tick(mock.url);
    expect((await row(p)).status).toBe("published");
    const cred = (await admin.query("SELECT expires_at, status FROM oauth_credentials WHERE ambassador_id = $1", [a])).rows[0];
    expect(Date.parse(cred.expires_at)).toBeGreaterThan(Date.now());
    await mock.close();
  });

  it("token revocado: failed TOKEN_REVOKED sin quemar reintentos y el Embajador queda bloqueado", async () => {
    const mock = await startMock();
    const t = await makeTenant(admin);
    const a = await makeAmbassador(admin, t, "revoked");
    const p1 = await makePost(admin, t, a, { minutesFromNow: -2 });
    const p2 = await makePost(admin, t, a, { minutesFromNow: -1 });
    await tick(mock.url);
    expect(await row(p1)).toMatchObject({ status: "failed", attempts: 0, last_error_code: "TOKEN_REVOKED" });
    expect((await admin.query("SELECT status FROM oauth_credentials WHERE ambassador_id = $1", [a])).rows[0].status).toBe("revoked");
    expect(await claimBatch(pool, claimOpts)).toHaveLength(0);
    expect((await row(p2)).status).toBe("scheduled");
    expect(mock.stats.publishedTotal).toBe(0);
    await mock.close();
  });

  it("reparto justo: un tenant ruidoso no acapara el lote", async () => {
    const noisy = await makeTenant(admin, "noisy");
    const quiet = await makeTenant(admin, "quiet");
    for (let i = 0; i < 8; i++) await makePost(admin, noisy, await makeAmbassador(admin, noisy), { minutesFromNow: -60 });
    const quietAmb = await makeAmbassador(admin, quiet);
    const quietPost = await makePost(admin, quiet, quietAmb, { minutesFromNow: -1 }); // más reciente
    const claimed = await claimBatch(pool, { ...claimOpts, max: 2 });
    expect(claimed.map((c) => c.id)).toContain(quietPost);
  });

  it("cap global: nunca más de globalConcurrency en vuelo", async () => {
    const t = await makeTenant(admin);
    for (let i = 0; i < 10; i++) await makePost(admin, t, await makeAmbassador(admin, t));
    const first = await claimBatch(pool, { ...claimOpts, globalConcurrency: 3 });
    const second = await claimBatch(pool, { ...claimOpts, globalConcurrency: 3 });
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
  });
});
