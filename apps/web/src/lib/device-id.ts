import { readLocal, writeLocal } from "./storage";

const DEVICE_ID_KEY = "admemrize.deviceId";

/** `crypto.randomUUID` n'existe que dans un contexte sécurisé (HTTPS ou localhost). */
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Identifiant d'appareil persistant, généré par le navigateur et stocké en
 * clair dans `localStorage`. C'est lui qui rend `/guest/join` idempotent : au
 * retour sur un événement déjà rejoint, le serveur retrouve la session
 * existante au lieu d'en créer une seconde (routes/guest.ts).
 *
 * Ce n'est **pas** un identifiant matériel et il ne sert jamais à identifier
 * une personne (section 15, vie privée) : le vider revient à se présenter
 * comme un nouvel appareil, sans autre conséquence.
 */
export function getDeviceId(): string {
  const existing = readLocal(DEVICE_ID_KEY);
  // Le serveur exige entre 8 et 128 caractères (GuestJoinInput) : une valeur
  // tronquée ou bricolée à la main est remplacée plutôt que refusée en 400.
  if (existing && existing.length >= 8 && existing.length <= 128) {
    return existing;
  }
  const created = randomId();
  writeLocal(DEVICE_ID_KEY, created);
  return created;
}
