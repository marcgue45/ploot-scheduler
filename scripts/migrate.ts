/**
 * Migraciones: se ejecutan UNA vez por despliegue (job one-shot en compose / paso del pipeline),
 * nunca al arrancar la app, protegidas por advisory lock por si dos ejecuciones coinciden.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "db", "migrations");

async function ensureRole(c: pg.Client, role: string, password: string, bypassRls: boolean) {
  const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypassRls ? "BYPASSRLS" : "NOBYPASSRLS"}`;
  const pw = c.escapeLiteral(password);
  await c.query(exists ? `ALTER ROLE ${role} ${attrs} PASSWORD ${pw}` : `CREATE ROLE ${role} ${attrs} PASSWORD ${pw}`);
}

export async function migrate(adminUrl: string, log = console.log) {
  const c = new pg.Client({
    connectionString: adminUrl,
    ssl: process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    await c.query("SET lock_timeout = '5s'");
    await ensureRole(c, "ploot_app", process.env.APP_DB_PASSWORD ?? "app_local_pw", false);
    await ensureRole(c, "ploot_worker", process.env.WORKER_DB_PASSWORD ?? "worker_local_pw", true);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        log(JSON.stringify({ service: "migrate", msg: "applied", migration: f }));
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await c.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL no configurada");
  migrate(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
