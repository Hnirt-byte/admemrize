/**
 * Erreur métier destinée au client. Tout ce qui n'est pas une AppError est
 * considéré comme un bug et renvoyé en 500 générique, sans fuite de détail.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "BAD_REQUEST", message, details);

export const unauthorized = (
  message = "Authentification requise ou invalide.",
  code = "UNAUTHORIZED"
) => new AppError(401, code, message);

export const forbidden = (
  message = "Ce jeton n'autorise pas cette action.",
  code = "FORBIDDEN"
) => new AppError(403, code, message);

export const notFound = (message: string, code = "NOT_FOUND") =>
  new AppError(404, code, message);

export const conflict = (message: string, code = "CONFLICT") =>
  new AppError(409, code, message);

export const gone = (message: string, code = "GONE") =>
  new AppError(410, code, message);

/**
 * Quota d'appels dépassé. `details.retryAfterSeconds` double l'en-tête
 * `Retry-After` posé par @fastify/rate-limit : un client qui met une photo en
 * file d'attente (Phase 7) sait ainsi quand la reprendre sans deviner.
 */
export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new AppError(429, "RATE_LIMITED", message, { retryAfterSeconds });
