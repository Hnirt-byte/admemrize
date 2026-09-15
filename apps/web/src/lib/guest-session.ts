import { GuestEventView } from "@admemrize/shared";
import { z } from "zod";
import { ApiError, joinEvent } from "./api";
import { getDeviceId } from "./device-id";
import { readJson, readLocal, removeLocal, writeLocal } from "./storage";

/**
 * Tout ce qu'un appareil garde d'un événement entre deux visites : de quoi
 * revenir directement à l'écran caméra, et de quoi continuer à afficher
 * quelque chose de juste même hors ligne (le serveur n'est alors pas
 * joignable pour redonner le nom de l'événement ou l'heure de révélation).
 *
 * Le jeton invité est stocké en clair, comme n'importe quel jeton de session
 * dans un navigateur. Sa portée est volontairement étroite : un seul
 * événement, aucun droit d'organisateur, et il expire avec l'événement
 * lui-même (routes/guest.ts).
 */
const StoredGuestSessionSchema = z.object({
  guestToken: z.string().min(1),
  nickname: z.string().min(1),
  expiresAt: z.string().min(1),
  event: GuestEventView,
  /** Photos confirmées par le serveur depuis cet appareil (voir `countSealed`). */
  sealedCount: z.number().int().nonnegative().default(0),
});
export type StoredGuestSession = z.infer<typeof StoredGuestSessionSchema>;

const sessionKey = (eventId: string) => `admemrize.guest.${eventId}`;
const LAST_NICKNAME_KEY = "admemrize.lastNickname";

export function loadSession(eventId: string): StoredGuestSession | null {
  return readJson(sessionKey(eventId), (value) =>
    StoredGuestSessionSchema.parse(value)
  );
}

function saveSession(eventId: string, session: StoredGuestSession): void {
  writeLocal(sessionKey(eventId), JSON.stringify(session));
}

export function clearSession(eventId: string): void {
  removeLocal(sessionKey(eventId));
}

/** Dernier prénom saisi, uniquement pour pré-remplir le champ d'un autre événement. */
export function lastNickname(): string {
  return readLocal(LAST_NICKNAME_KEY) ?? "";
}

/**
 * Rejoint l'événement (ou rafraîchit la session existante) et persiste le
 * résultat. Le `deviceId` rend l'appel idempotent côté serveur : appelé avec
 * le prénom déjà connu, il ne fait que renouveler le jeton et rapporter
 * l'état à jour de l'événement.
 */
export async function join(
  eventId: string,
  nickname: string
): Promise<StoredGuestSession> {
  const response = await joinEvent(eventId, {
    nickname,
    deviceId: getDeviceId(),
  });

  const previous = loadSession(eventId);
  const session: StoredGuestSession = {
    guestToken: response.guestToken,
    nickname: response.session.nickname,
    expiresAt: response.session.expiresAt,
    event: response.event,
    // Le compteur appartient à l'appareil, pas à la réponse du serveur : une
    // reconnexion ne doit pas le remettre à zéro.
    sealedCount: previous?.sealedCount ?? 0,
  };

  saveSession(eventId, session);
  writeLocal(LAST_NICKNAME_KEY, session.nickname);
  return session;
}

/**
 * Rafraîchit la session d'un invité déjà connu. Renvoie `null` si cet
 * appareil n'a jamais rejoint cet événement.
 */
export async function refreshSession(
  eventId: string
): Promise<StoredGuestSession | null> {
  const stored = loadSession(eventId);
  if (!stored) return null;
  return join(eventId, stored.nickname);
}

/**
 * Exécute un appel authentifié, en renouvelant le jeton une fois s'il est
 * refusé.
 *
 * Un 401 n'a rien d'exceptionnel ici : l'API ne garde que l'empreinte du
 * jeton invité, donc rejoindre depuis un second onglet invalide celui du
 * premier (routes/guest.ts). Comme le prénom et le `deviceId` sont conservés
 * localement, la reprise est silencieuse — l'invité ne voit rien.
 */
export async function withGuestToken<T>(
  eventId: string,
  call: (token: string) => Promise<T>
): Promise<T> {
  const stored = loadSession(eventId);
  if (!stored) {
    throw new ApiError(
      401,
      "NO_GUEST_SESSION",
      "Cet appareil n'a pas encore rejoint cet événement."
    );
  }

  try {
    return await call(stored.guestToken);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) {
      throw error;
    }
    const refreshed = await join(eventId, stored.nickname);
    return call(refreshed.guestToken);
  }
}

/** Incrémente le compteur de souvenirs scellés sur cet appareil. */
export function countSealed(eventId: string): number {
  const stored = loadSession(eventId);
  if (!stored) return 0;
  const next = { ...stored, sealedCount: stored.sealedCount + 1 };
  saveSession(eventId, next);
  return next.sealedCount;
}

/** Met à jour la vue de l'événement (statut, heure de révélation) sans toucher au reste. */
export function updateStoredEvent(
  eventId: string,
  event: GuestEventView
): void {
  const stored = loadSession(eventId);
  if (!stored) return;
  saveSession(eventId, { ...stored, event });
}
