import { authenticate } from "../../../../../../server/auth";
import { assertUuid, handle } from "../../../../../../server/http";
import { publishNow } from "../../../../../../server/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    const id = assertUuid((await ctx.params).id);
    const r = await publishNow(auth, id, req.headers.get("idempotency-key"));
    return Response.json(r.body, { status: r.status, headers: r.replayed ? { "idempotent-replayed": "true" } : {} });
  });
}
