/**
 * EXPLAIN (ANALYZE, BUFFERS) de la query caliente REAL del worker (importada de claim.ts) y del
 * listado de la API bajo RLS. Uso: DATABASE_ADMIN_URL=... npx tsx scripts/explain-claim.ts
 */
import pg from "pg";
import { CANDIDATES_SQL } from "../worker/src/claim";

const BIG = "99999999-9999-4999-8999-999999999999";
const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await c.connect();

const stats = await c.query(`
  SELECT (SELECT count(*) FROM posts) AS total_posts,
         (SELECT count(*) FROM posts WHERE tenant_id = $1) AS bigcorp_posts,
         (SELECT count(*) FROM posts WHERE status = 'scheduled' AND run_at <= now()) AS due_posts,
         (SELECT count(*) FROM ambassadors) AS ambassadors`, [BIG]);
console.log("Dataset:", stats.rows[0], "\n");

const plan = async (title: string, sql: string, params: unknown[]) => {
  const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${sql}`, params);
  console.log(`=== ${title} ===\n${r.rows.map((x) => x["QUERY PLAN"]).join("\n")}\n`);
};

await plan("Claim: cabezas de cola justas entre tenants (LIMIT 10)", CANDIDATES_SQL, [10]);

// Listado de la API para el tenant grande, como lo ejecuta ploot_app (RLS añade tenant_id = ...).
await c.query("BEGIN");
await c.query("SET LOCAL ROLE ploot_app");
await c.query("SELECT set_config('app.tenant_id', $1, true)", [BIG]);
await plan(
  "API GET /posts?status=scheduled&limit=20 (BigCorp, 5M filas, bajo RLS)",
  `SELECT p.id, p.status, p.created_at FROM posts p WHERE p.status = 'scheduled' ORDER BY p.created_at DESC, p.id DESC LIMIT 20`,
  [],
);
await c.query("ROLLBACK");
await c.end();
