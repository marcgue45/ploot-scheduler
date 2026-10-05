"use client";
// UI mínima de demostración: una ventana al backend (el diseño no se evalúa).
import { useCallback, useEffect, useState } from "react";

type Demo = { label: string; tenant: string; profile_id: string; token: string };
type Post = {
  id: string; ambassador_name: string; content: string; status: string; scheduled_at: string | null; attempts: number;
  next_attempt_at: string | null; external_id: string | null; error: { code: string; message: string } | null;
  waiting: { reason: string; until?: string; after_error?: string } | null; updated_at: string;
};

const COLORS: Record<string, string> = {
  draft: "#999", scheduled: "#2563eb", publishing: "#d97706", published: "#16a34a", failed: "#dc2626", cancelled: "#6b7280",
};
const fmt = (iso: string | null | undefined) =>
  !iso ? "—" : iso === "infinity" ? "indefinido" : new Date(iso).toLocaleString("es-ES", { timeZone: "Europe/Madrid" });

function waitingText(w: Post["waiting"]) {
  if (!w) return "";
  switch (w.reason) {
    case "RATE_LIMITED": return `⏸ 429 del proveedor: espera Retry-After hasta ${fmt(w.until)}`;
    case "TOKEN_REVOKED": return "⛔ token revocado: requiere reconexión";
    case "BACKOFF": return `↻ backoff tras ${w.after_error}: reintento ${fmt(w.until)}`;
    case "SCHEDULED": return `🕒 programado para ${fmt(w.until)}`;
    case "QUEUED": return "⏳ vencido, en cola (throttle / turno justo)";
    default: return `${w.reason} hasta ${fmt(w.until)}`;
  }
}

export default function Page() {
  const [demos, setDemos] = useState<Demo[]>([]);
  const [token, setToken] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [diag, setDiag] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [content, setContent] = useState("");
  const [local, setLocal] = useState("");
  const [asDraft, setAsDraft] = useState(false);

  const current = demos.find((d) => d.token === token);
  const api = useCallback(
    (path: string, init: RequestInit = {}) =>
      fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
    [token],
  );

  useEffect(() => {
    fetch("/api/demo/tokens").then((r) => (r.ok ? r.json() : { items: [] })).then((d) => {
      setDemos(d.items);
      if (d.items[0]) setToken(d.items[0].token);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    const r = await api("/api/v1/posts?limit=50");
    if (r.ok) setPosts((await r.json()).items);
    if (current) {
      const d = await api(`/api/v1/ambassadors/${current.profile_id}`);
      if (d.ok) setDiag(await d.json());
    }
  }, [api, token, current]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000); // polling simple
    return () => clearInterval(t);
  }, [refresh]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: any = { content, status: asDraft ? "draft" : "scheduled", timezone: "Europe/Madrid" };
    if (!asDraft) body.local_time = local || new Date(Date.now() + 60_000).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).slice(0, 16).replace(" ", "T");
    const r = await api("/api/v1/posts", { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    setMsg(r.ok ? `Creado ${j.id.slice(0, 8)} (${j.status})` : `Error ${r.status}: ${j.error?.code} — ${j.error?.message}`);
    if (r.ok) setContent("");
    refresh();
  }

  async function publishNow(id: string) {
    const r = await api(`/api/v1/posts/${id}/publish`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
    const j = await r.json();
    setMsg(r.ok ? `Publicación encolada (${r.status})` : `Error ${r.status}: ${j.error?.code}`);
    refresh();
  }

  async function cancel(id: string) {
    const r = await api(`/api/v1/posts/${id}`, { method: "DELETE" });
    const j = await r.json();
    setMsg(r.ok ? "Cancelado" : `Error ${r.status}: ${j.error?.code}`);
    refresh();
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20 }}>Ploot · scheduler (demo backend)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Cada perfil es un JWT distinto (tenant_id + profile_id). La lista solo muestra posts del tenant del JWT: lo filtra Postgres (RLS).
      </p>
      <label>
        Perfil:{" "}
        <select value={token} onChange={(e) => setToken(e.target.value)}>
          {demos.map((d) => <option key={d.profile_id} value={d.token}>{d.label}</option>)}
        </select>
      </label>

      <form onSubmit={create} style={{ margin: "12px 0", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Contenido del post" required style={{ flex: 1, minWidth: 240, padding: 6 }} />
        <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} title="Hora local Europe/Madrid (vacío = +1 min)" />
        <label><input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} /> borrador</label>
        <button type="submit">Crear / programar</button>
        <span style={{ fontSize: 13 }}>{msg}</span>
      </form>

      {diag && (
        <section style={{ background: "#fff", border: "1px solid #ddd", padding: 10, marginBottom: 12, fontSize: 13 }}>
          <b>¿Por qué va atrasado {diag.ambassador.display_name}?</b> token: {diag.token.status} · vencidos: {diag.queue.due} · en vuelo: {diag.queue.in_flight} · lag: {diag.queue.lag_seconds}s
          <ul style={{ margin: "4px 0" }}>{diag.diagnosis.map((d: string) => <li key={d}>{d}</li>)}</ul>
        </section>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
            <th>Estado</th><th>Embajador</th><th>Contenido</th><th>Programado (Madrid)</th><th>Intentos</th><th>Por qué</th><th></th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
              <td><b style={{ color: COLORS[p.status] }}>{p.status}</b></td>
              <td>{p.ambassador_name}</td>
              <td style={{ maxWidth: 300 }}>{p.content}</td>
              <td>{fmt(p.scheduled_at)}</td>
              <td>{p.attempts}</td>
              <td>
                {p.error && <div style={{ color: p.status === "failed" ? "#dc2626" : "#b45309" }}><code>{p.error.code}</code> {p.error.message}</div>}
                <div>{waitingText(p.waiting)}</div>
                {p.external_id && <div style={{ color: "#16a34a" }}>external_id: <code>{p.external_id}</code></div>}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {["draft", "scheduled", "failed"].includes(p.status) && <button onClick={() => publishNow(p.id)}>Publicar ahora</button>}{" "}
                {["draft", "scheduled", "failed"].includes(p.status) && <button onClick={() => cancel(p.id)}>Cancelar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
