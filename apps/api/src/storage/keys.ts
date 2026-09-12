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

export function exportKey(filename: string): string {
  return `exports/${filename}`;
}

/** Préfixe de tous les objets d'un événement — utile pour un nettoyage en masse. */
export function eventPrefix(eventId: string): string {
  return `events/${eventId}/`;
}
