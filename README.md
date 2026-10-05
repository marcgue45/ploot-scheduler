# Ploot · scheduler de publicación

Prueba técnica de backend: scheduler que publica en nombre de Embajadores contra un proveedor externo
(mock), con Next.js (Route Handlers), un worker separado y Postgres.

- **URL pública:** https://ploot-scheduler.vercel.app (UI de demo: elige un perfil, crea/programa, "Publicar ahora")
- **Respuestas escritas (A, B, D, E):** [`docs/ENTREGA.md`](docs/ENTREGA.md) / `docs/ENTREGA.pdf`
- **Despliegue:** app en Vercel `fra1`; worker, mock, Postgres y PgBouncer en Railway `europe-west4`.

## Levantarlo en local (< 10 min)

Requisitos: Docker con Compose v2.

```bash
docker compose up          # app + worker + mock + Postgres + migraciones y seed
# si el 5432 está ocupado:  PG_HOST_PORT=55432 docker compose up
```

- UI: http://localhost:3000 · Mock: http://localhost:4000
- `docker compose up` descarga la imagen precompilada de GHCR (`ghcr.io/marcgue45/ploot-scheduler`).
  Para compilar desde el código: `docker compose up --build`.
- Los valores por defecto del compose son **solo locales**; en el despliegue todo va por variables de entorno del host.

## Tests

```bash
npm ci
PG_HOST_PORT=55432 docker compose up -d postgres
TEST_PG_URL=postgres://postgres:postgres@localhost:55432 npm test   # 28 tests contra Postgres real
```

Cubren: N workers sin doble publicación + crash a mitad de publicación + worker zombi, aislamiento
cross-tenant a nivel SQL (RLS), DST Europe/Madrid, idempotencia (incluida concurrente), 429/5xx/tokens,
replay de DLQ y purga de claves.

## API

Todas con `Authorization: Bearer <jwt>` (`tenant_id` + `profile_id`). JWT de prueba: `npm run jwt`
(o `GET /api/demo/tokens` con `DEMO_MODE=true`).

| Método | Ruta | |
|---|---|---|
| POST | `/api/v1/posts` | crear (`draft` / `scheduled`; `scheduled_at` ISO o `local_time` + `timezone`) |
| GET | `/api/v1/posts?status=&limit=&cursor=` | listado con keyset pagination |
| PATCH / DELETE | `/api/v1/posts/:id` | editar / cancelar (409 si `published`) |
| POST | `/api/v1/posts/:id/publish` | publicación inmediata, header `Idempotency-Key` (202) |
| GET | `/api/v1/ambassadors/:id` | diagnóstico "¿por qué va atrasado este Embajador?" |
| GET / POST | `/api/v1/dead-letters`, `/api/v1/dead-letters/:id/replay` | DLQ y replay |

## Estructura

`app/` (Next.js) · `worker/` · `mock/` · `shared/` · `db/migrations` · `db/bench` (dataset de 5M para `EXPLAIN`) ·
`scripts/` (migrate, seed, jwt, explain) · `tests/` · `.github/workflows/ci.yml` · `infra/`
