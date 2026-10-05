import type { AuthContext } from "@ploot/shared";
import { tenantTx } from "./db";
import { ApiError } from "./http";

/**
 * "¿Por qué va atrasado el Embajador X?" sin leer código: estado de pausa (429 / token),
 * throttle propio, backoff de la cabeza de cola, cola vencida, lag y últimas transiciones.
 */
export async function ambassadorStatus(auth: AuthContext, id: string) {
  return tenantTx(auth, async (c) => {
    const a = await c.query(
      `SELECT a.id, a.display_name, a.paused_until, a.pause_reason, a.next_allowed_at,
              cr.status AS token_status, cr.expires_at AS token_expires_at
       FROM ambassadors a LEFT JOIN oauth_credentials cr ON cr.ambassador_id = a.id
       WHERE a.id = $1`,
      [id],
    );
    if (a.rowCount === 0) throw new ApiError(404, "NOT_FOUND", "Embajador no encontrado");
    const amb = a.rows[0];
    const q = (
      await c.query(
        `SELECT count(*) FILTER (WHERE status = 'scheduled' AND scheduled_at <= now())::int AS due,
                count(*) FILTER (WHERE status = 'scheduled' AND scheduled_at > now())::int AS upcoming,
                count(*) FILTER (WHERE status = 'publishing')::int AS in_flight,
                count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::int AS failed_24h,
                coalesce(extract(epoch FROM now() - min(scheduled_at) FILTER (WHERE status = 'scheduled' AND scheduled_at <= now())), 0)::int AS lag_seconds
         FROM posts WHERE ambassador_id = $1`,
        [id],
      )
    ).rows[0];
    const head = (
      await c.query(
        `SELECT id, scheduled_at, run_at, attempts, last_error_code, last_error_message FROM posts
         WHERE ambassador_id = $1 AND status = 'scheduled' ORDER BY scheduled_at, id LIMIT 1`,
        [id],
      )
    ).rows[0];
    const app = (await c.query(`SELECT paused_until, tokens FROM rate_buckets WHERE key = 'app'`)).rows[0];
    const events = (
      await c.query(
        `SELECT post_id, from_status, to_status, code, detail, actor, created_at FROM post_events
         WHERE ambassador_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [id],
      )
    ).rows;

    const now = Date.now();
    const future = (t: string | null) => !!t && (t === "infinity" || Date.parse(t) > now);
    const reasons: string[] = [];
    if (amb.token_status === "revoked") reasons.push("TOKEN_REVOKED: el token OAuth está revocado; el Embajador debe reconectar su cuenta.");
    if (future(amb.paused_until) && amb.pause_reason === "RATE_LIMITED") reasons.push(`RATE_LIMITED: el proveedor devolvió 429; pausado hasta ${amb.paused_until} (Retry-After).`);
    if (future(app?.paused_until)) reasons.push(`APP_RATE_LIMITED: límite global de la app agotado hasta ${app.paused_until}.`);
    if (head?.attempts > 0 && future(head.run_at)) reasons.push(`BACKOFF: el siguiente post falló (${head.last_error_code}); reintento ${head.attempts + 1} a las ${head.run_at}.`);
    if (future(amb.next_allowed_at) && q.due > 0) reasons.push(`THROTTLE: intervalo mínimo propio entre publicaciones hasta ${amb.next_allowed_at} (anti-ráfaga).`);
    if (q.in_flight > 0) reasons.push("IN_FLIGHT: hay un post publicándose ahora mismo (máx. 1 por Embajador).");
    if (reasons.length === 0 && q.due > 0) reasons.push("QUEUED: en cola esperando turno del worker (reparto justo entre tenants / cap global).");
    if (reasons.length === 0) reasons.push("OK: al día, sin posts vencidos.");

    return {
      ambassador: { id: amb.id, display_name: amb.display_name },
      token: { status: amb.token_status ?? "missing", expires_at: amb.token_expires_at },
      pause: future(amb.paused_until) ? { reason: amb.pause_reason, until: amb.paused_until } : null,
      throttle_until: future(amb.next_allowed_at) ? amb.next_allowed_at : null,
      queue: q,
      head_of_queue: head ?? null,
      diagnosis: reasons,
      recent_events: events,
    };
  });
}

export async function listAmbassadors(auth: AuthContext) {
  return tenantTx(auth, async (c) => {
    const res = await c.query(
      `SELECT a.id, a.display_name, a.paused_until, a.pause_reason, cr.status AS token_status
       FROM ambassadors a LEFT JOIN oauth_credentials cr ON cr.ambassador_id = a.id ORDER BY a.display_name`,
    );
    return { items: res.rows };
  });
}
