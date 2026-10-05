import { authenticate } from "../../../../../server/auth";
import { ambassadorStatus } from "../../../../../server/ambassadors";
import { assertUuid, handle } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Diagnóstico: ¿por qué va atrasado este Embajador? */
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await ambassadorStatus(auth, assertUuid((await ctx.params).id, "Embajador")));
  });
}
