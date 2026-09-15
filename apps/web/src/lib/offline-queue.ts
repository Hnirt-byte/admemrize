import { createStore, del, entries, get, set } from "idb-keyval";

/**
 * Queue d'envoi persistante, en IndexedDB (addendum, section 2).
 *
 * Règle non négociable : la copie locale d'une photo n'est supprimée qu'une
 * fois le serveur ayant tranché sur son sort — `READY`, la photo est scellée,
 * ou `FAILED`, elle est irrécupérable et la garder n'aiderait personne. Tant
 * qu'aucun verdict n'est tombé — hors ligne, onglet fermé, téléphone éteint —
 * le blob reste ici et repartira au prochain passage au premier plan.
 *
 * `localStorage` ne conviendrait pas : il ne stocke que du texte et plafonne
 * autour de 5 Mo, soit à peine une photo.
 */
const store = createStore("admemrize", "pending-photos");

export type QueueStage =
  /** Rien n'est encore parti : il faut demander une URL signée puis envoyer. */
  | "TO_UPLOAD"
  /** Le fichier est sur Scaleway, seule la confirmation reste à faire. */
  | "UPLOADED"
  /**
   * Bloquée par une réponse définitive du serveur qui ne met pas en cause le
   * fichier lui-même : quota atteint, événement expiré, requête refusée. Plus
   * aucune tentative, mais le blob est conservé — la photo est bonne, la jeter
   * serait perdre un souvenir valable.
   *
   * Une photo que le serveur a examinée et rejetée (`/photos/confirm` répond
   * `status: "FAILED"`) ne passe pas par ici : elle quitte la queue
   * immédiatement, voir `processItem` (upload-sync.ts).
   */
  | "FAILED";

export interface QueuedPhoto {
  localId: string;
  eventId: string;
  blob: Blob;
  /** Heure de prise de vue : l'original stocké ne garde aucun EXIF (section 15). */
  capturedAt: string;
  stage: QueueStage;
  /** Attribué par `/uploads/authorize`, réutilisé tel quel par la confirmation. */
  photoId?: string;
  attempts: number;
  /** Date (epoch ms) avant laquelle une reprise automatique ne réessaie pas. */
  nextAttemptAt: number;
  lastError?: string;
}

function randomLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueuePhoto(input: {
  eventId: string;
  blob: Blob;
  capturedAt: string;
}): Promise<QueuedPhoto> {
  const item: QueuedPhoto = {
    localId: randomLocalId(),
    eventId: input.eventId,
    blob: input.blob,
    capturedAt: input.capturedAt,
    stage: "TO_UPLOAD",
    attempts: 0,
    nextAttemptAt: 0,
  };
  await set(item.localId, item, store);
  return item;
}

/**
 * Relit une entrée telle qu'elle est stockée. `processItem` (upload-sync.ts)
 * enregistre sa progression en cours de route : après un échec, c'est cette
 * version-là qui fait foi, pas celle que la boucle d'envoi avait en main quand
 * elle a commencé.
 */
export async function getQueuedPhoto(
  localId: string
): Promise<QueuedPhoto | undefined> {
  return get<QueuedPhoto>(localId, store);
}

export async function saveQueuedPhoto(item: QueuedPhoto): Promise<void> {
  await set(item.localId, item, store);
}

/** Supprime la copie locale — à n'appeler qu'après confirmation du serveur. */
export async function dropQueuedPhoto(localId: string): Promise<void> {
  await del(localId, store);
}

/**
 * Photos en attente pour un événement, dans l'ordre où elles ont été prises :
 * la galerie raconte la soirée dans cet ordre-là (routes/photos.ts), autant
 * que la queue les envoie de même.
 */
export async function listQueuedPhotos(
  eventId: string
): Promise<QueuedPhoto[]> {
  const all = await entries<string, QueuedPhoto>(store);
  return all
    .map(([, item]) => item)
    .filter((item) => item?.eventId === eventId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
