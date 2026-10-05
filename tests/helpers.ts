import type { AddressInfo } from "node:net";
import { createLogger, createPool, encryptToken, signJwt, tokenAad, type Pool } from "../shared/src/index";
import { createMockServer, type MockOptions } from "../mock/src/server";
import type { WorkerConfig } from "../worker/src/config";
import type { WorkerDeps } from "../worker/src/process";
import { ProviderClient } from "../worker/src/provider";

export const adminPool = () => createPool(process.env.TEST_ADMIN_URL!, { max: 5 });
export const appPool = () => createPool(process.env.DATABASE_URL!, { max: 5 });
export const workerPool = () => createPool(process.env.WORKER_DATABASE_URL!, { max: 4 });

export async function resetDb(admin: Pool) {
  await admin.query("TRUNCATE tenants, idempotency_keys RESTART IDENTITY CASCADE");
  await admin.query("UPDATE rate_buckets SET tokens = 1000, capacity = 1000, refill_per_sec = 1000, paused_until = NULL, updated_at = now()");
}

export async function makeTenant(admin: Pool, name = "t"): Promise<string> {
  return (await admin.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
}

export async function makeAmbassador(admin: Pool, tenantId: string, token: "valid" | "expired" | "revoked" = "valid"): Promise<string> {
  const id = (await admin.query("INSERT INTO ambassadors (tenant_id, display_name) VALUES ($1, 'amb') RETURNING id", [tenantId])).rows[0].id;
  const exp = Math.floor(Date.now() / 1000) + (token === "valid" ? 3600 : -3600);
  const aad = tokenAad(tenantId, id);
  await admin.query(
    `INSERT INTO oauth_credentials (ambassador_id, tenant_id, access_token_ct, refresh_token_ct, expires_at) VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [id, tenantId, encryptToken(`at:${id}:${exp}`, aad), encryptToken(`rt:${id}:${token === "revoked" ? "revoked" : "ok"}`, aad), exp],
  );
  return id;
}

export async function makePost(admin: Pool, tenantId: string, ambassadorId: string, opts: { status?: string; minutesFromNow?: number; content?: string } = {}): Promise<string> {
  const at = new Date(Date.now() + (opts.minutesFromNow ?? -1) * 60_000);
  return (
    await admin.query(
      `INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [tenantId, ambassadorId, opts.content ?? "hola", opts.status ?? "scheduled", at],
    )
  ).rows[0].id;
}

export async function startMock(opts: Partial<MockOptions> = {}) {
  const { server, stats } = createMockServer({
    latencyMaxMs: 20, fail5xxRate: 0, random429Rate: 0, userMinIntervalMs: 0, appMaxPerMinute: 1_000_000, accessTtlSeconds: 3600, ...opts,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, stats, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function testConfig(providerUrl: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    providerUrl, claimBatch: 5, globalConcurrency: 100, ambassadorMinIntervalS: 0, ambassadorJitterS: 0, leaseSeconds: 30,
    httpTimeoutMs: 5000, maxAttempts: 5, backoffBaseS: 0.01, backoffCapS: 0.05, pollIntervalMs: 20, refreshSkewS: 60, ...overrides,
  };
}

export function deps(pool: Pool, providerUrl: string, workerId: string, overrides: Partial<WorkerConfig> = {}, hooks?: WorkerDeps["hooks"]): WorkerDeps {
  const config = testConfig(providerUrl, overrides);
  return { pool, provider: new ProviderClient(providerUrl, config.httpTimeoutMs), config, workerId, log: createLogger("test-worker"), hooks };
}

export const bearer = async (tenantId: string, profileId: string) => `Bearer ${await signJwt({ tenantId, profileId })}`;

export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 20_000, everyMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error("waitFor timeout");
}
