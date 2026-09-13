/**
 * Construction des clés objet S3 (section 12 du master prompt). Centralisé ici
 * pour qu'aucune route ni aucun worker ne recompose un chemin à la main — un
 * seul endroit à faire évoluer si la structure change.
 *
 *   events/{eventId}/originals/{photoId}.jpg    — fichier brut envoyé par le client
 *   events/{eventId}/thumbnails/{photoId}.jpg   — vignette (Phase 4, Sharp)
 *   events/{eventId}/previews/{photoId}.jpg     — aperçu EXIF-nettoyé (Phase 4, Sharp)
 *   exports/{filename}                          — ZIP de téléchargement (Phase 6)
 */

// Capture toujours en JPEG côté client (canvas.toBlob), voir addendum section 2 :
// jamais d'autre extension à gérer côté serveur.
const EXTENSION = "jpg";

export function originalKey(eventId: string, photoId: string): string {
  return `events/${eventId}/originals/${photoId}.${EXTENSION}`;
}

export function thumbnailKey(eventId: string, photoId: string): string {
  return `events/${eventId}/thumbnails/${photoId}.${EXTENSION}`;
}

export function previewKey(eventId: string, photoId: string): string {
  return `events/${eventId}/previews/${photoId}.${EXTENSION}`;
}

/**
 * ZIP de téléchargement (Phase 9), rangé sous l'événement dont il provient.
 *
 * La structure annoncée en Phase 1 était `exports/{filename}`, à plat. Changée
 * en Phase 6 : l'expiration doit pouvoir supprimer les exports d'un événement
 * sans les avoir suivis en base (aucune table ne les recense), donc il lui faut
 * un préfixe qui dise à quel événement chaque ZIP appartient. À plat, un
 * export oublié survivait indéfiniment à l'événement qu'il contient — un ZIP
 * de toutes les photos d'un mariage, précisément ce que la promesse de
 * suppression garantit de faire disparaître (section 15).
 */
export function exportKey(eventId: string, filename: string): string {
  return `${eventExportPrefix(eventId)}${filename}`;
}

/** Préfixe de tous les objets d'un événement — utile pour un nettoyage en masse. */
export function eventPrefix(eventId: string): string {
  return `events/${eventId}/`;
}

/** Préfixe des exports d'un événement, hors de son arborescence `events/`. */
export function eventExportPrefix(eventId: string): string {
  return `exports/${eventId}/`;
}

/**
 * Tous les préfixes sous lesquels un événement possède des objets. C'est la
 * liste que balaie l'expiration (services/expiration.ts) : ajouter un
 * emplacement de stockage ailleurs sans l'ajouter ici le rendrait invisible à
 * la suppression.
 */
export function eventStoragePrefixes(eventId: string): string[] {
  return [eventPrefix(eventId), eventExportPrefix(eventId)];
}
