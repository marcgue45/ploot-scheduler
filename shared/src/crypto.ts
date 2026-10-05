import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Demo: una clave AES-256 desde env. Producción: DEK por Embajador envuelta por KMS (ver PDF A.2.1).
function key(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) throw new Error("TOKEN_ENC_KEY no configurada");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENC_KEY debe ser 32 bytes en base64");
  return k;
}

/** AES-256-GCM. AAD liga el ciphertext a su fila: copiarlo a otro Embajador no descifra. */
export function encryptToken(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptToken(blob: string, aad: string): string {
  if (!blob.startsWith("v1:")) throw new Error("formato de token cifrado desconocido");
  const buf = Buffer.from(blob.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export const tokenAad = (tenantId: string, ambassadorId: string) => `${tenantId}:${ambassadorId}`;
