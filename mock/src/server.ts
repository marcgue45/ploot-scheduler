/**
 * Mock del proveedor externo (red social). Servicio aparte: el worker lo llama como a
 * cualquier integración HTTP. Sin estado persistente salvo idempotencia en memoria.
 *
 * Contrato:
 *   POST /provider/publish        Authorization: Bearer <access_token>, Idempotency-Key, body {content}
 *     200 {id} | 401 {error} | 429 + Retry-After (+ X-RateLimit-Scope: user|app) | 5xx
 *   POST /provider/oauth/refresh  body {refresh_token}
 *     200 {access_token, refresh_token, expires_in} | 400 {error:"invalid_grant"} | 5xx
 *
 * Tokens (formato abierto, es un mock):
 *   access  = at:<subject>:<expEpochSeconds>   -> expirado si exp < now
 *   refresh = rt:<subject>:ok | rt:<subject>:revoked
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface MockOptions {
  latencyMaxMs: number;
  fail5xxRate: number;
  random429Rate: number;
  userMinIntervalMs: number; // límite duro por usuario
  appMaxPerMinute: number; // límite duro por app (todos los Embajadores)
  accessTtlSeconds: number;
  random?: () => number;
}

const fromEnv = (): MockOptions => ({
  latencyMaxMs: Number(process.env.MOCK_LATENCY_MAX_MS ?? 3000),
  fail5xxRate: Number(process.env.MOCK_5XX_RATE ?? 0.1),
  random429Rate: Number(process.env.MOCK_429_RATE ?? 0.05),
  userMinIntervalMs: Number(process.env.MOCK_USER_MIN_INTERVAL_MS ?? 5000),
  appMaxPerMinute: Number(process.env.MOCK_APP_MAX_PER_MINUTE ?? 120),
  accessTtlSeconds: Number(process.env.MOCK_ACCESS_TTL_SECONDS ?? 3600),
});

export interface MockStats {
  publishedTotal: number;
  /** Publicaciones reales por Idempotency-Key: >1 sería una doble publicación. */
  publishesByKey: Map<string, number>;
  requests: number;
}

export function createMockServer(partial: Partial<MockOptions> = {}): { server: Server; stats: MockStats } {
  const opts = { ...fromEnv(), ...partial };
  const rnd = opts.random ?? Math.random;
  const stats: MockStats = { publishedTotal: 0, publishesByKey: new Map(), requests: 0 };
  const idem = new Map<string, { id: string }>(); // subject:key -> respuesta
  const lastPublishBySubject = new Map<string, number>();
  let appWindow: number[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return null;
    }
  };

  const server = createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url ?? "/", "http://mock");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/provider/_stats") {
      return send(res, 200, { published_total: stats.publishedTotal, requests: stats.requests });
    }

    await sleep(rnd() * opts.latencyMaxMs);

    if (req.method === "POST" && url.pathname === "/provider/oauth/refresh") {
      const body = await readJson(req);
      const parts = String(body?.refresh_token ?? "").split(":");
      if (parts.length !== 3 || parts[0] !== "rt") return send(res, 400, { error: "invalid_request" });
      if (rnd() < opts.fail5xxRate) return send(res, 503, { error: "unavailable" });
      if (parts[2] === "revoked") return send(res, 400, { error: "invalid_grant" });
      const exp = Math.floor(Date.now() / 1000) + opts.accessTtlSeconds;
      return send(res, 200, { access_token: `at:${parts[1]}:${exp}`, refresh_token: body.refresh_token, expires_in: opts.accessTtlSeconds });
    }

    if (req.method === "POST" && url.pathname === "/provider/publish") {
      const auth = req.headers.authorization ?? "";
      const [, subject, expRaw] = auth.replace(/^Bearer /, "").split(":");
      if (!auth.startsWith("Bearer at:") || !subject || !expRaw) return send(res, 401, { error: "invalid_token" });
      if (Number(expRaw) * 1000 < Date.now()) return send(res, 401, { error: "token_expired" });
      const body = await readJson(req);
      if (!body || typeof body.content !== "string" || body.content.length === 0) return send(res, 422, { error: "invalid_content" });

      const key = req.headers["idempotency-key"];
      const idemKey = typeof key === "string" ? `${subject}:${key}` : null;
      if (idemKey && idem.has(idemKey)) return send(res, 200, idem.get(idemKey), { "idempotent-replayed": "true" });

      const now = Date.now();
      appWindow = appWindow.filter((t) => now - t < 60_000);
      if (appWindow.length >= opts.appMaxPerMinute) {
        const retry = Math.ceil((60_000 - (now - appWindow[0])) / 1000);
        return send(res, 429, { error: "app_rate_limited" }, { "retry-after": String(retry), "x-ratelimit-scope": "app" });
      }
      const last = lastPublishBySubject.get(subject);
      if (last !== undefined && now - last < opts.userMinIntervalMs) {
        const retry = Math.ceil((opts.userMinIntervalMs - (now - last)) / 1000);
        return send(res, 429, { error: "user_rate_limited" }, { "retry-after": String(retry), "x-ratelimit-scope": "user" });
      }
      if (rnd() < opts.random429Rate) {
        return send(res, 429, { error: "user_rate_limited" }, { "retry-after": String(1 + Math.floor(rnd() * 10)), "x-ratelimit-scope": "user" });
      }
      if (rnd() < opts.fail5xxRate) return send(res, rnd() < 0.5 ? 500 : 503, { error: "internal" });

      const result = { id: `ext_${randomUUID()}` };
      if (idemKey) {
        idem.set(idemKey, result);
        stats.publishesByKey.set(idemKey, (stats.publishesByKey.get(idemKey) ?? 0) + 1);
      }
      stats.publishedTotal++;
      lastPublishBySubject.set(subject, now);
      appWindow.push(now);
      return send(res, 200, result);
    }

    send(res, 404, { error: "not_found" });
  });
  return { server, stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 4000);
  createMockServer().server.listen(port, () => console.log(JSON.stringify({ service: "mock", msg: `listening on ${port}` })));
}
