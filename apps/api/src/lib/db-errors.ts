/** Code Postgres d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = "23505";

/**
 * Reconnaît une violation d'unicité, quelle que soit la profondeur à laquelle le
 * driver a emballé l'erreur (postgres.js la remonte telle quelle, PGlite la
 * remonte via `cause`).
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
