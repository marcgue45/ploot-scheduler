# Despliegue público

- **Vercel** (proyecto `ploot-scheduler`): `rootDirectory=app`, framework Next.js, funciones en `fra1` (`app/vercel.json`).
  Variables (Production, *sensitive*): `DATABASE_URL` (rol `ploot_app` vía PgBouncer), `JWT_SECRET`, `DB_POOL_MAX=2`,
  `DATABASE_SSL=no-verify`, `DEMO_MODE=true`.
- **Railway** (proyecto `ploot-scheduler`, región `europe-west4`), mismo `Dockerfile`:
  - `worker`: `APP_ROLE=worker`, `WORKER_DATABASE_URL` (rol `ploot_worker`, red privada, directo), `PROVIDER_URL=http://mock.railway.internal:4000`, `TOKEN_ENC_KEY`.
  - `mock`: `APP_ROLE=mock`, `PORT=4000`.
  - `Postgres` + `PgBouncer` (transaction mode, `railway postgres pgbouncer add`).
- **Migraciones**: job one-shot `npm run db:migrate` con `DATABASE_ADMIN_URL` (conexión directa, advisory lock).
- Ningún valor real en el repo: ver `.env.example` para los nombres.
