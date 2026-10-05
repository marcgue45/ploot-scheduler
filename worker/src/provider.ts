/** Cliente HTTP del proveedor: traduce respuestas HTTP a resultados tipados (sin excepciones). */

export type PublishResult =
  | { kind: "ok"; externalId: string }
  | { kind: "rate_limited"; retryAfterS: number; scope: "user" | "app" }
  | { kind: "unauthorized"; reason: string }
  | { kind: "server_error"; status: number }
  | { kind: "timeout" }
  | { kind: "rejected"; status: number; reason: string };

export type RefreshResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "revoked" }
  | { kind: "rate_limited"; retryAfterS: number; scope: "user" | "app" }
  | { kind: "server_error"; status: number }
  | { kind: "timeout" };

/** Retry-After puede ser segundos o fecha HTTP. Acotado a [1s, 1h]; por defecto 30s. */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (!header) return 30;
  const secs = Number(header);
  const value = Number.isFinite(secs) ? secs : (Date.parse(header) - now) / 1000;
  if (!Number.isFinite(value)) return 30;
  return Math.min(3600, Math.max(1, Math.ceil(value)));
}

async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Response | "timeout"> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Timeout o error de red: resultado desconocido. Reintentar es seguro gracias al Idempotency-Key.
    return "timeout";
  }
}

const scopeOf = (res: Response): "user" | "app" => (res.headers.get("x-ratelimit-scope") === "app" ? "app" : "user");

export class ProviderClient {
  constructor(private baseUrl: string, private timeoutMs: number) {}

  async publish(accessToken: string, idempotencyKey: string, content: string, traceparent?: string): Promise<PublishResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    };
    if (traceparent) headers.traceparent = traceparent;
    const res = await call(`${this.baseUrl}/provider/publish`, { method: "POST", headers, body: JSON.stringify({ content }) }, this.timeoutMs);
    if (res === "timeout") return { kind: "timeout" };
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 200 && typeof body.id === "string") return { kind: "ok", externalId: body.id };
    if (res.status === 429) return { kind: "rate_limited", retryAfterS: parseRetryAfter(res.headers.get("retry-after")), scope: scopeOf(res) };
    if (res.status === 401) return { kind: "unauthorized", reason: String(body.error ?? "unauthorized") };
    if (res.status >= 500) return { kind: "server_error", status: res.status };
    return { kind: "rejected", status: res.status, reason: String(body.error ?? "rejected") };
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    const res = await call(
      `${this.baseUrl}/provider/oauth/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refreshToken }) },
      this.timeoutMs,
    );
    if (res === "timeout") return { kind: "timeout" };
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 200) {
      return { kind: "ok", accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken, expiresIn: Number(body.expires_in) };
    }
    if (res.status === 429) return { kind: "rate_limited", retryAfterS: parseRetryAfter(res.headers.get("retry-after")), scope: scopeOf(res) };
    if (res.status >= 500) return { kind: "server_error", status: res.status };
    // 400 invalid_grant / 401: el refresh token ya no vale -> irrecuperable.
    return { kind: "revoked" };
  }
}
