import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { events } from "../db/schema.js";
import { AppError, conflict, gone } from "../lib/errors.js";

type EventRow = typeof events.$inferSelect;

/**
 * Gate de révélation (section 21 du master prompt).
 *
 * Règle unique, appliquée par tout endpoint qui donne accès à une photo :
 * les photos d'un événement ne sont lisibles que si `status === "REVEALED"`.
 *
 * `revealAt` n'est pas une deuxième condition d'accès mais ce qui *fait
 * basculer* le statut : il est comparé à l'heure du serveur (`serverNow`) et à
 * elle seule. Une heure envoyée par le client — en-tête, paramètre de requête,
 * corps JSON — n'entre nulle part dans cette décision, et il n'existe aucun
 * chemin de code pour lui en donner l'occasion : rien ici ne lit la requête.
 *
 * Exprimer la règle sur le statut plutôt que sur `revealAt <= now` est ce qui
 * rend la révélation anticipée possible : après `POST /events/:id/reveal`,
 * `revealAt` est encore dans le futur alors que l'événement est bel et bien
 * ouvert. Le statut est la vérité, `revealAt` est l'échéance qui le fera
 * basculer tout seul si l'organisateur ne fait rien.
 */

/**
 * Heure de référence du gate. Toujours l'horloge du serveur — le seul point du
 * code où "maintenant" est défini pour la révélation.
 */
export function serverNow(): Date {
  return new Date();
}

/** L'échéance planifiée est-elle atteinte, à l'heure du serveur ? */
export function isRevealDue(
  event: Pick<EventRow, "revealAt">,
  now: Date = serverNow()
): boolean {
  return event.revealAt.getTime() <= now.getTime();
}

/**
 * Révélation automatique, sans action de l'organisateur : si l'échéance est
 * passée, l'événement bascule ici même, au moment où on le consulte.
 *
 * L'UPDATE porte `status = 'ACTIVE_LOCKED'` dans sa clause WHERE : deux
 * requêtes concurrentes ne peuvent pas révéler deux fois, et un événement
 * passé entre-temps à EXPIRED ne peut pas être ramené en REVEALED par une
 * requête qui l'avait lu avant. Si la clause ne matche plus, on relit la
 * ligne réellement en base plutôt que de renvoyer un état périmé.
 */
export async function resolveEventReveal(
  db: Database,
  event: EventRow,
  now: Date = serverNow()
): Promise<EventRow> {
  if (event.status !== "ACTIVE_LOCKED" || !isRevealDue(event, now)) {
    return event;
  }

  const [updated] = await db
    .update(events)
    .set({ status: "REVEALED", updatedAt: now })
    .where(and(eq(events.id, event.id), eq(events.status, "ACTIVE_LOCKED")))
    .returning();

  if (updated) {
    return updated;
  }

  const [current] = await db
    .select()
    .from(events)
    .where(eq(events.id, event.id))
    .limit(1);

  return current ?? event;
}

/**
 * Même bascule, mais en une seule requête pour tous les événements échus d'un
 * organisateur : évite N UPDATE au chargement d'un tableau de bord qui liste
 * ses événements.
 */
export async function resolveDueRevealsForOwner(
  db: Database,
  ownerId: string,
  now: Date = serverNow()
): Promise<void> {
  await db
    .update(events)
    .set({ status: "REVEALED", updatedAt: now })
    .where(
      and(
        eq(events.ownerId, ownerId),
        eq(events.status, "ACTIVE_LOCKED"),
        lte(events.revealAt, now)
      )
    );
}

/**
 * Révélation anticipée déclenchée par l'organisateur
 * (`POST /api/v1/events/:eventId/reveal`).
 *
 * Irréversible et idempotente : un événement déjà révélé est renvoyé tel quel,
 * sans nouvelle écriture ; aucune transition ne ramène vers ACTIVE_LOCKED,
 * ici ou ailleurs dans le code (section 6).
 *
 * `revealAt` n'est volontairement pas ramené à l'instant présent : il reste la
 * date *planifiée*, ce qui préserve l'invariant `deleteAt = revealAt +
 * rétention` posé à la création (routes/events.ts) et la promesse de durée de
 * conservation faite à l'organisateur. Révéler plus tôt ouvre la galerie plus
 * tôt, ça ne raccourcit jamais la vie des photos.
 */
export async function revealEventNow(
  db: Database,
  event: EventRow,
  now: Date = serverNow()
): Promise<EventRow> {
  if (event.status === "EXPIRED") {
    throw conflict(
      "Cet événement est expiré, ses photos ont été supprimées : il ne peut plus être révélé.",
      "EVENT_EXPIRED"
    );
  }

  if (event.status === "REVEALED") {
    return event;
  }

  const [updated] = await db
    .update(events)
    .set({ status: "REVEALED", updatedAt: now })
    .where(and(eq(events.id, event.id), eq(events.status, "ACTIVE_LOCKED")))
    .returning();

  if (updated) {
    return updated;
  }

  // Course perdue contre une autre requête (ou contre le passage à EXPIRED) :
  // on renvoie l'état réel, jamais celui qu'on croyait écrire.
  const [current] = await db
    .select()
    .from(events)
    .where(eq(events.id, event.id))
    .limit(1);

  return current ?? event;
}

/**
 * Le gate proprement dit. À appeler dans **tout** endpoint qui expose une
 * photo, ses métadonnées ou une URL signée vers un fichier, après
 * `resolveEventReveal`.
 */
export function assertPhotosAccessible(
  event: EventRow,
  now: Date = serverNow()
): void {
  if (event.status === "EXPIRED") {
    throw gone(
      "Cet événement est terminé, ses photos ont été supprimées.",
      "EVENT_EXPIRED"
    );
  }

  if (event.status !== "REVEALED") {
    throw new AppError(
      403,
      "PHOTOS_NOT_REVEALED",
      "Les photos de cet événement ne sont pas encore révélées.",
      {
        status: event.status,
        revealAt: event.revealAt.toISOString(),
        // Le client affiche son compte à rebours à partir de l'heure du
        // serveur, pas de son horloge locale — qu'elle soit fausse ou
        // volontairement avancée ne change rien à ce que l'API accepte.
        serverTime: now.toISOString(),
      }
    );
  }
}

/**
 * Bascule automatique + gate, en un seul appel : la combinaison utilisée par
 * toutes les routes d'accès aux photos.
 */
export async function requireRevealedEvent(
  db: Database,
  event: EventRow,
  now: Date = serverNow()
): Promise<EventRow> {
  const resolved = await resolveEventReveal(db, event, now);
  assertPhotosAccessible(resolved, now);
  return resolved;
}

/**
 * Un événement n'est modifiable (PATCH) que tant qu'il est verrouillé.
 * Autrement, repousser `revealAt` dans le futur sur un événement déjà révélé
 * reviendrait à le reverrouiller par la bande — exactement la transition
 * interdite par la section 6.
 */
export function assertStillLocked(event: EventRow): void {
  if (event.status === "EXPIRED") {
    throw conflict(
      "Cet événement est expiré, il ne peut plus être modifié.",
      "EVENT_EXPIRED"
    );
  }

  if (event.status === "REVEALED") {
    throw conflict(
      "Cet événement est déjà révélé : ses réglages ne sont plus modifiables et il ne peut pas être reverrouillé.",
      "EVENT_ALREADY_REVEALED"
    );
  }
}
