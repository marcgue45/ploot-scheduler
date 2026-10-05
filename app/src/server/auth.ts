import { verifyJwt, type AuthContext } from "@ploot/shared";
import { ApiError } from "./http";

/** Solo autentica. La autorización por tenant NO vive aquí: la aplica Postgres (RLS). */
export async function authenticate(req: Request): Promise<AuthContext> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHENTICATED", "Falta el header Authorization: Bearer <jwt>");
  try {
    return await verifyJwt(header.slice(7));
  } catch {
    throw new ApiError(401, "UNAUTHENTICATED", "JWT inválido o expirado");
  }
}
