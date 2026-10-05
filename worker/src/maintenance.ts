import type { Pool } from "@ploot/shared";

/**
 * Borra Idempotency-Keys más antiguas que el TTL, en lotes pequeños para no retener locks ni
 * generar picos de WAL. Pasado el TTL, un reintento con la misma clave se trataría como nuevo:
 * 24 h cubre de sobra cualquier reintento razonable de un cliente.
 */
export async function purgeIdempotencyKeys(pool: Pool, ttlHours: number, batchSize = 1000): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM idempotency_keys
       WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1) LIMIT $2)`,
      [ttlHours, batchSize],
    );
    total += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batchSize) return total;
  }
}
