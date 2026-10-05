import { authenticate } from "../../../../server/auth";
import { handle, readJson } from "../../../../server/http";
import { createPost, listPosts } from "../../../../server/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await createPost(auth, await readJson(req), req), { status: 201 });
  });
}

export function GET(req: Request) {
  return handle(req, async () => {
    const auth = await authenticate(req);
    return Response.json(await listPosts(auth, new URL(req.url).searchParams));
  });
}
