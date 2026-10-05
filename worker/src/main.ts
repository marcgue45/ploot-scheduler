import { hostname } from "node:os";
import { createLogger, createPool } from "@ploot/shared";
import { claimBatch, reapExpiredLeases } from "./claim";
import { loadConfig } from "./config";
import { processPost, type WorkerDeps } from "./process";
import { ProviderClient } from "./provider";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bucle continuo: reclama mientras haya hueco local; procesa en paralelo sin esperar al lote entero. */
export async function runWorker(deps: WorkerDeps, isRunning: () => boolean): Promise<void> {
  const inflight = new Set<Promise<void>>();
  const c = deps.config;
  while (isRunning()) {
    let claimedCount = 0;
    const free = c.claimBatch - inflight.size;
    if (free > 0) {
      try {
        const claimed = await claimBatch(deps.pool, {
          workerId: deps.workerId,
          max: free,
          globalConcurrency: c.globalConcurrency,
          leaseSeconds: c.leaseSeconds,
          ambassadorMinIntervalS: c.ambassadorMinIntervalS,
          ambassadorJitterS: c.ambassadorJitterS,
        });
        claimedCount = claimed.length;
        for (const post of claimed) {
          const p: Promise<void> = processPost(deps, post).finally(() => inflight.delete(p));
          inflight.add(p);
        }
      } catch (err) {
        // BD caída => no publicamos (fail closed). Retrasar es recuperable; un ban no.
        deps.log.error({ err }, "claim failed; backing off");
        await sleep(c.pollIntervalMs * 5);
      }
    }
    if (claimedCount === 0) await sleep(c.pollIntervalMs);
  }
  await Promise.allSettled(inflight);
}

async function logQueueStats(deps: WorkerDeps) {
  const { rows } = await deps.pool.query(`
    SELECT count(*) FILTER (WHERE status = 'scheduled' AND run_at <= now())::int AS due,
           count(*) FILTER (WHERE status = 'publishing')::int AS inflight,
           coalesce(extract(epoch FROM now() - min(scheduled_at) FILTER (WHERE status = 'scheduled' AND run_at <= now())), 0)::int AS oldest_due_lag_s,
           (SELECT count(*)::int FROM ambassadors WHERE paused_until > now()) AS paused_ambassadors,
           (SELECT paused_until > now() FROM rate_buckets WHERE key = 'app') AS app_paused
    FROM posts WHERE status IN ('scheduled', 'publishing')`);
  deps.log.info({ metric: "queue_stats", ...rows[0] }, "queue stats");
}

async function main() {
  const config = loadConfig();
  const workerId = `${hostname()}-${process.pid}`;
  const log = createLogger("worker").child({ worker_id: workerId });
  const url = process.env.WORKER_DATABASE_URL;
  if (!url) throw new Error("WORKER_DATABASE_URL no configurada");
  // Proceso de larga vida: pool pequeño y fijo, conexión directa (sin pooler transaccional).
  const pool = createPool(url, { max: Number(process.env.WORKER_DB_POOL_MAX ?? 5), name: "ploot-worker" });
  const deps: WorkerDeps = { pool, provider: new ProviderClient(config.providerUrl, config.httpTimeoutMs), config, workerId, log };

  let running = true;
  const stop = (sig: string) => {
    log.info({ sig }, "draining: stop claiming, finishing in-flight posts");
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const reaper = setInterval(() => {
    reapExpiredLeases(pool, config.maxAttempts, workerId)
      .then((n) => n > 0 && log.warn({ reaped: n }, "requeued posts with expired leases"))
      .catch((err) => log.error({ err }, "reaper failed"));
  }, 5_000);
  const stats = setInterval(() => logQueueStats(deps).catch((err) => log.error({ err }, "stats failed")), 15_000);

  log.info({ config: { ...config } }, "worker started");
  await runWorker(deps, () => running);
  clearInterval(reaper);
  clearInterval(stats);
  await pool.end();
  log.info("worker stopped cleanly");
}

if (process.argv[1]?.endsWith("main.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
