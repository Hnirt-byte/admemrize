import { randomUUID } from "node:crypto";
import {
  GuestJoinInput,
  GuestJoinResponse,
  GuestSessionDTO,
} from "@admemrize/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { events, guestSessions } from "../db/schema.js";
import { gone, notFound } from "../lib/errors.js";
import { hashToken, signGuestSessionToken } from "../lib/tokens.js";
import { requireGuest, type AuthDeps } from "../plugins/auth.js";
import type { AppInstance } from "../types.js";

const EventParams = z.object({ eventId: z.uuid() });

export function registerGuestRoutes(app: AppInstance, deps: AuthDeps): void {
  /**
   * Jonction d'un invité à un événement. Route volontairement publique : un
   * invité n'a pas de compte, il scanne un QR code et entre un pseudo. Le jeton
   * renvoyé est strictement cantonné à cet événement — il ne donne aucun droit
   * d'organisateur, sur aucun événement, y compris celui-ci.
   */
  app.post(
    "/api/v1/events/:eventId/guest/join",
    {
      // Quota par IP volontairement haut : les invités d'un même événement
      // partagent le Wi-Fi de la salle, donc une seule IP publique. Il arrête un
      // script qui martèle la route, pas une noce de cent personnes.
      config: { rateLimit: { max: 120, timeWindow: "10 minutes" } },
      schema: {
        params: EventParams,
        body: GuestJoinInput,
        response: { 201: GuestJoinResponse },
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { nickname, deviceId } = request.body;

      const [event] = await deps.db
        .select()
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);

      if (!event) {
        throw notFound("Événement introuvable.", "EVENT_NOT_FOUND");
      }

      if (event.status === "EXPIRED" || event.deleteAt.getTime() <= Date.now()) {
        throw gone(
          "Cet événement est terminé, ses photos ont été supprimées.",
          "EVENT_EXPIRED"
        );
      }

      // Un invité qui recharge la page (ou revient le lendemain) retrouve sa
      // session grâce au deviceId, au lieu d'en accumuler une par visite.
      const [existing] = await deps.db
        .select()
        .from(guestSessions)
        .where(
          and(
            eq(guestSessions.eventId, eventId),
            eq(guestSessions.deviceId, deviceId)
          )
        )
        .orderBy(desc(guestSessions.createdAt))
        .limit(1);

      const sessionId = existing?.id ?? randomUUID();
      // Le jeton expire avec l'événement : pas d'accès survivant aux photos.
      const expiresAt = event.deleteAt;

      const guestToken = await signGuestSessionToken(
        deps.env,
        { guestSessionId: sessionId, eventId, deviceId },
        expiresAt
      );
      // Seule l'empreinte du jeton est stockée : une fuite de la base ne permet
      // pas de rejouer les sessions invité. Corollaire assumé : rejoindre à
      // nouveau invalide le jeton précédent du même appareil (deux onglets
      // ouverts en parallèle doivent donc rejouer la jonction, pas se partager
      // un jeton périmé).
      const tokenHash = hashToken(guestToken);

      if (existing) {
        await deps.db
          .update(guestSessions)
          .set({ nickname, tokenHash, expiresAt })
          .where(eq(guestSessions.id, existing.id));
      } else {
        await deps.db.insert(guestSessions).values({
          id: sessionId,
          eventId,
          nickname,
          deviceId,
          tokenHash,
          expiresAt,
        });
      }

      reply.status(201);
      return {
        guestToken,
        tokenType: "Bearer" as const,
        session: {
          id: sessionId,
          eventId,
          nickname,
          expiresAt: expiresAt.toISOString(),
        },
        // Vue volontairement réduite : l'invité n'a pas à connaître la date de
        // suppression ni quoi que ce soit sur l'organisateur.
        event: {
          id: event.id,
          name: event.name,
          type: event.type,
          status: event.status,
          revealAt: event.revealAt.toISOString(),
        },
      };
    }
  );

  /** Permet au client invité de vérifier qu'un jeton stocké est toujours valable. */
  app.get(
    "/api/v1/guest/me",
    {
      preHandler: requireGuest(deps),
      schema: { response: { 200: GuestSessionDTO } },
    },
    async (request) => {
      const [session] = await deps.db
        .select()
        .from(guestSessions)
        .where(eq(guestSessions.id, request.guest!.guestSessionId))
        .limit(1);

      if (!session) {
        throw notFound("Session invité introuvable.", "GUEST_SESSION_NOT_FOUND");
      }

      return {
        id: session.id,
        eventId: session.eventId,
        nickname: session.nickname,
        expiresAt: session.expiresAt.toISOString(),
      };
    }
  );
}
