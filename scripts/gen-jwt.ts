/** Firma JWTs de prueba (tenant_id + profile_id) para dos tenants distintos: prueba de aislamiento. */
import { DEMO, signJwt } from "../shared/src/index";

const pairs = [DEMO.ambassadors.ana, DEMO.ambassadors.diego];
for (const a of pairs) {
  const token = await signJwt({ tenantId: DEMO.tenants[a.tenant].id, profileId: a.id });
  console.log(`# ${a.name} — tenant ${DEMO.tenants[a.tenant].name}\n${token}\n`);
}
