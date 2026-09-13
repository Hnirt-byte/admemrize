import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { guestSessions } from "../db/schema.js";
import { hashToken } from "./tokens.js";

/**
 * deviceId synthétique et déterministe (jamais fourni par un vrai client) :
 * sert uniquement de clé de recherche pour retrouver la session
 * auto-provisionnée d'un organisateur sur un événement donné, exactement
 * comme le deviceId d'un vrai invité sert à retrouver sa session en rejoignant
 * deux fois (routes/guest.ts).
 */
function organizerDeviceId(organizerId: string): string {
  return `organizer:${organizerId}`;
}

/**
 * `photos.guest_session_id` reste NOT NULL : aucune photo en base sans
 * session invité, y compris pour un organisateur qui capture pendant son
 * propre événement (/uploads/authorize, /photos/confirm). Cette fonction lui
 * fournit une GuestSession comme à n'importe quel invité — auto-provisionnée
 * au premier appel sur cet événement, puis réutilisée (retrouvée par le
 * deviceId synthétique ci-dessus) pour tous ses appels suivants sur ce même
 * événement.
 *
 * Cette session n'est joignable par aucun jeton invité réel : `tokenHash` est
 * une empreinte aléatoire sans rapport avec un jeton émis, et l'organisateur
 * continue à s'authentifier uniquement via son propre jeton organisateur
 * (requireOrganizer) — jamais via requireGuest.
 *
 * Course possible si deux requêtes concurrentes du même organisateur
 * arrivent avant que la première n'ait inséré sa ligne : deux sessions
 * créées au lieu d'une réutilisée. Même risque, déjà accepté pour les
 * invités classiques, faute de contrainte unique sur
 * `guest_sessions(event_id, device_id)` (addendum section 10, point 2) — pas
 * grave si ça arrive (une session en trop), pas une faille de sécurité.
 */
export async function resolveOrganizerGuestSessionId(
  db: Database,
  organizer: { userId: string; email: string },
  event: { id: string; deleteAt: Date }
): Promise<string> {
  const deviceId = organizerDeviceId(organizer.userId);

  const [existing] = await db
    .select({ id: guestSessions.id })
    .from(guestSessions)
    .where(
      and(eq(guestSessions.eventId, event.id), eq(guestSessions.deviceId, deviceId))
    )
    .orderBy(desc(guestSessions.createdAt))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  // Partie locale de l'email : reconnaissable par l'organisateur lui-même,
  // sans exposer son adresse complète aux autres invités qui verraient ce
  // pseudo dans la galerie partagée de l'événement.
  const nickname = organizer.email.split("@")[0]!.slice(0, 40);

  const [created] = await db
    .insert(guestSessions)
    .values({
      id: randomUUID(),
      eventId: event.id,
      nickname,
      deviceId,
      tokenHash: hashToken(randomUUID()),
      expiresAt: event.deleteAt,
    })
    .returning({ id: guestSessions.id });

  return created!.id;
}
