import { withTx, type DbClient, type Pool } from "@ploot/shared";

export interface ClaimedPost {
  id: string;
  tenant_id: string;
  ambassador_id: string;
  content: string;
  claim_id: string;
  attempts: number;
  trace_id: string | null;
}

export interface ClaimOptions {
  workerId: string;
  max: number;
  globalConcurrency: number;
  leaseSeconds: number;
  ambassadorMinIntervalS: number;
  ambassadorJitterS: number;
}

export async function insertEvent(
  c: DbClient,
  e: { postId: string; tenantId: string; ambassadorId: string; from: string | null; to: string; code?: string | null; detail?: string | null; actor: string },
) {
  await c.query(
    `INSERT INTO post_events (post_id, tenant_id, ambassador_id, from_status, to_status, code, detail, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.postId, e.tenantId, e.ambassadorId, e.from, e.to, e.code ?? null, e.detail ?? null, e.actor],
  );
}

/**
 * Candidatos justos: la CABEZA de cola de cada Embajador elegible (su post 'scheduled' más antiguo),
 * repartida en round-robin entre tenants (rn = posición dentro de su tenant). Un tenant con 50
 * Embajadores no puede llevarse el lote entero mientras otros tenants tengan trabajo.
 * Un Embajador no es elegible si: está pausado (429 / token revocado), su throttle propio no ha
 * vencido, ya tiene un post en vuelo, o su cabeza está en backoff (no se adelanta la cola).
 */
export const CANDIDATES_SQL = `
WITH due_ambassadors AS (
  SELECT DISTINCT ambassador_id
  FROM posts
  WHERE status = 'scheduled' AND run_at <= now()
),
heads AS (
  SELECT a.tenant_id, a.id AS ambassador_id, h.id AS post_id, h.scheduled_at
  FROM due_ambassadors d
  JOIN ambassadors a ON a.id = d.ambassador_id
  CROSS JOIN LATERAL (
    SELECT p.id, p.run_at, p.scheduled_at
    FROM posts p
    WHERE p.ambassador_id = d.ambassador_id AND p.status = 'scheduled'
    ORDER BY p.scheduled_at, p.id
    LIMIT 1
  ) h
  WHERE h.run_at <= now()
    AND (a.paused_until IS NULL OR a.paused_until <= now())
    AND a.next_allowed_at <= now()
    AND NOT EXISTS (SELECT 1 FROM posts x WHERE x.ambassador_id = a.id AND x.status = 'publishing')
)
SELECT post_id
FROM (SELECT *, row_number() OVER (PARTITION BY tenant_id ORDER BY scheduled_at) AS rn FROM heads) ranked
ORDER BY rn, scheduled_at
LIMIT $1`;

/**
 * Claim en una transacción corta:
 *  1. Bloquea la fila del bucket de app con SKIP LOCKED: si otra réplica está reclamando, salimos
 *     (sin esperar). Así el cap global y el token bucket son exactos entre N réplicas.
 *  2. Elige candidatos justos y los bloquea con FOR UPDATE SKIP LOCKED (filas que la API esté
 *     editando se saltan en vez de esperar).
 *  3. scheduled -> publishing con lease + claim_id (fencing token).
 * Garantías extra en la BD: índice único "1 en vuelo por Embajador".
 */
export async function claimBatch(pool: Pool, o: ClaimOptions): Promise<ClaimedPost[]> {
  return withTx(pool, async (c) => {
    // Medido (A.2.3): el arranque de workers paralelos costaba más que la query (52 ms -> 22 ms).
    // Además acorta el tiempo que se retiene la fila del bucket de app (hot row).
    await c.query("SET LOCAL max_parallel_workers_per_gather = 0");
    const bucket = await c.query(
      `SELECT least(capacity, tokens + refill_per_sec * extract(epoch FROM now() - updated_at)) AS available,
              coalesce(paused_until > now(), false) AS paused
       FROM rate_buckets WHERE key = 'app' FOR UPDATE SKIP LOCKED`,
    );
    if (bucket.rowCount === 0 || bucket.rows[0].paused) return [];
    const available = Number(bucket.rows[0].available);

    const inflight = (await c.query(`SELECT count(*)::int AS n FROM posts WHERE status = 'publishing'`)).rows[0].n as number;
    const n = Math.min(o.max, Math.floor(available), o.globalConcurrency - inflight);
    if (n <= 0) return [];

    const candidates = (await c.query(CANDIDATES_SQL, [n])).rows.map((r) => r.post_id as string);
    if (candidates.length === 0) return [];

    const claimed = await c.query(
      `UPDATE posts p
       SET status = 'publishing', claim_id = gen_random_uuid(), locked_by = $2,
           lease_until = now() + make_interval(secs => $3), updated_at = now()
       FROM (SELECT id FROM posts WHERE id = ANY($1) AND status = 'scheduled' FOR UPDATE SKIP LOCKED) locked
       WHERE p.id = locked.id
       RETURNING p.id, p.tenant_id, p.ambassador_id, p.content, p.claim_id, p.attempts, p.trace_id`,
      [candidates, o.workerId, o.leaseSeconds],
    );
    if (claimed.rowCount === 0) return [];
    const ids = claimed.rows.map((r) => r.id);

    await c.query(
      `UPDATE ambassadors SET next_allowed_at = now() + make_interval(secs => $2 + random() * $3)
       WHERE id IN (SELECT ambassador_id FROM posts WHERE id = ANY($1))`,
      [ids, o.ambassadorMinIntervalS, o.ambassadorJitterS],
    );
    await c.query(`UPDATE rate_buckets SET tokens = $1, updated_at = now() WHERE key = 'app'`, [available - ids.length]);
    await c.query(
      `INSERT INTO post_events (post_id, tenant_id, ambassador_id, from_status, to_status, actor)
       SELECT id, tenant_id, ambassador_id, 'scheduled', 'publishing', $2 FROM posts WHERE id = ANY($1)`,
      [ids, o.workerId],
    );
    return claimed.rows as ClaimedPost[];
  });
}

/**
 * Reaper: posts 'publishing' con lease caducado (worker caído a mitad de publicación) vuelven a la
 * cola. Se reintentan con el MISMO Idempotency-Key (= post.id): si el proveedor ya lo publicó,
 * devuelve el mismo external_id en vez de publicar dos veces. Cuenta como intento.
 */
export async function reapExpiredLeases(pool: Pool, maxAttempts: number, actor: string): Promise<number> {
  return withTx(pool, async (c) => {
    const res = await c.query(
      `WITH expired AS (
         SELECT id, locked_by FROM posts
         WHERE status = 'publishing' AND lease_until < now()
         FOR UPDATE SKIP LOCKED
       )
       UPDATE posts p
       SET attempts = p.attempts + 1,
           status = CASE WHEN p.attempts + 1 >= $1 THEN 'failed' ELSE 'scheduled' END,
           run_at = now(),
           last_error_code = CASE WHEN p.attempts + 1 >= $1 THEN 'MAX_ATTEMPTS_EXCEEDED' ELSE 'LEASE_EXPIRED' END,
           last_error_message = 'lease caducado (worker ' || coalesce(expired.locked_by, '?') || ' caído o colgado)',
           claim_id = NULL, locked_by = NULL, lease_until = NULL, updated_at = now()
       FROM expired
       WHERE p.id = expired.id
       RETURNING p.id, p.tenant_id, p.ambassador_id, p.status, p.last_error_code, p.attempts`,
      [maxAttempts],
    );
    for (const r of res.rows) {
      await insertEvent(c, { postId: r.id, tenantId: r.tenant_id, ambassadorId: r.ambassador_id, from: "publishing", to: r.status, code: r.last_error_code, actor });
      if (r.status === "failed") {
        await c.query(
          `INSERT INTO dead_letters (post_id, tenant_id, ambassador_id, error_code, error_message, attempts) VALUES ($1, $2, $3, $4, $5, $6)`,
          [r.id, r.tenant_id, r.ambassador_id, r.last_error_code, "lease expirado repetidamente", r.attempts],
        );
      }
    }
    return res.rowCount ?? 0;
  });
}
