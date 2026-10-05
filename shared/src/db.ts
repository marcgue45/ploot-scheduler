import pg from "pg";

export type Pool = pg.Pool;
export type DbClient = pg.PoolClient;

// timestamptz -> ISO string en vez de Date: lo que sale por la API es siempre UTC ISO-8601.
pg.types.setTypeParser(1184, (v) => {
  if (v === null || v === "infinity" || v === "-infinity") return v;
  return new Date(v).toISOString();
});

export function createPool(connectionString: string, opts: { max?: number; name?: string } = {}): Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.name,
    // Railway/Neon exponen Postgres con TLS. DATABASE_SSL=no-verify para certificados no públicos.
    ssl: process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withTx<T>(pool: Pool, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Ejecuta fn en una transacción con el tenant fijado (set_config local = SET LOCAL).
 * Las políticas RLS filtran por app_current_tenant(): el aislamiento vive en la BD,
 * no en el Route Handler. Compatible con PgBouncer en transaction mode.
 */
export function withTenant<T>(pool: Pool, tenantId: string, fn: (c: DbClient) => Promise<T>): Promise<T> {
  return withTx(pool, async (c) => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(c);
  });
}
