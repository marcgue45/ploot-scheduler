import type { AuthContext } from "@ploot/shared";
import { tenantTx } from "./db";
import { ApiError } from "./http";

/** DLQ del tenant (RLS): posts que agotaron reintentos o fallaron de forma permanente, sin reprocesar. */
export async function listDeadLetters(auth: AuthContext) {
  return tenantTx(auth, async (c) => {
    const res = await c.query(
      `SELECT d.id, d.post_id, d.ambassador_id, d.error_code, d.error_message, d.attempts, d.created_at, p.status AS post_status
       FROM dead_letters d JOIN posts p ON p.id = d.post_id
       WHERE d.replayed_at IS NULL
       ORDER BY d.created_at DESC
       LIMIT 50`,
    );
    return { items: res.rows };
  });
}

/**
 * Replay: reencola el post de una fila de DLQ (failed -> scheduled ahora, intentos a 0).
 * Una fila solo se reprocesa una vez (FOR UPDATE + replayed_at). Si la causa fue un token revocado
 * y sigue revocado, se rechaza: reencolar solo volvería a fallar contra el proveedor.
 */
export async function replayDeadLetter(auth: AuthContext, deadLetterId: number) {
  return tenantTx(auth, async (c) => {
    const dl = (
      await c.query(
        `SELECT d.id, d.post_id, d.ambassador_id, d.error_code, d.replayed_at, p.status AS post_status
         FROM dead_letters d JOIN posts p ON p.id = d.post_id
         WHERE d.id = $1 FOR UPDATE OF d, p`,
        [deadLetterId],
      )
    ).rows[0];
    if (!dl) throw new ApiError(404, "NOT_FOUND", "entrada de DLQ no encontrada");
    if (dl.replayed_at) throw new ApiError(409, "ALREADY_REPLAYED", `Ya se reprocesó el ${dl.replayed_at}`);
    if (dl.post_status !== "failed") throw new ApiError(409, "POST_NOT_FAILED", `El post está en estado ${dl.post_status}`);
    if (dl.error_code === "TOKEN_REVOKED") {
      const cred = (await c.query(`SELECT status FROM oauth_credentials WHERE ambassador_id = $1`, [dl.ambassador_id])).rows[0];
      if (!cred || cred.status === "revoked") {
        throw new ApiError(409, "TOKEN_STILL_REVOKED", "El Embajador debe reconectar su cuenta antes de reprocesar");
      }
    }
    await c.query(
      `UPDATE posts SET status = 'scheduled', scheduled_at = now(), run_at = now(), attempts = 0,
              last_error_code = NULL, last_error_message = NULL, updated_at = now()
       WHERE id = $1`,
      [dl.post_id],
    );
    await c.query(`UPDATE dead_letters SET replayed_at = now(), replayed_by = $2 WHERE id = $1`, [dl.id, `profile:${auth.profileId}`]);
    await c.query(
      `INSERT INTO post_events (post_id, ambassador_id, from_status, to_status, code, actor) VALUES ($1, $2, 'failed', 'scheduled', 'DLQ_REPLAY', $3)`,
      [dl.post_id, dl.ambassador_id, `profile:${auth.profileId}`],
    );
    return { replayed: true, post_id: dl.post_id };
  });
}
