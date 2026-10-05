-- Dataset sintético SOLO para medir planes (A.2.3). Nunca contra producción.
-- BigCorp: 50 Embajadores, ~5M posts (histórico 'published' + 90 días programados + vencidos).
-- 1.000 tenants normales x 5 Embajadores: ~0,5M posts; ~20 % de Embajadores con algo vencido (pico 09:00).
SET synchronous_commit = off;

INSERT INTO tenants (id, name) VALUES ('99999999-9999-4999-8999-999999999999', 'BigCorp');
INSERT INTO tenants (name) SELECT 'tenant ' || g FROM generate_series(1, 1000) g;
INSERT INTO ambassadors (tenant_id, display_name)
  SELECT '99999999-9999-4999-8999-999999999999', 'big ' || g FROM generate_series(1, 50) g;
INSERT INTO ambassadors (tenant_id, display_name)
  SELECT t.id, 'amb ' || g FROM tenants t CROSS JOIN generate_series(1, 5) g WHERE t.name LIKE 'tenant %';

-- BigCorp: 50 x 98.000 publicados (cada 7 min hacia atrás) = 4,9M
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at, published_at, external_id, created_at)
SELECT a.tenant_id, a.id, 'historico', 'published', ts, ts, ts, 'ext', ts
FROM ambassadors a
CROSS JOIN LATERAL (SELECT now() - g * interval '7 minutes' AS ts FROM generate_series(1, 98000) g) s
WHERE a.tenant_id = '99999999-9999-4999-8999-999999999999';

-- BigCorp: 50 x 1.800 programados a futuro (90 días) = 90k
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at)
SELECT a.tenant_id, a.id, 'futuro', 'scheduled', ts, ts
FROM ambassadors a
CROSS JOIN LATERAL (SELECT now() + g * interval '72 minutes' AS ts FROM generate_series(1, 1800) g) s
WHERE a.tenant_id = '99999999-9999-4999-8999-999999999999';

-- BigCorp: 50 x 50 vencidos (últimos 50 min) = 2.500
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at)
SELECT a.tenant_id, a.id, 'vencido', 'scheduled', ts, ts
FROM ambassadors a
CROSS JOIN LATERAL (SELECT now() - g * interval '1 minute' AS ts FROM generate_series(1, 50) g) s
WHERE a.tenant_id = '99999999-9999-4999-8999-999999999999';

-- Tenants normales: 5.000 Embajadores x 100 publicados = 500k; x 5 futuros = 25k
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at, published_at, external_id, created_at)
SELECT a.tenant_id, a.id, 'historico', 'published', ts, ts, ts, 'ext', ts
FROM ambassadors a
CROSS JOIN LATERAL (SELECT now() - g * interval '1 day' AS ts FROM generate_series(1, 100) g) s
WHERE a.tenant_id <> '99999999-9999-4999-8999-999999999999';
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at)
SELECT a.tenant_id, a.id, 'futuro', 'scheduled', ts, ts
FROM ambassadors a
CROSS JOIN LATERAL (SELECT now() + g * interval '15 days' AS ts FROM generate_series(1, 5) g) s
WHERE a.tenant_id <> '99999999-9999-4999-8999-999999999999';
-- ~20 % de Embajadores normales con 1 post vencido = ~1.000
INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, run_at)
SELECT a.tenant_id, a.id, 'vencido', 'scheduled', now() - interval '3 minutes', now() - interval '3 minutes'
FROM ambassadors a
WHERE a.tenant_id <> '99999999-9999-4999-8999-999999999999' AND random() < 0.2;

VACUUM ANALYZE;
