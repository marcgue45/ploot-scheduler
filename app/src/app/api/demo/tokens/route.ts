import { DEMO, signJwt } from "@ploot/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SOLO DEMO (DEMO_MODE=true): emite JWTs de los perfiles del seed para que la UI pública funcione
 * sin IdP. Solo da acceso a datos de seed. En producción esta ruta devuelve 404.
 */
export async function GET() {
  if (process.env.DEMO_MODE !== "true") return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  const items = await Promise.all(
    Object.values(DEMO.ambassadors).map(async (a) => ({
      label: `${a.name} · ${DEMO.tenants[a.tenant].name}`,
      tenant: DEMO.tenants[a.tenant].name,
      profile_id: a.id,
      token: await signJwt({ tenantId: DEMO.tenants[a.tenant].id, profileId: a.id }, "12h"),
    })),
  );
  return Response.json({ items });
}
