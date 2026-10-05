import { authenticate } from "../../../../../server/auth";
import { assertUuid, handle, readJson } from "../../../../../server/http";
import { cancelPost, getPost, updatePost } from "../../../../../server/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await getPost(auth, assertUuid((await ctx.params).id)));
  });
}

export function PATCH(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await updatePost(auth, assertUuid((await ctx.params).id), await readJson(req)));
  });
}

export function DELETE(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await cancelPost(auth, assertUuid((await ctx.params).id)));
  });
}
