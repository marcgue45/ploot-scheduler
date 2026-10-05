-- 001_init: esquema del scheduler.
-- Roles (creados por scripts/migrate.ts con contraseña desde env):
--   ploot_app    -> Route Handlers. Sin BYPASSRLS: solo ve su tenant vía RLS.
--   ploot_worker -> Worker. BYPASSRLS: reclama trabajo de todos los tenants.

-- Tenant actual de la transacción. NULL si no se fijó => RLS no devuelve nada (fail closed).
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ambassadors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name     text NOT NULL,
  timezone         text NOT NULL DEFAULT 'Europe/Madrid',
  -- Pausa impuesta por el proveedor (429 + Retry-After) o por token revocado ('infinity').
  paused_until     timestamptz,
  pause_reason     text,
  -- Throttle propio: intervalo mínimo entre publicaciones del mismo Embajador.
  next_allowed_at  timestamptz NOT NULL DEFAULT '-infinity',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Tokens OAuth cifrados (AES-256-GCM, AAD = tenant:ambassador). La app solo puede
-- leer columnas de estado (GRANT por columna), nunca el ciphertext.
CREATE TABLE oauth_credentials (
  ambassador_id     uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  access_token_ct   text NOT NULL,
  refresh_token_ct  text NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'revoked')),
  key_version       int NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ambassador_id) REFERENCES ambassadors (tenant_id, id) ON DELETE CASCADE
);

CREATE TYPE post_status AS ENUM ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');

CREATE TABLE posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El tenant sale de la transacción, nunca del body: el handler no puede equivocarse.
  tenant_id           uuid NOT NULL DEFAULT app_current_tenant(),
  ambassador_id       uuid NOT NULL,
  content             text NOT NULL CHECK (length(content) BETWEEN 1 AND 3000),
  status              post_status NOT NULL,
  scheduled_at        timestamptz,          -- intención del usuario (UTC)
  timezone            text,                 -- zona en la que lo programó (para mostrar)
  run_at              timestamptz,          -- cuándo vuelve a ser elegible (scheduled_at o backoff)
  attempts            int NOT NULL DEFAULT 0,
  claim_id            uuid,                 -- fencing token del claim en curso
  locked_by           text,
  lease_until         timestamptz,
  external_id         text,
  last_error_code     text,
  last_error_message  text,
  trace_id            text,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ambassador_id) REFERENCES ambassadors (tenant_id, id) ON DELETE CASCADE,
  CHECK (status <> 'scheduled' OR (scheduled_at IS NOT NULL AND run_at IS NOT NULL)),
  CHECK (status <> 'publishing' OR (claim_id IS NOT NULL AND lease_until IS NOT NULL))
);

-- Cola: índices parciales, solo filas vivas (los millones de 'published' no pesan).
CREATE INDEX posts_due_run_at_idx ON posts (run_at) WHERE status = 'scheduled';
CREATE INDEX posts_ambassador_head_idx ON posts (ambassador_id, scheduled_at, id) WHERE status = 'scheduled';
-- Cap por Embajador garantizado por la BD: como mucho 1 post en vuelo.
CREATE UNIQUE INDEX posts_one_inflight_per_ambassador ON posts (ambassador_id) WHERE status = 'publishing';
-- Reaper de leases caducados + conteo de en vuelo (cap global).
CREATE INDEX posts_publishing_lease_idx ON posts (lease_until) WHERE status = 'publishing';
-- Listado de la API (keyset pagination).
CREATE INDEX posts_tenant_list_idx ON posts (tenant_id, created_at DESC, id DESC);
CREATE INDEX posts_tenant_status_list_idx ON posts (tenant_id, status, created_at DESC, id DESC);

-- Auditoría de transiciones: responde "¿por qué va atrasado el Embajador X?".
CREATE TABLE post_events (
  id             bigserial PRIMARY KEY,
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL DEFAULT app_current_tenant(),
  ambassador_id  uuid NOT NULL,
  from_status    post_status,
  to_status      post_status NOT NULL,
  code           text,
  detail         text,
  actor          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_events_ambassador_idx ON post_events (ambassador_id, created_at DESC);
CREATE INDEX post_events_post_idx ON post_events (post_id, created_at DESC);

-- DLQ: posts agotados, con payload para replay.
CREATE TABLE dead_letters (
  id             bigserial PRIMARY KEY,
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL,
  ambassador_id  uuid NOT NULL,
  error_code     text NOT NULL,
  error_message  text,
  attempts       int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotency-Key de POST /publish, por tenant.
CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL DEFAULT app_current_tenant(),
  key              text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash     text NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Gobernador de rate limit global (token bucket de app) + pausa por 429 de app.
CREATE TABLE rate_buckets (
  key             text PRIMARY KEY,
  tokens          double precision NOT NULL,
  capacity        double precision NOT NULL,
  refill_per_sec  double precision NOT NULL,
  paused_until    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rate_buckets (key, tokens, capacity, refill_per_sec) VALUES ('app', 10, 10, 2);

-- ---------- Row Level Security ----------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = app_current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ambassadors', 'oauth_credentials', 'posts', 'post_events', 'dead_letters', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- ---------- Grants (mínimo privilegio) ----------
GRANT SELECT ON tenants, ambassadors, rate_buckets TO ploot_app;
GRANT SELECT, INSERT, UPDATE ON posts TO ploot_app;          -- sin DELETE: cancelar = transición
GRANT SELECT, INSERT ON post_events TO ploot_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO ploot_app;
GRANT SELECT (ambassador_id, tenant_id, status, expires_at) ON oauth_credentials TO ploot_app;
GRANT USAGE ON SEQUENCE post_events_id_seq TO ploot_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ploot_worker;
GRANT DELETE ON idempotency_keys TO ploot_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ploot_worker;
