import pino from "pino";

/** Logs JSON estructurados. Nunca se loguea contenido de posts ni tokens: solo IDs (GDPR). */
export function createLogger(service: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Nivel como texto ("error", "warn"): lo entienden Railway/Vercel/Grafana para filtrar y alertar.
    formatters: { level: (label) => ({ level: label }) },
  });
}
export type Logger = ReturnType<typeof createLogger>;
