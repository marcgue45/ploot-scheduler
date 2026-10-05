/** Requisito duro 4: aislamiento de tenant en la capa de query (RLS), no en el Route Handler. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../shared/src/index";
import { adminPool, appPool, bearer, makeAmbassador, makePost, makeTenant, resetDb } from "./helpers";

const admin = adminPool();
const app = appPool();
afterAll(async () => {
  await admin.end();
  await app.end();
});

let tA: string, tB: string, ambA: string, ambB: string, postA: string, postB: string;
beforeEach(async () => {
  await resetDb(admin);
  tA = await makeTenant(admin, "A");
  tB = await makeTenant(admin, "B");
  ambA = await makeAmbassador(admin, tA);
  ambB = await makeAmbassador(admin, tB);
  postA = await makePost(admin, tA, ambA, { minutesFromNow: 30 });
  postB = await makePost(admin, tB, ambB, { minutesFromNow: 30 });
});

describe("nivel SQL (rol ploot_app, sin BYPASSRLS)", () => {
  it("el tenant A no ve, ni modifica, ni crea filas del tenant B aunque conozca el id", async () => {
    await withTenant(app, tA, async (c) => {
      expect((await c.query("SELECT id FROM posts WHERE id = $1", [postB])).rowCount).toBe(0);
      expect((await c.query("UPDATE posts SET content = 'hacked' WHERE id = $1", [postB])).rowCount).toBe(0);
      const all = (await c.query("SELECT DISTINCT tenant_id FROM posts")).rows.map((r) => r.tenant_id);
      expect(all).toEqual([tA]);
    });
    // INSERT con tenant_id ajeno: lo rechaza la política WITH CHECK.
    await expect(
      withTenant(app, tA, (c) => c.query("INSERT INTO posts (tenant_id, ambassador_id, content, status) VALUES ($1, $2, 'x', 'draft')", [tB, ambB])),
    ).rejects.toMatchObject({ code: "42501" });
    // Mover un post propio a otro tenant tampoco.
    await expect(withTenant(app, tA, (c) => c.query("UPDATE posts SET tenant_id = $1 WHERE id = $2", [tB, postA]))).rejects.toMatchObject({ code: "42501" });
    expect((await admin.query("SELECT content FROM posts WHERE id = $1", [postB])).rows[0].content).toBe("hola");
  });

  it("sin tenant en la transacción no se ve nada (fail closed)", async () => {
    expect((await app.query("SELECT id FROM posts")).rowCount).toBe(0);
  });

  it("la app no puede leer los tokens cifrados (GRANT por columna)", async () => {
    await expect(withTenant(app, tA, (c) => c.query("SELECT access_token_ct FROM oauth_credentials"))).rejects.toMatchObject({ code: "42501" });
    await withTenant(app, tA, async (c) => {
      expect((await c.query("SELECT status FROM oauth_credentials")).rowCount).toBe(1);
    });
  });
});

describe("nivel API", () => {
  it("PATCH / DELETE / publish cross-tenant devuelven 404 y no tocan el post", async () => {
    const item = await import("../app/src/app/api/v1/posts/[id]/route");
    const publish = await import("../app/src/app/api/v1/posts/[id]/publish/route");
    const auth = await bearer(tA, ambA);
    const ctx = { params: Promise.resolve({ id: postB }) };
    const patch = await item.PATCH(new Request(`http://x/api/v1/posts/${postB}`, { method: "PATCH", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ content: "hacked" }) }), ctx);
    expect(patch.status).toBe(404);
    const del = await item.DELETE(new Request(`http://x/api/v1/posts/${postB}`, { method: "DELETE", headers: { authorization: auth } }), ctx);
    expect(del.status).toBe(404);
    const pub = await publish.POST(new Request(`http://x/api/v1/posts/${postB}/publish`, { method: "POST", headers: { authorization: auth, "idempotency-key": "k1" } }), ctx);
    expect(pub.status).toBe(404);
    expect((await admin.query("SELECT content, status FROM posts WHERE id = $1", [postB])).rows[0]).toEqual({ content: "hola", status: "scheduled" });
  });

  it("crear un post para un Embajador de otro tenant falla (FK compuesta + tenant de la tx)", async () => {
    const list = await import("../app/src/app/api/v1/posts/route");
    const res = await list.POST(
      new Request("http://x/api/v1/posts", { method: "POST", headers: { authorization: await bearer(tA, ambA), "content-type": "application/json" }, body: JSON.stringify({ content: "x", ambassador_id: ambB }) }),
    );
    expect(res.status).toBe(404);
  });

  it("GET /posts solo lista el tenant del JWT", async () => {
    const list = await import("../app/src/app/api/v1/posts/route");
    const res = await list.GET(new Request("http://x/api/v1/posts", { headers: { authorization: await bearer(tB, ambB) } }));
    const body = await res.json();
    expect(body.items.map((p: any) => p.id)).toEqual([postB]);
  });
});
