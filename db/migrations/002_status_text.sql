-- 002: posts.status y post_events.*_status pasan de ENUM a text + CHECK.
-- Motivo (medido, ver PDF A.2.3): enum_eq NO es LEAKPROOF. Con RLS, Postgres no puede combinar un
-- predicado no-leakproof del usuario (status = 'failed') con la política en una condición de índice:
-- el listado por estado de un tenant con 5M filas pasaba de 0,07 ms (sin RLS) a 1,2 s (con RLS).
-- texteq sí es LEAKPROOF -> el índice (tenant_id, status, created_at, id) vuelve a usarse.
-- A esta escala basta con ALTER TYPE; con millones de filas en producción se haría expand/contract
-- (columna nueva + backfill por lotes + swap) para no reescribir la tabla bajo lock.

DROP INDEX posts_due_run_at_idx, posts_ambassador_head_idx, posts_one_inflight_per_ambassador,
           posts_publishing_lease_idx, posts_tenant_status_list_idx;
ALTER TABLE posts DROP CONSTRAINT posts_check, DROP CONSTRAINT posts_check1;

ALTER TABLE posts ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE post_events
  ALTER COLUMN from_status TYPE text USING from_status::text,
  ALTER COLUMN to_status TYPE text USING to_status::text;
DROP TYPE post_status;

ALTER TABLE posts
  ADD CONSTRAINT posts_status_check
    CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  ADD CONSTRAINT posts_scheduled_has_time
    CHECK (status <> 'scheduled' OR (scheduled_at IS NOT NULL AND run_at IS NOT NULL)),
  ADD CONSTRAINT posts_publishing_has_claim
    CHECK (status <> 'publishing' OR (claim_id IS NOT NULL AND lease_until IS NOT NULL));

CREATE INDEX posts_due_run_at_idx ON posts (run_at) WHERE status = 'scheduled';
CREATE INDEX posts_ambassador_head_idx ON posts (ambassador_id, scheduled_at, id) WHERE status = 'scheduled';
CREATE UNIQUE INDEX posts_one_inflight_per_ambassador ON posts (ambassador_id) WHERE status = 'publishing';
CREATE INDEX posts_publishing_lease_idx ON posts (lease_until) WHERE status = 'publishing';
CREATE INDEX posts_tenant_status_list_idx ON posts (tenant_id, status, created_at DESC, id DESC);
