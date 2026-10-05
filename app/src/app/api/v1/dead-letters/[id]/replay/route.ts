import { authenticate } from "../../../../../../server/auth";
import { replayDeadLetter } from "../../../../../../server/dead-letters";
import { ApiError, handle } from "../../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    const id = Number((await ctx.params).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(404, "NOT_FOUND", "entrada de DLQ no encontrada");
    return Response.json(await replayDeadLetter(auth, id), { status: 202 });
  });
}
