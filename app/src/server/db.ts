import { createPool, withTenant, type AuthContext, type DbClient, type Pool } from "@ploot/shared";

const g = globalThis as unknown as { __plootPool?: Pool };

/**
 * Un pool por instancia, reutilizado entre invocaciones. En serverless DB_POOL_MAX debe ser 1-3 y
 * DATABASE_URL apuntar al pooler (PgBouncer transaction mode): por eso el tenant se fija con
 * set_config(..., true) dentro de la transacción y no hay estado de sesión.
 */
export function appPool(): Pool {
  if (!g.__plootPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no configurada");
    g.__plootPool = createPool(url, { max: Number(process.env.DB_POOL_MAX ?? 5), name: "ploot-app" });
  }
  return g.__plootPool;
}

export const tenantTx = <T>(auth: AuthContext, fn: (c: DbClient) => Promise<T>) => withTenant(appPool(), auth.tenantId, fn);
