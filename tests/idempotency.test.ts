/** Requisito duro 3: idempotencia de POST /publish vía Idempotency-Key. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPool, bearer, makeAmbassador, makePost, makeTenant, resetDb } from "./helpers";

const admin = adminPool();
afterAll(() => admin.end());

let tenant: string, amb: string, post: string, auth: string;
beforeEach(async () => {
  await resetDb(admin);
  tenant = await makeTenant(admin);
  amb = await makeAmbassador(admin, tenant);
  post = await makePost(admin, tenant, amb, { status: "draft" });
  auth = await bearer(tenant, amb);
});

async function publish(id: string, key?: string) {
  const route = await import("../app/src/app/api/v1/posts/[id]/publish/route");
  const headers: Record<string, string> = { authorization: auth };
  if (key) headers["idempotency-key"] = key;
  return route.POST(new Request(`http://x/api/v1/posts/${id}/publish`, { method: "POST", headers }), { params: Promise.resolve({ id }) });
}

const publishNowEvents = async () => (await admin.query("SELECT count(*)::int AS n FROM post_events WHERE code = 'PUBLISH_NOW'")).rows[0].n;

describe("POST /posts/:id/publish", () => {
  it("la misma clave reproduce la misma respuesta sin repetir el efecto", async () => {
    const r1 = await publish(post, "key-1");
    const r2 = await publish(post, "key-1");
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(await r2.json()).toEqual(await r1.json());
    expect(await publishNowEvents()).toBe(1);
  });

  it("peticiones concurrentes con la misma clave: un solo efecto", async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => publish(post, "key-concurrent")));
    expect(rs.map((r) => r.status)).toEqual(Array(6).fill(202));
    expect(await publishNowEvents()).toBe(1);
  });

  it("reutilizar la clave para otro post -> 422", async () => {
    const other = await makePost(admin, tenant, amb, { status: "draft" });
    await publish(post, "key-2");
    const r = await publish(other, "key-2");
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("sin clave -> 400; post publicado -> 409", async () => {
    expect((await publish(post)).status).toBe(400);
    await admin.query("UPDATE posts SET status = 'published' WHERE id = $1", [post]);
    const r = await publish(post, "key-3");
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("POST_ALREADY_PUBLISHED");
  });
});
