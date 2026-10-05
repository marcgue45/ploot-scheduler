import { authenticate } from "../../../../server/auth";
import { listAmbassadors } from "../../../../server/ambassadors";
import { handle } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(req, async () => Response.json(await listAmbassadors(await authenticate(req))));
}
