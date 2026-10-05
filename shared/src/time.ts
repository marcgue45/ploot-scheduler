import { IANAZone } from "luxon";

export class ScheduleError extends Error {
  constructor(public code: "INVALID_TIMEZONE" | "INVALID_LOCAL_TIME" | "NONEXISTENT_LOCAL_TIME", message: string) {
    super(message);
  }
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Convierte una hora local de pared ("2026-10-25T02:30") en una zona IANA a un instante UTC.
 * Política DST (explícita, no la del runtime):
 *  - Hora inexistente (salto de primavera, 02:00-03:00 en Madrid): se RECHAZA. Mover el post en
 *    silencio a otra hora sorprende al usuario; que elija él.
 *  - Hora ambigua (otoño, 02:00-03:00 ocurre dos veces): se elige la PRIMERA ocurrencia.
 */
export function resolveLocalTime(local: string, zone: string): Date {
  if (!IANAZone.isValidZone(zone)) throw new ScheduleError("INVALID_TIMEZONE", `Zona horaria inválida: ${zone}`);
  const m = LOCAL_RE.exec(local);
  if (!m) throw new ScheduleError("INVALID_LOCAL_TIME", "Formato esperado YYYY-MM-DDTHH:mm[:ss]");
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s); // la hora de pared leída como si fuese UTC
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new ScheduleError("INVALID_LOCAL_TIME", `Fecha inválida: ${local}`);
  }
  const z = IANAZone.create(zone);
  const DAY = 86_400_000;
  // Offsets posibles alrededor de esa fecha; un instante es válido si su offset real coincide.
  const offsets = new Set([z.offset(wall - DAY), z.offset(wall), z.offset(wall + DAY)]);
  const candidates = [...offsets]
    .map((off) => wall - off * 60_000)
    .filter((utc) => z.offset(utc) * 60_000 === wall - utc);
  if (candidates.length === 0) {
    throw new ScheduleError("NONEXISTENT_LOCAL_TIME", `${local} no existe en ${zone} (cambio de hora)`);
  }
  return new Date(Math.min(...candidates));
}
