/**
 * Accès à `localStorage` qui ne peut jamais faire planter l'application.
 *
 * Safari en navigation privée, un navigateur qui bloque les données de site,
 * un quota plein : toutes ces situations font *lever* une exception sur un
 * simple `getItem`. Un invité dans ce cas doit pouvoir prendre des photos
 * quand même — il perdra seulement la mémoire de sa session entre deux
 * chargements de page.
 */

const memoryFallback = new Map<string, string>();

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memoryFallback.get(key) ?? null;
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

export function writeLocal(key: string, value: string): void {
  memoryFallback.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Volontairement silencieux : la copie en mémoire suffit pour la session
    // en cours, et l'invité n'a rien à faire de cette information.
  }
}

export function removeLocal(key: string): void {
  memoryFallback.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Idem.
  }
}

export function readJson<T>(key: string, parse: (value: unknown) => T): T | null {
  const raw = readLocal(key);
  if (!raw) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    // Donnée corrompue ou d'une version antérieure du format : on l'oublie
    // plutôt que de faire échouer le démarrage du flux invité.
    removeLocal(key);
    return null;
  }
}
