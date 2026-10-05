/** Taxonomía de errores tipados que se guardan en posts.last_error_code y se muestran en la UI. */
export const ErrorCode = {
  // Esperas (el post sigue 'scheduled', no consume reintentos)
  RATE_LIMITED: "RATE_LIMITED", // 429 por Embajador: respeta Retry-After
  APP_RATE_LIMITED: "APP_RATE_LIMITED", // 429 de app: pausa global
  // Transitorios (reintento con backoff, máx 5)
  PROVIDER_5XX: "PROVIDER_5XX",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  TOKEN_REFRESH_UNAVAILABLE: "TOKEN_REFRESH_UNAVAILABLE",
  LEASE_EXPIRED: "LEASE_EXPIRED", // worker caído a mitad de publicación
  // Permanentes ('failed' sin quemar reintentos)
  TOKEN_REVOKED: "TOKEN_REVOKED",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  MAX_ATTEMPTS_EXCEEDED: "MAX_ATTEMPTS_EXCEEDED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
