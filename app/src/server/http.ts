import { createLogger } from "@ploot/shared";

export const log = createLogger("api");

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(id: string, what = "post"): string {
  if (!UUID_RE.test(id)) throw new ApiError(404, "NOT_FOUND", `${what} no encontrado`);
  return id;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "El body no es JSON válido");
  }
}

/** Envuelve un handler: errores tipados -> JSON {error:{code,message}}; el resto -> 500 sin filtrar detalles. */
export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const started = Date.now();
  try {
    const res = await fn();
    log.info({ method: req.method, path: new URL(req.url).pathname, status: res.status, ms: Date.now() - started }, "request");
    return res;
  } catch (err) {
    if (err instanceof ApiError) {
      log.info({ method: req.method, path: new URL(req.url).pathname, status: err.status, code: err.code, ms: Date.now() - started }, "request");
      return Response.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
    }
    log.error({ err, method: req.method, path: new URL(req.url).pathname }, "unhandled error");
    return Response.json({ error: { code: "INTERNAL", message: "Error interno" } }, { status: 500 });
  }
}
