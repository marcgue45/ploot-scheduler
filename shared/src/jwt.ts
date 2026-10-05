import { SignJWT, jwtVerify } from "jose";

const ISSUER = "ploot-demo";
const AUDIENCE = "ploot-api";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthContext {
  tenantId: string;
  profileId: string;
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error("JWT_SECRET no configurado (mín. 32 caracteres)");
  return new TextEncoder().encode(s);
}

export async function signJwt(ctx: AuthContext, ttl = "30d"): Promise<string> {
  return new SignJWT({ tenant_id: ctx.tenantId, profile_id: ctx.profileId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ctx.profileId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

export async function verifyJwt(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
  const tenantId = payload.tenant_id;
  const profileId = payload.profile_id;
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId) || typeof profileId !== "string" || !UUID_RE.test(profileId)) {
    throw new Error("claims tenant_id/profile_id inválidos");
  }
  return { tenantId, profileId };
}
