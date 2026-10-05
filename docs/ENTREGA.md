# Ploot · Prueba técnica de Backend — Respuestas escritas

> **URL pública:** https://ploot-scheduler.vercel.app · **Repo:** https://github.com/marcgue45/ploot-scheduler (PR `assessment`)

## Asunciones globales

1. "5.000 cuentas activas" = 5.000 Embajadores conectados (~500–1.000 tenants). A 50× → 250k Embajadores.
2. Volumen: ~1–3 posts/Embajador/día, concentrados en franjas (pico 09:00 CET). Hoy ≈ 10k posts/día, pico de decenas/s; a 50× ≈ 500k/día, pico de cientos/s.
3. Límites del proveedor desconocidos → configurables. Operamos **por debajo** del límite publicado (margen 20–50 %) porque el coste de un ban es mucho mayor que el de un retraso.
4. `POST /publish` ("publicar ahora") es **asíncrono**: encola con `scheduled_at = now()` y devuelve `202`. Llamar al proveedor (0–3 s + reintentos) dentro del request rompería el p95 < 4 s y saltaría el gobernador de rate limit.
5. Ploot es **encargado** del tratamiento (GDPR); el tenant es responsable. Las solicitudes de derechos llegan vía el tenant.
6. **El proveedor acepta `Idempotency-Key` en `/publish`** (lo implementa nuestro mock; el contrato del enunciado no lo menciona). Sin deduplicación en el proveedor, *exactly-once* es imposible ante un crash entre su `200` y nuestro commit; la alternativa sería un estado `unknown` + reconciliación.

---

## A. Diseño de sistema

### A.1 — Arquitectura de referencia

**Host elegido: Vercel (app Next.js, región `fra1` Frankfurt) + Railway (worker, Postgres + PgBouncer, región `europe-west4` Países Bajos).** Es exactamente lo que está desplegado: la arquitectura que defiendo es la que se puede tocar en la URL pública. Todo el dato reside en la UE.

```mermaid
flowchart LR
  U["Navegador / cliente API"] --> DNS

  subgraph EDGE["Edge · Vercel"]
    DNS["DNS + TLS 1.3 (auto) + HSTS"] --> WAF["Vercel Firewall (WAF, rate limit por IP)"]
    WAF --> CDN["CDN: solo assets estáticos de la UI"]
  end

  subgraph APP["Next.js · Vercel Functions · fra1 · runtime Node"]
    RH["Route Handlers /api/v1/*<br/>verifica JWT · tx con SET LOCAL tenant (RLS)<br/>UI de demo"]
  end
  WAF --> RH

  subgraph RW["Railway · europe-west4"]
    POOL["PgBouncer (transaction mode)<br/>pool 70 · máx. 1000 clientes"]
    PG[("Postgres<br/>posts = cola · dead_letters (DLQ)<br/>rate_buckets · oauth_credentials cifradas<br/>idempotency_keys · post_events")]
    W["Worker ×N (contenedor de larga vida)<br/>claim FOR UPDATE SKIP LOCKED + lease<br/>gobernador de rate limit"]
    VAR["Variables selladas Railway<br/>clave maestra tokens · credenciales BD · client secret"]
    POOL --> PG
    W -- "red privada, conexión directa, pool fijo 5" --> PG
    VAR -.-> W
  end
  RH -- "TLS · pool max 2 por instancia" --> POOL
  W -- "HTTPS + traceparent + Idempotency-Key" --> PROV["Proveedor externo (red social)"]

  S3[("Object storage UE (R2 jurisdicción UE)<br/>media · URL presignada")]
  RH -. "URL presignada" .-> S3
  W -.-> S3

  subgraph OBS["Observabilidad (región UE)"]
    OT["Logs JSON → log drains Vercel/Railway → Grafana Cloud EU<br/>métricas · trazas OTel"]
  end
  RH -.-> OT
  W -.-> OT
```

**Node vs Edge.** Todo lo que toca datos corre en **runtime Node en `fra1`**: `pg` necesita sockets TCP (Edge no los tiene), y una función Edge se ejecuta cerca del usuario, lejos de la BD, con lo que cada query cruzaría Europa. El Edge solo sirve TLS, WAF y assets estáticos. La verificación del JWT también va en Node, dentro del Route Handler, porque el `tenant_id` del token tiene que entrar en la misma transacción de BD (RLS).

| Pieza | Elección | Alternativa descartada y su coste | $/mes a 5k |
|---|---|---|---|
| Edge | Vercel Edge Network + Vercel Firewall | Cloudflare delante: doble proxy, dos capas de caché y otra cuenta, para un WAF que Vercel ya incluye | incl. |
| App | Vercel Functions, `fra1`, Node | Next.js en contenedor en Railway: un proveedor menos, pero perdemos preview deploys por PR, rollback instantáneo y autoescalado sin operar | ~100 (Pro + uso) |
| Worker | Contenedor de larga vida en Railway, 2 réplicas (0,5 vCPU / 0,5 GB), misma red privada que la BD | AWS Fargate: tiene identidad de workload (IAM), pero suma VPC, IAM y otra factura. Vercel Cron + funciones: timeouts, cold starts, sin estado de throttling (descartado por requisito) | ~30 |
| Cola + DLQ | La tabla `posts` es la cola (`SKIP LOCKED`). DLQ = `failed` + tabla `dead_letters` | SQS: delay máximo 15 min, así que los 90 días necesitarían igualmente tabla + barredor, con *dual write* BD↔cola. BullMQ + Redis: segunda fuente de verdad que mantener en HA | 0 |
| Gobernador rate limit | Token bucket de app en Postgres (fila `rate_buckets`) + throttle y pausa por Embajador + round-robin por tenant, en la misma tx que el claim | Redis + Lua: más rápido, pero otra pieza. A 5k el pico (decenas/s) cabe en Postgres; migramos cuando la fila del bucket tenga contención (~cientos de claims/s) | 0 |
| Bóveda de tokens | Tokens en Postgres cifrados AES-256-GCM (AAD = tenant:Embajador). Clave maestra en variable sellada de Railway, solo visible para el worker | AWS KMS: HSM y auditoría por uso, pero desde Railway exige una clave IAM estática (no hay identidad de workload). Secrets Manager por token: 0,40 $/secreto → 2k $/mes hoy | 0 |
| Postgres | Railway Postgres en `europe-west4`; en producción HA (`railway postgres ha`, 3 nodos) + PITR | Neon: pooler integrado y ramas por PR, pero sería un tercer proveedor y su red no es privada con el worker. RDS: más maduro, pero obliga a VPC y Secure Compute desde Vercel | ~150–250 (HA) |
| Pooler | PgBouncer gestionado de Railway, transaction mode, para la app serverless. El worker y las migraciones conectan directos | RDS Proxy (no aplica). Sin pooler: N instancias × pool agotan `max_connections` en el pico | ~10 |
| Caché | **Ninguna dedicada** al principio | Redis: no hay nada con valor que cachear. Las lecturas son por tenant y pequeñas, y la idempotencia necesita durabilidad transaccional (Postgres) | 0 |
| Object storage | Cloudflare R2 con jurisdicción UE (sin coste de egress hacia el proveedor) | S3: cobra egress en cada subida de media al proveedor. Vercel Blob: sin garantía de región UE | ~5–20 |
| Secrets / identidad | Variables por entorno: Vercel (marcadas *sensitive*) y Railway (selladas: no se pueden leer de vuelta). Un rol de BD por proceso | Secrets Manager/Vault: mejor rotación y auditoría, pero sin identidad de workload desde Railway seguiría haciendo falta una credencial estática para leerlo | 0 |
| Observabilidad | Logs JSON estructurados → log drains de Vercel y Railway → Grafana Cloud EU; trazas OpenTelemetry | Datadog: el coste de logs se dispara con el volumen. Solo los logs de cada plataforma: no correlacionan app y worker | ~50–100 |
| **Total** | | | **~350–550 $/mes** |

**Hueco declarado y disparador de migración.** Railway no ofrece identidad de workload, así que la clave maestra de los tokens es una variable sellada (estática, rotada a mano) y no hay KMS/HSM. Lo acepto a 5k Embajadores con controles compensatorios: solo el servicio worker la ve, el rol de la app no puede leer el ciphertext y la rotación está soportada (`key_version`). **Disparador para mover worker + claves a AWS (Fargate + KMS vía IAM role):** un cliente enterprise que exija KMS/BYOK o auditoría SOC 2, o superar ~50k Embajadores.

### A.2 — Tokens, rate limits, datos y conexiones

**1. Tokens OAuth.**
- **Dónde y cómo se cifran.** En la tabla `oauth_credentials` (`tenant_id`, `ambassador_id`, `access_token_ct`, `refresh_token_ct`, `expires_at`, `status valid|revoked`, `key_version`). AES-256-GCM con AAD = `tenant_id:ambassador_id`, así que un ciphertext copiado a otra fila no descifra. Solo el rol de BD del worker lee esas columnas; el rol de la app tiene `GRANT` solo sobre `status` y `expires_at`.
  - *Implementado:* una clave maestra (variable sellada del worker).
  - *Siguiente paso:* una DEK por Embajador envuelta por la clave maestra. Así, borrar la DEK hace ilegible cualquier copia del token (*crypto-shredding*, ver punto 4).
- **Refresco antes de expirar.** *Just-in-time*: antes de publicar, si el token caduca en menos de 60 s, el worker lo refresca. No hay carrera entre réplicas porque un índice único garantiza 1 post en vuelo por Embajador, así que solo una réplica puede refrescar su token a la vez. Con *refresh token rotation*, dos refrescos simultáneos se invalidarían entre sí. *Siguiente paso:* un barrido proactivo de los tokens que caducan en menos de 10 min, para que el refresh no sume latencia al pico.
- **Revocado a mitad de lote.** El refresh devuelve `invalid_grant` → la credencial pasa a `revoked` y el post en curso a `failed/TOKEN_REVOKED`, **sin gastar reintentos**. El Embajador queda en pausa indefinida (`paused_until = infinity`): el resto de sus posts **no se queman** uno a uno contra el proveedor y se reanudan si reconecta. El claim es por post, así que el resto del lote, de otros Embajadores, no se ve afectado.
- **Tenancy.** Modelo *pool*: tabla compartida con `tenant_id` + RLS. Descartamos un silo por tenant (5k esquemas o BDs que migrar y conectar).

**2. Gobierno del rate limit.** Implementado en `worker/src/claim.ts`, en la misma transacción que el claim. Son tres capas:
- **App (cuota compartida).** Token bucket en la fila `rate_buckets('app')`, configurado al 80 % de la cuota real. Un 429 con scope app vacía el bucket y pausa la app hasta `Retry-After`. Además, un **cap global de concurrencia**: nunca más de N posts en vuelo entre todas las réplicas, contado en BD.
- **Embajador.** Como mucho 1 post en vuelo (índice único `posts_one_inflight_per_ambassador`), un intervalo mínimo propio con jitter entre publicaciones (`next_allowed_at`, para no publicar con patrón de bot) y una pausa por 429 que respeta `Retry-After` **sin gastar intento ni adelantar su cola**.
- **Equidad entre tenants.** El claim coge la cabeza de cola de cada Embajador elegible y la ordena por `row_number() OVER (PARTITION BY tenant_id)`, es decir, en *round-robin* por tenant. Un tenant con 50 Embajadores × 100 posts a las 09:00 recibe su parte justa mientras otros tengan trabajo, y usa la capacidad sobrante cuando no la tienen (*work-conserving*).
- **Modos de fallo.**
  - BD caída → **fail closed**: no se publica. Retrasar es recuperable; un ban no.
  - La fila del bucket de app serializa los claims: un worker que la encuentra bloqueada no espera (`SKIP LOCKED`), reintenta en el siguiente ciclo. A cientos de claims/s sería un *hot row* → bucket en Redis o un único dispatcher que reparta tokens por lotes.
  - *Siguiente paso:* un bucket por tenant con cuota proporcional al plan (hoy la equidad es por turnos, no por presupuesto).

**3. Query caliente + conexiones bajo serverless.**
- **Índices** (parciales: los millones de filas `published` no entran):
  - `posts (run_at) WHERE status = 'scheduled'`, para localizar Embajadores con trabajo vencido;
  - `posts (ambassador_id, scheduled_at, id) WHERE status = 'scheduled'`, para la cabeza de cola de cada Embajador.
- **Forma de la query** (simplificada):
  ```sql
  WITH due AS (SELECT DISTINCT ambassador_id FROM posts WHERE status = 'scheduled' AND run_at <= now()),
  heads AS (SELECT a.tenant_id, h.* FROM due d JOIN ambassadors a ON a.id = d.ambassador_id
            CROSS JOIN LATERAL (SELECT id, scheduled_at, run_at FROM posts
                                WHERE ambassador_id = d.ambassador_id AND status = 'scheduled'
                                ORDER BY scheduled_at, id LIMIT 1) h
            WHERE h.run_at <= now() AND <no pausado, throttle vencido, nada en vuelo>)
  SELECT id FROM (SELECT *, row_number() OVER (PARTITION BY tenant_id ORDER BY scheduled_at) rn FROM heads) r
  ORDER BY rn, scheduled_at LIMIT $n;
  -- después: UPDATE ... FROM (SELECT id ... FOR UPDATE SKIP LOCKED) -> 'publishing'
  ```
- **`EXPLAIN` esperado.** `Limit → Sort (rn, scheduled_at) → WindowAgg → Nested Loop → HashAggregate (Index Scan posts_due_run_at_idx) → Index Scan ambassadors_pkey → Limit → Index Scan posts_ambassador_head_idx`. El coste es O(Embajadores con trabajo vencido) y no depende de que un tenant tenga 5M filas históricas.
- **Conexiones desde la app.** Cada instancia serverless usa la URL de **PgBouncer** (transaction mode) con `max: 2`. PgBouncer acepta hasta 1000 clientes y los multiplexa sobre 70 conexiones reales.
- **Implicaciones del transaction mode.** No hay estado de sesión: el tenant se fija con `set_config('app.tenant_id', $1, true)` (equivalente a `SET LOCAL`) dentro de la tx, y no se usan advisory locks de sesión ni `LISTEN`. Con los prepared statements, usamos `pg` con sentencias sin nombre, que no tienen problema (además, el PgBouncer gestionado tiene `max_prepared_statements=300`). Prisma necesitaría `pgbouncer=true`.
- **Conexiones del worker.** El worker, de larga vida, va **directo** por red privada, sin pooler, con un pool fijo de 5 por réplica. Las migraciones también van directas, porque usan un advisory lock de sesión.
- **Presupuesto.** `max_connections` ≥ 70 (PgBouncer) + N workers × 5 + reserva de administración.

**4. GDPR — borrado de un Embajador.**
- **Encaje legal.** Se ejecuta como job idempotente (`erasure_requests`) a petición del tenant, que es el responsable.
- **Tokens.** Se revocan en el proveedor y se borra la fila. Con DEK por Embajador (siguiente paso de A.2.1), borrar la DEK deja ilegible cualquier copia en backups.
- **Posts en cola.** Se cancelan y se borran.
- **Posts publicados.** Se borra el contenido y la media, y se conserva una fila mínima sin PII (`id`, `tenant_id`, `published_at`) para la facturación por uso. El dato contable, facturas del tenant que se conservan 6 años (art. 30 Código de Comercio), es de la empresa y no del Embajador.
- **Anonimización.** La fila del Embajador se anonimiza (nombre a `NULL`, handle a un hash) para mantener la integridad referencial. `post_events` y `dead_letters` solo guardan IDs y códigos.
- **Contenido en la red social.** Lo publicado allí está en la cuenta del propio Embajador. Si lo pide, se borra vía API **antes** de revocar el token.
- **Rastros:**
  - **Logs:** no contienen PII por diseño (solo IDs; nunca contenido ni tokens) y caducan a 30 días.
  - **Cachés:** no hay caché de datos del tenant; la API responde dinámica, sin caché de CDN.
  - **Backups:** el PITR caduca a los 14 días, y una **lista de supresión** (IDs borrados) se reaplica tras cualquier restore.
- **Prueba.** Se guarda un registro de auditoría sin PII (id de solicitud y fecha).

---

## B. Despliegue y operación

### B.1 — Topología de despliegue y capa asíncrona

- **App Next.js.** Vercel, funciones en `fra1`, con TLS automático y HSTS. Las variables de entorno van por entorno (Production y Preview en Vercel); los secretos se marcan *sensitive* (no se pueden leer de vuelta) y las previews no reciben los de producción. Nada en el repo: `.env.example` solo documenta nombres.
- **Worker de larga vida en Railway.** Contenedor `node` del mismo `Dockerfile` (`APP_ROLE=worker`), en la misma red privada que Postgres. No puede ser una función de Next.js por varias razones:
  - Las funciones tienen timeout y cold start.
  - Vercel Cron tiene una granularidad de ≥ 1 min.
  - No conservan el estado del throttling entre invocaciones.
  - Cada invocación abriría conexiones nuevas.

  El proceso de larga vida mantiene un pool fijo, trabaja con leases y hace un *drain* ordenado con SIGTERM: deja de reclamar, termina lo que tiene en vuelo y cierra el pool. El mock también es un servicio de Railway (`APP_ROLE=mock`), y el worker lo llama por red privada.
- **Cola + DLQ en Postgres.** El estado del post *es* el job, así que el claim y la transición de estado son atómicos, sin *dual write*. Los 90 días de antelación son nativos (`scheduled_at`) y la cola se audita con SQL. La DLQ está formada por los `failed` más `dead_letters`, que guarda el código de error y los intentos. El límite (cientos a miles de claims/s) sobra para 50×.
- **Postgres.** Railway Postgres en `europe-west4`, con volumen cifrado en reposo y TLS en el proxy público. Delante va un **PgBouncer** gestionado (transaction mode) para la app. Los backups son los de Railway; en producción, PITR (`railway postgres pitr enable`) y HA (`railway postgres ha`, 3 nodos). Hay un rol de BD por proceso: `ploot_app` (sin `BYPASSRLS`), `ploot_worker` y el admin solo para migraciones.
- **Secretos.**
  - Viven en variables por servicio: selladas en Railway y *sensitive* en Vercel. Cada proceso ve solo los suyos: la clave de cifrado de tokens existe únicamente en el worker.
  - **Sin identidad de workload en Railway** (hueco declarado en A.1): las credenciales son estáticas, se rotan con dos usuarios alternos y viven solo en el host, nunca en el repo ni en el state.
  - El repo pasa `gitleaks` en CI sobre todo el historial.

### B.2 — CI/CD y observabilidad

**1. Forma del pipeline** (`.github/workflows/ci.yml` y despliegues por Git).
- **En cada PR.** Se ejecutan:
  - typecheck;
  - tests de integración contra un Postgres de servicio (concurrencia con N workers, crash, RLS, DST, idempotencia y errores);
  - `gitleaks`;
  - build de la imagen.

  Además, Vercel crea un preview deploy por PR, y lo ideal es un entorno efímero de Railway por PR (PR environments) con su propia BD.
- **Al mergear a `main`.** Se publica la imagen en GHCR con tag del SHA y `latest` (la usa `docker compose`). Se ejecuta *una vez* el job de migraciones (solo *expand*). Se despliega en staging y se pasa un smoke e2e: crear un post, publicarlo contra el mock y verificar `published`.
- **Paso a producción.** Usa un GitHub Environment con **aprobación manual**. Lo bloquean cualquier check en rojo, una migración fallida o un smoke fallido.
- **Rollback automático.** Durante 15 min tras el deploy se vigilan tres señales: la tasa de publicación exitosa (si cae más de 5 puntos frente a la línea base), los 5xx de la API (si superan el 2 %) y el p95 (si supera 4 s). Si alguna salta, se hace *instant rollback* en Vercel y se redespliega en Railway la imagen anterior. Es seguro porque las migraciones son siempre compatibles con la versión anterior.

**2. Migraciones.**
- **Una sola vez.** Nunca se ejecutan al arrancar la app (N instancias competirían). Las corre un único job one-shot (`npm run db:migrate`; en compose, el servicio `migrate`), protegido con `pg_advisory_lock` y `lock_timeout`. Usa conexión directa, no PgBouncer, porque el advisory lock es de sesión.
- **Expand/contract.**
  - **Release N:** añade columnas nullable, tablas nuevas e índices `CONCURRENTLY`.
  - **Release N+1:** escribe en ambos esquemas y lee del nuevo; el backfill se hace por lotes desde el worker.
  - **Release N+2:** hace el *contract* (DROP), solo cuando ya no puede volver una versión anterior a N+1.
- **Regla.** Toda migración es compatible con el código anterior, así que un rollback de Vercel nunca encuentra un esquema incompatible.

**3. Golden signals + negocio.**
- **Latencia:** p95 de la API (SLO < 4 s) y latencia de la llamada al proveedor (`latency_ms` en el log `post published`).
- **Tráfico:** req/s y claims/s.
- **Errores:** 5xx de la API y `outcome` del worker por código (`PROVIDER_5XX`, `TOKEN_REVOKED`…).
- **Saturación:** conexiones de BD y de PgBouncer, posts en vuelo frente al cap global y **consumo del bucket de app** (`queue_stats` cada 15 s: `due`, `inflight`, `oldest_due_lag_s`, `paused_ambassadors`, `app_paused`).
- **Negocio:** **lag de publicación** (`published_at − scheduled_at`, p95, y `oldest_due_lag_s`), más la tasa de éxito por tenant.

**Pagina a un humano:**
- lag p95 > 10 min sostenido, porque la promesa del producto está rota y el cliente lo ve;
- `app_paused` (429 de app) > 5 min o tasa de 429 > umbral, porque hay riesgo de ban, que es irreversible;
- conexiones de BD > 90 %, porque precede a una caída total.

**Solo abre ticket:**
- caída de éxito de *un* tenant (normalmente tokens; se resuelve en horario laboral);
- p95 > 4 s;
- 5xx del proveedor absorbidos por los reintentos;
- crecimiento de la DLQ.

Criterio: se pagina solo por síntomas que dañan al usuario o a sus cuentas *ahora* y que necesitan a un humano.

**4. Tracing distribuido.** Se usa W3C `traceparent`.
- **Route Handler → cola.** Como la cola es una tabla, el contexto viaja **como dato**: el Route Handler acepta el `traceparent` entrante (o genera un `trace_id`) y lo guarda en la fila del post (`posts.trace_id`).
- **Cola → worker.** El worker lo lee al reclamar y lo incluye en todos sus logs. Al instrumentar con OpenTelemetry, el span del worker se crea con **link** al original, no como hijo: el post puede ejecutarse 90 días después.
- **Worker → proveedor.** El worker propaga un `traceparent` nuevo con el mismo `trace_id` en la llamada HTTP y registra el `external_id` devuelto.
- **Claves de correlación.** `post_id` es la clave estable en logs y en la tabla `post_events`.

### B.3 — Seguridad

**1. Inventario de secretos.**

| Secreto | Dónde vive | Rotación |
|---|---|---|
| Token OAuth por Embajador | Postgres, cifrado AES-256-GCM; solo lo descifra el worker | El access token rota solo vía refresh. Para la clave maestra: `key_version` + re-cifrado por lotes desde el worker |
| Client secret del proveedor | Variable sellada del worker en Railway | Se crea un segundo secret en el proveedor, se actualiza la variable (redeploy sin downtime) y se revoca el antiguo. Cada 90 días o ante incidente |
| Credenciales de BD | Variables: `ploot_app` en Vercel (*sensitive*), `ploot_worker` en Railway (sellada); admin solo en el job de migraciones | Usuarios alternos: se crea la nueva contraseña o usuario, se despliega y se invalida la anterior. Cada 90 días |
| Clave maestra de cifrado | Variable sellada del worker | Anual o ante incidente, vía `key_version` |
| Clave de firma JWT | Variable *sensitive* en Vercel | Solapamiento de dos claves (`kid`) durante la rotación |

**Riesgo de las variables de entorno en el host:**
- son visibles para cualquiera con permisos sobre el proyecto (dashboard y `vercel env pull`), salvo las *sensitive*/selladas;
- se heredan en previews si no se separan por entorno, así que una rama maliciosa podría exfiltrarlas;
- pueden acabar en logs si se serializa `process.env`;
- un prefijo `NEXT_PUBLIC_` por error las mete en el bundle del cliente;
- son estáticas y tienden a no rotarse nunca.

Mitigación: secretos marcados como *sensitive*/sellados, scopes por entorno, cada proceso solo con lo suyo, y logs que nunca vuelcan configuración.

**2. Sin credenciales permanentes de producción.** Nadie tiene un usuario de BD de producción.
- **Acceso JIT.** Se pide con un comando (`ops db-access --incident INC-123`) vía SSO.
  - El on-call con incidente abierto se auto-aprueba; fuera de incidente hace falta una segunda persona.
  - El comando crea un rol temporal `jit_<user>` con `VALID UNTIL now()+1h`, de solo lectura y sin acceso a `oauth_credentials` (los mismos `GRANT` por columna que la app).
- **Escritura.** Requiere *four-eyes*.
- **Auditoría.** Todo queda registrado con `pgaudit`.
- **Tiempo.** Son unos 2 min. El acceso al proyecto de Railway se limita a 2 personas con 2FA.

**3. Tres controles diferidos 6 meses:**
1. **KMS/HSM e identidad de workload** (mover worker y claves a AWS). Lo compensamos con variables selladas, aislamiento por servicio y rotación con `key_version`. Disparador: la exigencia de un cliente enterprise.
2. **Red privada hacia la BD desde Vercel** (hoy, proxy TCP público con TLS). La compensamos con TLS, un rol de mínimo privilegio con RLS y credenciales rotadas.
3. **Certificación SOC 2 / ISO 27001.** Cuesta meses de proceso y 20–50k € de auditoría. Aplicamos las prácticas sin la auditoría hasta que un deal enterprise la exija.

Diferirlos es correcto porque el riesgo residual es bajo, hay controles compensatorios y para un equipo pequeño cada uno cuesta semanas que hoy deben ir al producto.
