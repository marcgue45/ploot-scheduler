-- 003: replay de la DLQ desde la API + limpieza de idempotency_keys.

-- Una fila de DLQ se reprocesa como mucho una vez (auditable: quién y cuándo).
ALTER TABLE dead_letters
  ADD COLUMN replayed_at timestamptz,
  ADD COLUMN replayed_by text;
CREATE INDEX dead_letters_pending_idx ON dead_letters (tenant_id, created_at DESC) WHERE replayed_at IS NULL;

-- La app (bajo RLS) puede listar su DLQ y marcar el replay; no puede borrar.
GRANT SELECT ON dead_letters TO ploot_app;
GRANT UPDATE (replayed_at, replayed_by) ON dead_letters TO ploot_app;

-- Barrido de claves caducadas por antigüedad (el worker borra por lotes).
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
