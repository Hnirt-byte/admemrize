import type { RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import type { Env } from "../env.js";
import { tooManyRequests } from "../lib/errors.js";
import {
  verifyGuestSessionToken,
  verifyOrganizerAccessToken,
} from "../lib/tokens.js";

/**
 * Compter les appels par IP est le comportement par défaut de
 * @fastify/rate-limit, et il est faux pour ADMEMRIZE.
 *
 * Un mariage, c'est cent invités sur le Wi-Fi de la salle : une seule IP
 * publique pour tout le monde. Un quota par IP fait donc payer à la salle
 * entière l'activité de chacun — le premier invité à mitrailler bloque les
 * quatre-vingt-dix-neuf autres, et une file offline qui se vide après une
 * coupure réseau suffit à épuiser le quota commun. Ce n'est pas un réglage
 * trop serré, c'est la mauvaise unité de compte.
 *
 * Sur les routes authentifiées, la bonne unité existe et elle est
 * infalsifiable : la session portée par le jeton. Un invité ne peut consommer
 * que son propre quota, puisqu'il ne peut pas signer le jeton d'un autre.
 *
 * `/guest/join` reste compté par IP, faute de mieux : c'est justement l'appel
 * qui crée la session, il n'y a donc encore rien à compter côté client. Le
 * `deviceId` du corps de requête ne peut pas servir de clé — il est choisi par
 * le client, qui n'aurait qu'à le faire varier pour s'offrir un quota neuf à
 * chaque appel. Son plafond est relevé à la place (voir env.ts).
 */

/** Fenêtre des routes photo authentifiées. */
const SESSION_WINDOW = "10 minutes";

/** Fenêtre de la jonction invité. */
const GUEST_JOIN_WINDOW = "5 minutes";

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return null;
  return value.trim();
}

/**
 * Clé de quota d'une requête authentifiée : la session invité, sinon
 * l'organisateur, sinon l'adresse IP.
 *
 * La signature du jeton est vérifiée ici une seconde fois (le `preHandler`
 * d'authentification la revérifiera, et lui seul relira la base) : c'est un
 * HMAC sur quelques centaines d'octets, le prix est négligeable devant la
 * moindre requête SQL. Ce qui compte, c'est que cette clé soit calculée à
 * partir d'une signature valide, jamais d'un en-tête que le client pourrait
 * simplement affirmer — sans quoi n'importe qui pourrait épuiser le quota
 * d'un invité en se contentant d'écrire son identifiant de session.
 *
 * Le repli sur l'IP couvre les requêtes sans jeton ou au jeton invalide :
 * elles finiront en 401, mais leur volume doit rester compté quelque part.
 */
export function sessionRateLimitKey(
  env: Env
): (request: FastifyRequest) => Promise<string> {
  return async (request) => {
    const token = bearerToken(request);

    if (token) {
      // Même ordre que `requireOrganizerOrGuest` (plugins/auth.ts) : l'audience
      // JWT propre à chaque famille de jeton fait échouer immédiatement la
      // tentative qui ne correspond pas.
      try {
        const guest = await verifyGuestSessionToken(env, token);
        return `guest:${guest.guestSessionId}`;
      } catch {
        // Pas un jeton invité : on tente l'organisateur.
      }

      try {
        const organizer = await verifyOrganizerAccessToken(env, token);
        return `organizer:${organizer.userId}`;
      } catch {
        // Ni l'un ni l'autre : jeton expiré, forgé, ou tronqué.
      }
    }

    return `ip:${request.ip}`;
  };
}

/**
 * Configuration de quota des routes photo authentifiées : autorisation
 * d'upload, confirmation, liste et téléchargement après révélation.
 */
export function sessionRateLimit(env: Env): RateLimitOptions {
  return {
    max: env.SESSION_RATE_LIMIT_MAX,
    timeWindow: SESSION_WINDOW,
    keyGenerator: sessionRateLimitKey(env),
  };
}

/** Configuration de quota de `/guest/join` — par IP, volontairement (voir plus haut). */
export function guestJoinRateLimit(env: Env): RateLimitOptions {
  return {
    max: env.GUEST_JOIN_RATE_LIMIT_MAX,
    timeWindow: GUEST_JOIN_WINDOW,
  };
}

/**
 * Enveloppe d'erreur des refus de quota, identique à toutes les autres erreurs
 * de l'API (`{ error: { code, message, details } }`) : une `AppError` levée ici
 * repasse par le gestionnaire d'erreurs commun (plugins/error-handler.ts).
 *
 * Le code `RATE_LIMITED` compte pour le client de la Phase 7 : c'est lui qui
 * distingue un refus temporaire — la photo reste en file et repartira — d'un
 * refus définitif qui, lui, ne mérite pas de réessai.
 */
export function rateLimitErrorResponse(
  _request: FastifyRequest,
  context: { ttl: number; max: number }
): object {
  const retryAfterSeconds = Math.max(1, Math.ceil(context.ttl / 1000));
  return tooManyRequests(
    `Trop de requêtes (${context.max} maximum). Réessayez dans ${retryAfterSeconds} seconde(s).`,
    retryAfterSeconds
  );
}
