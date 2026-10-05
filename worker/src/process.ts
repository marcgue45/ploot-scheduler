import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken, ErrorCode, tokenAad, withTx, type Logger, type Pool } from "@ploot/shared";
import { insertEvent, type ClaimedPost } from "./claim";
import { backoffSeconds, type WorkerConfig } from "./config";
import type { ProviderClient, PublishResult } from "./provider";

export interface WorkerDeps {
  pool: Pool;
  provider: ProviderClient;
  config: WorkerConfig;
  workerId: string;
  log: Logger;
  /** Solo tests: simular un crash justo después de que el proveedor publique. */
  hooks?: { afterProviderCall?: (post: ClaimedPost, result: PublishResult) => Promise<void> | void };
}

type TokenOutcome = { kind: "ok"; accessToken: string } | { kind: "finalized" };

const CLEAR_CLAIM = "claim_id = NULL, locked_by = NULL, lease_until = NULL, updated_at = now()";

function traceparent(traceId: string | null): string | undefined {
  return traceId ? `00-${traceId}-${randomBytes(8).toString("hex")}-01` : undefined;
}

/** Publica un post ya reclamado. Nunca lanza: todo resultado acaba en una transición tipada. */
export async function processPost(deps: WorkerDeps, post: ClaimedPost): Promise<void> {
  const log = deps.log.child({
    post_id: post.id,
    tenant_id: post.tenant_id,
    ambassador_id: post.ambassador_id,
    claim_id: post.claim_id,
    trace_id: post.trace_id,
    attempt: post.attempts + 1,
  });
  const started = Date.now();
  try {
    let token = await getAccessToken(deps, post, log, false);
    if (token.kind === "finalized") return;

    let result = await deps.provider.publish(token.accessToken, post.id, post.content, traceparent(post.trace_id));
    if (result.kind === "unauthorized") {
      // Nuestro reloj decía "válido" pero el proveedor no: un refresh forzado y un único reintento.
      log.warn({ reason: result.reason }, "provider rejected token, forcing refresh");
      token = await getAccessToken(deps, post, log, true);
      if (token.kind === "finalized") return;
      result = await deps.provider.publish(token.accessToken, post.id, post.content, traceparent(post.trace_id));
      if (result.kind === "unauthorized") {
        await markRevoked(deps, post, `proveedor rechaza el token tras refresh: ${result.reason}`, log);
        return;
      }
    }
    await deps.hooks?.afterProviderCall?.(post, result);
    await applyPublishResult(deps, post, result, log, Date.now() - started);
  } catch (err) {
    // Sin transición: el lease caducará y el reaper lo reintentará con el mismo Idempotency-Key.
    log.error({ err }, "unexpected error processing post; lease will expire");
  }
}

async function getAccessToken(deps: WorkerDeps, post: ClaimedPost, log: Logger, force: boolean): Promise<TokenOutcome> {
  const { rows } = await deps.pool.query(
    `SELECT access_token_ct, refresh_token_ct, expires_at, status FROM oauth_credentials WHERE ambassador_id = $1`,
    [post.ambassador_id],
  );
  const cred = rows[0];
  if (!cred || cred.status === "revoked") {
    await markRevoked(deps, post, cred ? "credencial marcada como revocada" : "Embajador sin credencial", log);
    return { kind: "finalized" };
  }
  const aad = tokenAad(post.tenant_id, post.ambassador_id);
  const expiresInMs = Date.parse(cred.expires_at) - Date.now();
  if (!force && expiresInMs > deps.config.refreshSkewS * 1000) {
    return { kind: "ok", accessToken: decryptToken(cred.access_token_ct, aad) };
  }

  log.info({ expires_in_ms: expiresInMs, forced: force }, "refreshing access token");
  const r = await deps.provider.refresh(decryptToken(cred.refresh_token_ct, aad));
  switch (r.kind) {
    case "ok":
      // Sin carrera entre réplicas: el índice único garantiza 1 post en vuelo por Embajador.
      await deps.pool.query(
        `UPDATE oauth_credentials
         SET access_token_ct = $2, refresh_token_ct = $3, expires_at = now() + make_interval(secs => $4), status = 'valid', updated_at = now()
         WHERE ambassador_id = $1`,
        [post.ambassador_id, encryptToken(r.accessToken, aad), encryptToken(r.refreshToken, aad), r.expiresIn],
      );
      log.info("access token refreshed");
      return { kind: "ok", accessToken: r.accessToken };
    case "revoked":
      await markRevoked(deps, post, "refresh rechazado (invalid_grant)", log);
      return { kind: "finalized" };
    case "rate_limited":
      await requeueRateLimited(deps, post, r.retryAfterS, r.scope, log);
      return { kind: "finalized" };
    case "server_error":
    case "timeout":
      await retryLater(deps, post, ErrorCode.TOKEN_REFRESH_UNAVAILABLE, r.kind === "timeout" ? "timeout en refresh" : `refresh HTTP ${r.status}`, log);
      return { kind: "finalized" };
  }
}

async function applyPublishResult(deps: WorkerDeps, post: ClaimedPost, result: PublishResult, log: Logger, latencyMs: number) {
  switch (result.kind) {
    case "ok":
      return markPublished(deps, post, result.externalId, log, latencyMs);
    case "rate_limited":
      return requeueRateLimited(deps, post, result.retryAfterS, result.scope, log);
    case "server_error":
      return retryLater(deps, post, ErrorCode.PROVIDER_5XX, `HTTP ${result.status}`, log);
    case "timeout":
      return retryLater(deps, post, ErrorCode.PROVIDER_TIMEOUT, `sin respuesta en ${deps.config.httpTimeoutMs} ms`, log);
    case "rejected":
      return failPermanently(deps, post, ErrorCode.PROVIDER_REJECTED, `HTTP ${result.status}: ${result.reason}`, log);
    case "unauthorized":
      return markRevoked(deps, post, result.reason, log);
  }
}

/** Todas las transiciones van condicionadas por claim_id: si perdimos el lease, no pisamos a nadie. */
async function finalize(
  deps: WorkerDeps,
  post: ClaimedPost,
  log: Logger,
  setSql: string,
  params: unknown[],
  event: { to: string; code?: string | null; detail?: string | null },
  extra?: (c: import("@ploot/shared").DbClient) => Promise<void>,
): Promise<boolean> {
  return withTx(deps.pool, async (c) => {
    const res = await c.query(
      `UPDATE posts SET ${setSql}, ${CLEAR_CLAIM} WHERE id = $1 AND claim_id = $2 AND status = 'publishing'`,
      [post.id, post.claim_id, ...params],
    );
    if (res.rowCount === 0) {
      log.warn({ intended: event.to }, "lost lease before finalizing; another worker owns this post now");
      return false;
    }
    await insertEvent(c, { postId: post.id, tenantId: post.tenant_id, ambassadorId: post.ambassador_id, from: "publishing", to: event.to, code: event.code, detail: event.detail, actor: deps.workerId });
    if (extra) await extra(c);
    return true;
  });
}

async function markPublished(deps: WorkerDeps, post: ClaimedPost, externalId: string, log: Logger, latencyMs: number) {
  const ok = await finalize(
    deps, post, log,
    `status = 'published', external_id = $3, published_at = now(), last_error_code = NULL, last_error_message = NULL`,
    [externalId],
    { to: "published", detail: externalId },
  );
  if (ok) log.info({ external_id: externalId, latency_ms: latencyMs, outcome: "published" }, "post published");
}

/** 429: no consume reintento ni avanza la cabeza de cola; pausa al Embajador (o a la app) Retry-After. */
async function requeueRateLimited(deps: WorkerDeps, post: ClaimedPost, retryAfterS: number, scope: "user" | "app", log: Logger) {
  const code = scope === "app" ? ErrorCode.APP_RATE_LIMITED : ErrorCode.RATE_LIMITED;
  const detail = `Retry-After ${retryAfterS}s (scope ${scope})`;
  await finalize(deps, post, log, `status = 'scheduled', last_error_code = $3, last_error_message = $4`, [code, detail], { to: "scheduled", code, detail }, async (c) => {
    if (scope === "app") {
      await c.query(
        `UPDATE rate_buckets SET tokens = 0, updated_at = now(), paused_until = greatest(coalesce(paused_until, now()), now() + make_interval(secs => $1)) WHERE key = 'app'`,
        [retryAfterS],
      );
    } else {
      await c.query(
        `UPDATE ambassadors SET paused_until = now() + make_interval(secs => $2), pause_reason = 'RATE_LIMITED'
         WHERE id = $1 AND (paused_until IS NULL OR paused_until < now() + make_interval(secs => $2))`,
        [post.ambassador_id, retryAfterS],
      );
    }
  });
  log.warn({ retry_after_s: retryAfterS, scope, outcome: "rate_limited" }, "provider rate limited; paused");
}

/** Transitorio: backoff exponencial con jitter. Al 5º intento -> failed + DLQ. */
async function retryLater(deps: WorkerDeps, post: ClaimedPost, code: ErrorCode, message: string, log: Logger) {
  const attempts = post.attempts + 1;
  if (attempts >= deps.config.maxAttempts) {
    await failPermanently(deps, post, ErrorCode.MAX_ATTEMPTS_EXCEEDED, `${code}: ${message} (${attempts} intentos)`, log, attempts);
    return;
  }
  const delay = backoffSeconds(attempts, deps.config.backoffBaseS, deps.config.backoffCapS);
  await finalize(
    deps, post, log,
    `status = 'scheduled', attempts = $3, run_at = now() + make_interval(secs => $4), last_error_code = $5, last_error_message = $6`,
    [attempts, delay, code, message],
    { to: "scheduled", code, detail: `${message}; reintento en ${delay.toFixed(1)}s` },
  );
  log.warn({ code, attempts, backoff_s: Number(delay.toFixed(1)), outcome: "retry_scheduled" }, "transient failure, backing off");
}

async function failPermanently(deps: WorkerDeps, post: ClaimedPost, code: ErrorCode, message: string, log: Logger, attempts = post.attempts) {
  await finalize(deps, post, log, `status = 'failed', attempts = $3, last_error_code = $4, last_error_message = $5`, [attempts, code, message], { to: "failed", code, detail: message }, async (c) => {
    await c.query(
      `INSERT INTO dead_letters (post_id, tenant_id, ambassador_id, error_code, error_message, attempts) VALUES ($1, $2, $3, $4, $5, $6)`,
      [post.id, post.tenant_id, post.ambassador_id, code, message, attempts],
    );
  });
  log.error({ code, attempts, outcome: "failed" }, "post failed permanently");
}

/**
 * Token irrecuperable: el post falla con TOKEN_REVOKED SIN quemar reintentos, la credencial queda
 * revocada y el Embajador en pausa indefinida: sus demás posts esperan a que reconecte en vez de
 * fallar uno a uno contra el proveedor.
 */
async function markRevoked(deps: WorkerDeps, post: ClaimedPost, reason: string, log: Logger) {
  await failPermanently(deps, post, ErrorCode.TOKEN_REVOKED, reason, log);
  await withTx(deps.pool, async (c) => {
    await c.query(`UPDATE oauth_credentials SET status = 'revoked', updated_at = now() WHERE ambassador_id = $1`, [post.ambassador_id]);
    await c.query(`UPDATE ambassadors SET paused_until = 'infinity', pause_reason = 'TOKEN_REVOKED' WHERE id = $1`, [post.ambassador_id]);
  });
}
