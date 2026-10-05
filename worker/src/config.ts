export interface WorkerConfig {
  providerUrl: string;
  claimBatch: number;
  /** Cap global de publicaciones en vuelo (todas las réplicas, contado en BD). */
  globalConcurrency: number;
  /** Throttle propio por Embajador: intervalo mínimo + jitter entre publicaciones. */
  ambassadorMinIntervalS: number;
  ambassadorJitterS: number;
  leaseSeconds: number;
  httpTimeoutMs: number;
  maxAttempts: number;
  backoffBaseS: number;
  backoffCapS: number;
  pollIntervalMs: number;
  /** Refrescar el token si caduca en menos de esto. */
  refreshSkewS: number;
}

const num = (name: string, def: number) => Number(process.env[name] ?? def);

export function loadConfig(): WorkerConfig {
  return {
    providerUrl: process.env.PROVIDER_URL ?? "http://localhost:4000",
    claimBatch: num("WORKER_CLAIM_BATCH", 10),
    globalConcurrency: num("WORKER_GLOBAL_CONCURRENCY", 8),
    ambassadorMinIntervalS: num("AMBASSADOR_MIN_INTERVAL_S", 6),
    ambassadorJitterS: num("AMBASSADOR_JITTER_S", 4),
    leaseSeconds: num("WORKER_LEASE_SECONDS", 60),
    httpTimeoutMs: num("PROVIDER_TIMEOUT_MS", 10_000),
    maxAttempts: num("WORKER_MAX_ATTEMPTS", 5),
    backoffBaseS: num("BACKOFF_BASE_S", 2),
    backoffCapS: num("BACKOFF_CAP_S", 300),
    pollIntervalMs: num("WORKER_POLL_MS", 1000),
    refreshSkewS: num("TOKEN_REFRESH_SKEW_S", 60),
  };
}

/** Backoff exponencial con "equal jitter": crece siempre, pero desincroniza réplicas (no retry-storm). */
export function backoffSeconds(attempt: number, baseS: number, capS: number, rnd = Math.random): number {
  const exp = Math.min(capS, baseS * 2 ** Math.max(0, attempt - 1));
  return exp / 2 + rnd() * (exp / 2);
}
