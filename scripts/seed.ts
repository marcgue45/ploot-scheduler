/** Seed de demo: 2 tenants, Embajadores con token válido / expirado / revocado, posts en varios estados. */
import pg from "pg";
import { DEMO, encryptToken, tokenAad } from "../shared/src/index";

const minutes = (m: number) => new Date(Date.now() + m * 60_000);

type PostSeed = { amb: keyof typeof DEMO.ambassadors; content: string; status: string; at?: Date; error?: [string, string]; attempts?: number };

const POSTS: PostSeed[] = [
  { amb: "ana", content: "Lo que aprendimos cerrando 40 reuniones sin outbound frío", status: "published", at: minutes(-1440) },
  { amb: "ana", content: "3 señales de que un prospecto está listo para hablar", status: "scheduled", at: minutes(-2) },
  { amb: "ana", content: "Hilo: cómo medimos el impacto de la marca personal", status: "scheduled", at: minutes(-1) },
  { amb: "ana", content: "Post programado para dentro de 3 minutos", status: "scheduled", at: minutes(3) },
  { amb: "ana", content: "Post programado para dentro de 1 hora", status: "scheduled", at: minutes(60) },
  { amb: "ana", content: "Post programado a 30 días vista", status: "scheduled", at: minutes(30 * 1440) },
  { amb: "ana", content: "Borrador: ideas para el webinar de octubre", status: "draft" },
  { amb: "ana", content: "Este falló tras 5 intentos contra el proveedor", status: "failed", at: minutes(-600), attempts: 5, error: ["MAX_ATTEMPTS_EXCEEDED", "PROVIDER_5XX: HTTP 503 (5 intentos)"] },
  { amb: "ana", content: "Post cancelado por el usuario", status: "cancelled", at: minutes(120) },
  { amb: "bruno", content: "Bruno: su token expiró, el worker lo refrescará antes de publicar", status: "scheduled", at: minutes(-1) },
  { amb: "bruno", content: "Bruno: segundo post en 5 minutos", status: "scheduled", at: minutes(5) },
  { amb: "carla", content: "Carla: token revocado, debe fallar con TOKEN_REVOKED sin reintentos", status: "scheduled", at: minutes(-1) },
  { amb: "carla", content: "Carla: este queda bloqueado hasta que reconecte", status: "scheduled", at: minutes(10) },
  { amb: "diego", content: "Diego (Globex): ya publicado", status: "published", at: minutes(-300) },
  { amb: "diego", content: "Diego (Globex): vencido, se publica al arrancar", status: "scheduled", at: minutes(-3) },
  { amb: "diego", content: "Diego (Globex): segundo vencido, espera al throttle por Embajador", status: "scheduled", at: minutes(-2) },
  { amb: "elena", content: "Elena (Globex): vencido", status: "scheduled", at: minutes(-1) },
  { amb: "elena", content: "Elena (Globex): borrador", status: "draft" },
];

export async function seed(adminUrl: string, mode = process.env.SEED_MODE ?? "if-empty") {
  const c = new pg.Client({ connectionString: adminUrl, ssl: process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    const existing = (await c.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n;
    if (existing > 0 && mode !== "reset") {
      console.log(JSON.stringify({ service: "seed", msg: "already seeded, skipping (SEED_MODE=reset to force)" }));
      return;
    }
    await c.query("BEGIN");
    await c.query("TRUNCATE tenants, idempotency_keys RESTART IDENTITY CASCADE");
    await c.query("UPDATE rate_buckets SET tokens = capacity, paused_until = NULL, updated_at = now()");
    for (const t of Object.values(DEMO.tenants)) {
      await c.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [t.id, t.name]);
    }
    const nowS = Math.floor(Date.now() / 1000);
    for (const a of Object.values(DEMO.ambassadors)) {
      const tenantId = DEMO.tenants[a.tenant].id;
      await c.query("INSERT INTO ambassadors (id, tenant_id, display_name) VALUES ($1, $2, $3)", [a.id, tenantId, a.name]);
      const exp = a.token === "valid" ? nowS + 3600 : nowS - 3600;
      const aad = tokenAad(tenantId, a.id);
      await c.query(
        `INSERT INTO oauth_credentials (ambassador_id, tenant_id, access_token_ct, refresh_token_ct, expires_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5))`,
        [a.id, tenantId, encryptToken(`at:${a.id}:${exp}`, aad), encryptToken(`rt:${a.id}:${a.token === "revoked" ? "revoked" : "ok"}`, aad), exp],
      );
    }
    for (const p of POSTS) {
      const a = DEMO.ambassadors[p.amb];
      const tenantId = DEMO.tenants[a.tenant].id;
      const res = await c.query(
        `INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, timezone, run_at, attempts,
                            external_id, published_at, last_error_code, last_error_message, trace_id)
         VALUES ($1, $2, $3, $4, $5, 'Europe/Madrid', $5, $6, $7, $8, $9, $10, replace(gen_random_uuid()::text, '-', ''))
         RETURNING id`,
        [
          tenantId, a.id, p.content, p.status, p.at ?? null, p.attempts ?? 0,
          p.status === "published" ? `ext_seed_${Math.random().toString(36).slice(2, 10)}` : null,
          p.status === "published" ? p.at : null,
          p.error?.[0] ?? null, p.error?.[1] ?? null,
        ],
      );
      await c.query(
        `INSERT INTO post_events (post_id, tenant_id, ambassador_id, to_status, actor, detail) VALUES ($1, $2, $3, $4, 'seed', 'seed')`,
        [res.rows[0].id, tenantId, a.id, p.status],
      );
    }
    await c.query("COMMIT");
    console.log(JSON.stringify({ service: "seed", msg: "seeded", tenants: 2, ambassadors: 5, posts: POSTS.length }));
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL no configurada");
  seed(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
