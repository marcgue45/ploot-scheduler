import { authenticate } from "../../../../server/auth";
import { listDeadLetters } from "../../../../server/dead-letters";
import { handle } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(req, async () => Response.json(await listDeadLetters(await authenticate(req))));
}
