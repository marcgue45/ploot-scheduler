import pino from "pino";

/** Logs JSON estructurados. Nunca se loguea contenido de posts ni tokens: solo IDs (GDPR). */
export function createLogger(service: string) {
  return pino({ level: process.env.LOG_LEVEL ?? "info", base: { service }, timestamp: pino.stdTimeFunctions.isoTime });
}
export type Logger = ReturnType<typeof createLogger>;
