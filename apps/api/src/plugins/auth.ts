import { eq } from "drizzle-orm";
import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Database } from "../db/client.js";
import { guestSessions, users } from "../db/schema.js";
import type { Env } from "../env.js";
import { unauthorized } from "../lib/errors.js";
import {
  tokenHashMatches,
  verifyGuestSessionToken,
  verifyOrganizerAccessToken,
} from "../lib/tokens.js";

export interface OrganizerContext {
  userId: string;
  email: string;
  plan: string;
}

export interface GuestContext {
  guestSessionId: string;
  eventId: string;
  nickname: string;
  deviceId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    organizer?: OrganizerContext;
    guest?: GuestContext;
  }
}

export interface AuthDeps {
  db: Database;
  env: Env;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) {
    throw unauthorized("En-tête Authorization manquant.", "MISSING_TOKEN");
  }
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") {
    throw unauthorized(
      "En-tête Authorization mal formé (attendu: Bearer <token>).",
      "MALFORMED_AUTHORIZATION_HEADER"
    );
  }
  return value.trim();
}

/**
 * Garde des routes organisateur. Un jeton invité ne peut pas la franchir : il
 * est signé avec un autre secret, porte une autre audience et un autre claim
 * `tkn` (voir lib/tokens.ts). L'échec est un 401 indifférencié.
 */
export function requireOrganizer(deps: AuthDeps): preHandlerAsyncHookHandler {
  return async (request) => {
    const token = bearerToken(request);
    const claims = await verifyOrganizerAccessToken(deps.env, token);

    // Relecture en base : un compte supprimé ne doit pas rester actif jusqu'à
    // l'expiration naturelle de son access token.
    const [user] = await deps.db
      .select({
        id: users.id,
        email: users.email,
        plan: users.plan,
      })
      .from(users)
      .where(eq(users.id, claims.userId))
      .limit(1);

    if (!user) {
      throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
    }

    request.organizer = {
      userId: user.id,
      email: user.email,
      plan: user.plan,
    };
  };
}

/**
 * Garde des routes invité. Deux vérifications au-delà de la signature :
 * la session existe toujours en base (son empreinte correspond au jeton
 * présenté) et elle n'a pas dépassé `expiresAt`. Cela rend une session invité
 * révocable : supprimer la ligne suffit à invalider le jeton immédiatement,
 * sans attendre son expiration.
 */
export function requireGuest(deps: AuthDeps): preHandlerAsyncHookHandler {
  return async (request) => {
    const token = bearerToken(request);
    const claims = await verifyGuestSessionToken(deps.env, token);

    const [session] = await deps.db
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, claims.guestSessionId))
      .limit(1);

    if (
      !session ||
      session.eventId !== claims.eventId ||
      !tokenHashMatches(token, session.tokenHash) ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
    }

    request.guest = {
      guestSessionId: session.id,
      eventId: session.eventId,
      nickname: session.nickname,
      deviceId: session.deviceId,
    };
  };
}
