import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { events, favorites, guestSessions, photos } from "../db/schema.js";
import { eventStoragePrefixes } from "../storage/keys.js";
import type { ObjectStorage } from "../storage/types.js";

type EventRow = typeof events.$inferSelect;

/**
 * Expiration définitive d'un événement (section 22 du master prompt).
 *
 * À `deleteAt`, tout ce qui appartient à l'événement disparaît, dans cet
 * ordre : objets Scaleway (originaux, aperçus, vignettes, exports ZIP), puis
 * favoris, photos et sessions invité en base, puis l'événement passe à
 * EXPIRED. La ligne `events` elle-même survit, vidée de son contenu : c'est
 * elle qui permet de répondre "cet événement est terminé" (410) à un invité
 * qui rouvrirait un vieux lien, au lieu d'un 404 indistinct d'une faute de
 * frappe.
 *
 * Les fichiers partent avant la base, jamais l'inverse : si le processus
 * s'arrête entre les deux, l'événement n'est pas encore EXPIRED et le
 * balayage suivant le reprendra. Dans l'ordre contraire, un événement passé à
 * EXPIRED trop tôt sortirait du filtre de recherche en laissant ses fichiers
 * sur Scaleway pour toujours — une promesse de suppression non tenue.
 */

export interface SweepLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface ExpirationSweepOptions {
  db: Database;
  storage: ObjectStorage;
  logger?: SweepLogger;
  /** Heure de référence — toujours celle du serveur, comme le gate de révélation. */
  now?: Date;
  /** Borne le travail d'un passage ; le reste attend le tour suivant. */
  batchSize?: number;
}

export interface EventExpirationResult {
  eventId: string;
  deletedObjects: number;
  deletedPhotos: number;
  deletedGuestSessions: number;
}

export interface ExpirationSweepResult {
  /** Événements échus trouvés par ce passage. */
  found: number;
  expired: EventExpirationResult[];
  /** Événements dont le traitement a échoué — ils seront repris au passage suivant. */
  failed: { eventId: string; error: unknown }[];
}

export const DEFAULT_SWEEP_BATCH_SIZE = 100;

const silentLogger: SweepLogger = { info: () => {}, error: () => {} };

/**
 * Les événements à supprimer : échéance atteinte à l'heure du serveur, et pas
 * déjà expirés.
 *
 * Le critère est `status <> 'EXPIRED'`, **pas** `status = 'REVEALED'` comme le
 * prévoyait le cahier des charges initial. Depuis la Phase 5, la révélation
 * est paresseuse : un événement que personne n'a consulté après son `revealAt`
 * est encore ACTIVE_LOCKED en base, bien que son heure soit passée depuis
 * longtemps. Filtrer sur REVEALED le rendrait immortel — et ses photos avec
 * lui (addendum section 10, point 10).
 */
async function findExpiredEvents(
  db: Database,
  now: Date,
  batchSize: number
): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(lte(events.deleteAt, now), ne(events.status, "EXPIRED")))
    // Le plus ancien d'abord : en cas de retard accumulé, ce sont les données
    // qui auraient dû disparaître depuis le plus longtemps qui partent en
    // premier.
    .orderBy(asc(events.deleteAt))
    .limit(batchSize);
}

/**
 * Supprime tous les objets d'un événement sur le stockage.
 *
 * Le balayage se fait par préfixe plutôt que sur les clés connues en base :
 * une photo uploadée via une URL signée mais jamais confirmée n'a aucune ligne
 * `photos` (voir /uploads/authorize), son fichier existe pourtant. Lister le
 * préfixe les emporte tous, connus ou orphelins.
 *
 * Réutilisable hors expiration : la suppression manuelle d'un événement par
 * son organisateur (DELETE /api/v1/events/:eventId) s'en sert aussi.
 */
export async function purgeEventObjects(
  storage: ObjectStorage,
  eventId: string
): Promise<number> {
  let deleted = 0;

  for (const prefix of eventStoragePrefixes(eventId)) {
    const keys = await storage.listObjects(prefix);
    if (keys.length === 0) continue;

    await storage.deleteObjects(keys);
    deleted += keys.length;
  }

  return deleted;
}

/**
 * Efface les données d'un événement en base, en une transaction : tout part
 * ensemble ou rien ne part. Sans ça, une coupure au milieu laisserait par
 * exemple des sessions invité orphelines sur un événement déjà marqué EXPIRED,
 * hors d'atteinte du prochain balayage.
 *
 * Les favoris passent avant les photos et les sessions qu'ils référencent —
 * l'ordre est imposé par les clés étrangères, pas par le confort.
 */
async function purgeEventRows(
  db: Database,
  event: EventRow,
  now: Date
): Promise<{ deletedPhotos: number; deletedGuestSessions: number }> {
  return db.transaction(async (tx) => {
    const eventPhotos = tx
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.eventId, event.id));
    const eventSessions = tx
      .select({ id: guestSessions.id })
      .from(guestSessions)
      .where(eq(guestSessions.eventId, event.id));

    await tx.delete(favorites).where(inArray(favorites.photoId, eventPhotos));
    await tx
      .delete(favorites)
      .where(inArray(favorites.guestSessionId, eventSessions));

    const deletedPhotos = await tx
      .delete(photos)
      .where(eq(photos.eventId, event.id))
      .returning({ id: photos.id });

    const deletedSessions = await tx
      .delete(guestSessions)
      .where(eq(guestSessions.eventId, event.id))
      .returning({ id: guestSessions.id });

    await tx
      .update(events)
      .set({ status: "EXPIRED", updatedAt: now })
      .where(eq(events.id, event.id));

    return {
      deletedPhotos: deletedPhotos.length,
      deletedGuestSessions: deletedSessions.length,
    };
  });
}

/**
 * Expire un événement. Idempotent de bout en bout : rejoué sur un événement
 * déjà traité, il ne trouve aucun objet à supprimer, aucune ligne à effacer,
 * et réécrit un statut EXPIRED qui l'est déjà. Aucune étape ne suppose l'état
 * dans lequel la précédente exécution s'est arrêtée.
 */
export async function expireEvent(
  db: Database,
  storage: ObjectStorage,
  event: EventRow,
  now: Date = new Date()
): Promise<EventExpirationResult> {
  const deletedObjects = await purgeEventObjects(storage, event.id);
  const { deletedPhotos, deletedGuestSessions } = await purgeEventRows(
    db,
    event,
    now
  );

  return {
    eventId: event.id,
    deletedObjects,
    deletedPhotos,
    deletedGuestSessions,
  };
}

/**
 * Un passage complet du worker (apps/worker/src/index.ts).
 *
 * Chaque événement est traité isolément : un bucket qui refuse une suppression
 * ou une transaction qui échoue fait tomber cet événement-là, qui sera repris
 * au passage suivant, et n'empêche jamais la suppression des autres. Un seul
 * événement en échec ne doit pas retenir les données de tous les autres.
 */
export async function runExpirationSweep(
  options: ExpirationSweepOptions
): Promise<ExpirationSweepResult> {
  const {
    db,
    storage,
    logger = silentLogger,
    now = new Date(),
    batchSize = DEFAULT_SWEEP_BATCH_SIZE,
  } = options;

  const due = await findExpiredEvents(db, now, batchSize);

  const result: ExpirationSweepResult = {
    found: due.length,
    expired: [],
    failed: [],
  };

  if (due.length === 0) {
    return result;
  }

  logger.info(`${due.length} événement(s) échu(s) à supprimer`);

  for (const event of due) {
    try {
      const summary = await expireEvent(db, storage, event, now);
      result.expired.push(summary);
      logger.info(
        `Événement ${event.id} expiré : ${summary.deletedObjects} objet(s), ` +
          `${summary.deletedPhotos} photo(s), ${summary.deletedGuestSessions} session(s)`
      );
    } catch (error) {
      result.failed.push({ eventId: event.id, error });
      logger.error(
        `Échec de l'expiration de l'événement ${event.id}, reprise au prochain passage : ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (due.length === batchSize) {
    logger.info(
      `Lot plein (${batchSize}) : d'autres événements échus attendent le prochain passage`
    );
  }

  return result;
}
