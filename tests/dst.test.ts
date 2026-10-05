/** Requisito duro 5: corrección DST en Europe/Madrid. */
import { describe, expect, it } from "vitest";
import { resolveLocalTime, ScheduleError } from "../shared/src/index";

const TZ = "Europe/Madrid";
const utc = (local: string) => resolveLocalTime(local, TZ).toISOString();

describe("Europe/Madrid", () => {
  it("09:00 local es 08:00Z en invierno (CET, +01) y 07:00Z en verano (CEST, +02)", () => {
    expect(utc("2026-03-28T09:00")).toBe("2026-03-28T08:00:00.000Z"); // sábado antes del cambio
    expect(utc("2026-03-30T09:00")).toBe("2026-03-30T07:00:00.000Z"); // lunes después
    expect(utc("2026-10-24T09:00")).toBe("2026-10-24T07:00:00.000Z");
    expect(utc("2026-10-26T09:00")).toBe("2026-10-26T08:00:00.000Z");
  });

  it("primavera: 02:30 del 29-mar-2026 no existe y se rechaza (no se mueve en silencio)", () => {
    expect(() => resolveLocalTime("2026-03-29T02:30", TZ)).toThrow(ScheduleError);
    try {
      resolveLocalTime("2026-03-29T02:30", TZ);
    } catch (e) {
      expect((e as ScheduleError).code).toBe("NONEXISTENT_LOCAL_TIME");
    }
    // Los bordes sí existen.
    expect(utc("2026-03-29T01:59")).toBe("2026-03-29T00:59:00.000Z");
    expect(utc("2026-03-29T03:00")).toBe("2026-03-29T01:00:00.000Z");
  });

  it("otoño: 02:30 del 25-oct-2026 ocurre dos veces; se elige la primera (+02)", () => {
    expect(utc("2026-10-25T02:30")).toBe("2026-10-25T00:30:00.000Z");
    expect(utc("2026-10-25T03:00")).toBe("2026-10-25T02:00:00.000Z");
    expect(utc("2026-10-25T01:59")).toBe("2026-10-24T23:59:00.000Z");
  });

  it("la misma hora local cruzando el cambio no se desplaza una hora", () => {
    const before = resolveLocalTime("2026-10-24T09:00", TZ).getTime();
    const after = resolveLocalTime("2026-10-25T09:00", TZ).getTime();
    expect(after - before).toBe(25 * 3600_000); // el día del cambio dura 25 h
  });

  it("valida zona y fecha", () => {
    expect(() => resolveLocalTime("2026-02-30T10:00", TZ)).toThrow(/inválida/);
    expect(() => resolveLocalTime("2026-01-01T10:00", "Mars/Olympus")).toThrow(/Zona/);
  });
});
