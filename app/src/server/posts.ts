import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { resolveLocalTime, ScheduleError, type AuthContext, type DbClient } from "@ploot/shared";
import { tenantTx } from "./db";
import { ApiError } from "./http";

// Ninguna query de este fichero filtra por tenant_id: lo hace RLS con el tenant de la transacción.

const MAX_AHEAD_MS = 90 * 86_400_000;
const PAST_TOLERANCE_MS = 5 * 60_000;

const POST_COLUMNS = `
  p.id, p.ambassador_id, a.display_name AS ambassador_name, p.content, p.status, p.scheduled_at, p.timezone,
  p.run_at, p.attempts, p.external_id, p.last_error_code, p.last_error_message, p.published_at,
  p.created_at, p.updated_at, p.trace_id, a.paused_until, a.pause_reason,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_ts`;

export type Waiting =
  | { reason: "SCHEDULED"; until: string }
  | { reason: "BACKOFF"; until: string; after_error: string | null }
  | { reason: "RATE_LIMITED" | "TOKEN_REVOKED" | string; until: string }
  | { reason: "QUEUED" };

function waitingFor(r: any): Waiting | null {
  if (r.status !== "scheduled") return null;
  const now = Date.now();
  if (r.paused_until && (r.paused_until === "infinity" || Date.parse(r.paused_until) > now)) {
    return { reason: r.pause_reason ?? "PAUSED", until: r.paused_until };
  }
  if (r.attempts > 0 && Date.parse(r.run_at) > now) return { reason: "BACKOFF", until: r.run_at, after_error: r.last_error_code };
  if (Date.parse(r.scheduled_at) > now) return { reason: "SCHEDULED", until: r.scheduled_at };
  return { reason: "QUEUED" };
}

function toDto(r: any) {
  return {
    id: r.id,
    ambassador_id: r.ambassador_id,
    ambassador_name: r.ambassador_name,
    content: r.content,
    status: r.status,
    scheduled_at: r.scheduled_at,
    timezone: r.timezone,
    attempts: r.attempts,
    next_attempt_at: r.status === "scheduled" ? r.run_at : null,
    external_id: r.external_id,
    error: r.last_error_code ? { code: r.last_error_code, message: r.last_error_message } : null,
    waiting: waitingFor(r),
    published_at: r.published_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    trace_id: r.trace_id,
  };
}
export type PostDto = ReturnType<typeof toDto>;

async function fetchPost(c: DbClient, id: string, lock = false) {
  const res = await c.query(
    `SELECT ${POST_COLUMNS} FROM posts p JOIN ambassadors a ON a.id = p.ambassador_id WHERE p.id = $1 ${lock ? "FOR UPDATE OF p" : ""}`,
    [id],
  );
  if (res.rowCount === 0) throw new ApiError(404, "NOT_FOUND", "post no encontrado");
  return res.rows[0];
}

async function event(c: DbClient, row: { id: string; ambassador_id: string }, from: string | null, to: string, actor: string, code?: string) {
  await c.query(
    `INSERT INTO post_events (post_id, ambassador_id, from_status, to_status, code, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, row.ambassador_id, from, to, code ?? null, actor],
  );
}

// ---------- validación ----------

const scheduleFields = {
  scheduled_at: z.iso.datetime({ offset: true }).optional(),
  local_time: z.string().optional(),
  timezone: z.string().default("Europe/Madrid"),
};
const CreateSchema = z.object({
  content: z.string().trim().min(1).max(3000),
  status: z.enum(["draft", "scheduled"]).default("draft"),
  ambassador_id: z.uuid().optional(),
  ...scheduleFields,
});
const PatchSchema = z
  .object({
    content: z.string().trim().min(1).max(3000).optional(),
    status: z.enum(["draft", "scheduled"]).optional(),
    ...scheduleFields,
    timezone: z.string().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "body vacío");

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(422, "VALIDATION_ERROR", "Body inválido", z.flattenError(r.error as z.ZodError<any>).fieldErrors);
  return r.data;
}

/** Instante UTC a partir de scheduled_at (ISO con offset) o de local_time + timezone (DST explícito). */
function resolveSchedule(v: { scheduled_at?: string; local_time?: string; timezone?: string }): Date | null {
  let at: Date | null = null;
  if (v.scheduled_at) at = new Date(v.scheduled_at);
  else if (v.local_time) {
    try {
      at = resolveLocalTime(v.local_time, v.timezone ?? "Europe/Madrid");
    } catch (e) {
      if (e instanceof ScheduleError) throw new ApiError(422, e.code, e.message);
      throw e;
    }
  }
  if (at) {
    const now = Date.now();
    if (at.getTime() < now - PAST_TOLERANCE_MS) throw new ApiError(422, "SCHEDULE_IN_PAST", "La fecha programada ya pasó");
    if (at.getTime() > now + MAX_AHEAD_MS) throw new ApiError(422, "SCHEDULE_TOO_FAR", "Máximo 90 días de antelación");
  }
  return at;
}

const newTraceId = (req?: Request) => {
  const tp = req?.headers.get("traceparent")?.split("-");
  return tp && tp.length === 4 && /^[0-9a-f]{32}$/.test(tp[1]) ? tp[1] : randomBytes(16).toString("hex");
};

// ---------- operaciones ----------

export async function createPost(auth: AuthContext, body: unknown, req?: Request): Promise<PostDto> {
  const v = parse(CreateSchema, body);
  const at = resolveSchedule(v);
  if (v.status === "scheduled" && !at) throw new ApiError(422, "SCHEDULE_REQUIRED", "status=scheduled requiere scheduled_at o local_time");
  return tenantTx(auth, async (c) => {
    try {
      // tenant_id lo pone el DEFAULT app_current_tenant(); un ambassador de otro tenant rompe la FK compuesta.
      const res = await c.query(
        `INSERT INTO posts (ambassador_id, content, status, scheduled_at, timezone, run_at, trace_id)
         VALUES ($1, $2, $3, $4, $5, $4, $6) RETURNING id, ambassador_id`,
        [v.ambassador_id ?? auth.profileId, v.content, v.status, at, v.timezone, newTraceId(req)],
      );
      await event(c, res.rows[0], null, v.status, `profile:${auth.profileId}`);
      return toDto(await fetchPost(c, res.rows[0].id));
    } catch (e: any) {
      if (e?.code === "23503") throw new ApiError(404, "AMBASSADOR_NOT_FOUND", "Embajador no encontrado en tu tenant");
      throw e;
    }
  });
}

const LOCKED_STATES: Record<string, string> = {
  published: "POST_ALREADY_PUBLISHED",
  publishing: "POST_PUBLISHING",
  cancelled: "POST_CANCELLED",
};

export async function updatePost(auth: AuthContext, id: string, body: unknown): Promise<PostDto> {
  const v = parse(PatchSchema, body);
  return tenantTx(auth, async (c) => {
    // FOR UPDATE: si el worker intenta reclamarlo a la vez, su SKIP LOCKED lo salta.
    const cur = await fetchPost(c, id, true);
    if (LOCKED_STATES[cur.status]) throw new ApiError(409, LOCKED_STATES[cur.status], `No editable en estado ${cur.status}`);
    const at = v.scheduled_at || v.local_time ? resolveSchedule({ ...v, timezone: v.timezone ?? cur.timezone }) : null;
    const nextStatus = v.status ?? (cur.status === "failed" ? "draft" : cur.status);
    const scheduledAt = at ?? (cur.scheduled_at ? new Date(cur.scheduled_at) : null);
    if (nextStatus === "scheduled" && !scheduledAt) throw new ApiError(422, "SCHEDULE_REQUIRED", "status=scheduled requiere fecha");
    if (nextStatus === "scheduled" && !at && scheduledAt!.getTime() < Date.now() - PAST_TOLERANCE_MS && cur.status !== "scheduled") {
      throw new ApiError(422, "SCHEDULE_IN_PAST", "La fecha programada ya pasó; envía una nueva");
    }
    await c.query(
      `UPDATE posts SET content = coalesce($2, content), status = $3, scheduled_at = $4, run_at = $4,
              timezone = coalesce($5, timezone), attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
              last_error_code = CASE WHEN status = 'failed' THEN NULL ELSE last_error_code END,
              last_error_message = CASE WHEN status = 'failed' THEN NULL ELSE last_error_message END,
              updated_at = now()
       WHERE id = $1`,
      [id, v.content ?? null, nextStatus, scheduledAt, v.timezone ?? null],
    );
    if (nextStatus !== cur.status) await event(c, cur, cur.status, nextStatus, `profile:${auth.profileId}`);
    return toDto(await fetchPost(c, id));
  });
}

export async function cancelPost(auth: AuthContext, id: string): Promise<PostDto> {
  return tenantTx(auth, async (c) => {
    const cur = await fetchPost(c, id, true);
    if (cur.status === "cancelled") return toDto(cur); // idempotente
    if (cur.status === "published" || cur.status === "publishing") {
      throw new ApiError(409, LOCKED_STATES[cur.status], `No se puede cancelar en estado ${cur.status}`);
    }
    await c.query(`UPDATE posts SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
    await event(c, cur, cur.status, "cancelled", `profile:${auth.profileId}`);
    return toDto(await fetchPost(c, id));
  });
}

/**
 * Publicación inmediata, idempotente por (tenant, Idempotency-Key). Asíncrona (202): encola con
 * scheduled_at = now() y el worker la publica respetando el gobernador de rate limit.
 * La clave se inserta en la MISMA transacción que el cambio: una petición concurrente con la misma
 * clave se bloquea en el índice único hasta el commit y luego reproduce la respuesta guardada.
 */
export async function publishNow(auth: AuthContext, id: string, idempotencyKey: string | null): Promise<{ status: number; body: unknown; replayed: boolean }> {
  if (!idempotencyKey || idempotencyKey.length > 255) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key obligatorio (1-255 caracteres)");
  }
  const requestHash = createHash("sha256").update(`POST /posts/${id}/publish`).digest("hex");
  return tenantTx(auth, async (c) => {
    const inserted = await c.query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
      [idempotencyKey, requestHash],
    );
    if (inserted.rowCount === 0) {
      const prev = (await c.query(`SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1`, [idempotencyKey])).rows[0];
      if (prev.request_hash !== requestHash) {
        throw new ApiError(422, "IDEMPOTENCY_KEY_REUSED", "Esta Idempotency-Key ya se usó con otra petición");
      }
      return { status: prev.response_status, body: prev.response_body, replayed: true };
    }

    let status: number;
    let body: unknown;
    const cur = await fetchPost(c, id, true);
    if (cur.status === "published" || cur.status === "publishing" || cur.status === "cancelled") {
      status = 409;
      body = { error: { code: LOCKED_STATES[cur.status], message: `No se puede publicar en estado ${cur.status}` } };
    } else {
      await c.query(
        `UPDATE posts SET status = 'scheduled', scheduled_at = now(), run_at = now(), attempts = 0,
                last_error_code = NULL, last_error_message = NULL, updated_at = now()
         WHERE id = $1`,
        [id],
      );
      await event(c, cur, cur.status, "scheduled", `profile:${auth.profileId}`, "PUBLISH_NOW");
      status = 202;
      body = toDto(await fetchPost(c, id));
    }
    await c.query(`UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1`, [idempotencyKey, status, JSON.stringify(body)]);
    return { status, body, replayed: false };
  });
}

const STATUSES = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"] as const;

export async function listPosts(auth: AuthContext, params: URLSearchParams) {
  const status = params.get("status");
  if (status && !STATUSES.includes(status as any)) throw new ApiError(422, "VALIDATION_ERROR", `status debe ser uno de ${STATUSES.join(", ")}`);
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 20) || 20));
  let cursor: [string, string] | null = null;
  const raw = params.get("cursor");
  if (raw) {
    try {
      cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
    } catch {
      throw new ApiError(422, "INVALID_CURSOR", "cursor inválido");
    }
  }
  return tenantTx(auth, async (c) => {
    // Keyset pagination sobre (created_at, id): estable y O(limit) aunque el tenant tenga 5M filas.
    const res = await c.query(
      `SELECT ${POST_COLUMNS} FROM posts p JOIN ambassadors a ON a.id = p.ambassador_id
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($2::timestamp IS NULL OR (p.created_at, p.id) < ($2::timestamp AT TIME ZONE 'UTC', $3::uuid))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $4`,
      [status, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
    );
    const rows = res.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toDto),
      next_cursor: res.rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_ts, last.id])).toString("base64url") : null,
    };
  });
}

export async function getPost(auth: AuthContext, id: string): Promise<PostDto> {
  return tenantTx(auth, async (c) => toDto(await fetchPost(c, id)));
}
