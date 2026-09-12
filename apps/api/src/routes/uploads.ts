import { randomUUID } from "node:crypto";
import {
  AuthorizeUploadInput,
  AuthorizeUploadResponse,
  MAX_UPLOAD_SIZE_BYTES,
  UPLOAD_CONTENT_TYPE,
} from "@admemrize/shared";
import { and, count, eq, ne } from "drizzle-orm";
import { events, photos } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { requireOrganizerOrGuest, type AuthDeps } from "../plugins/auth.js";
import { originalKey } from "../storage/keys.js";
import type { ObjectStorage } from "../storage/types.js";
import type { AppInstance } from "../types.js";

export interface UploadDeps extends AuthDeps {
  storage: ObjectStorage;
}

export function registerUploadRoutes(app: AppInstance, deps: UploadDeps): void {
  /**
   * Autorise l'upload d'une photo : le fichier ne transite jamais par l'API,
   * seule une URL signée à durée courte est renvoyée, à utiliser directement
   * contre Scaleway (section 12 du master prompt).
   *
   * Accessible à un invité (son eventId vient du jeton) ou à un organisateur
   * (eventId requis dans le corps, propriété vérifiée comme dans events.ts).
   */
  app.post(
    "/api/v1/uploads/authorize",
    {
      // Un invité déclenche cette route à chaque photo prise pendant tout
      // l'événement : quota généreux, resserré par les contrôles métier
      // ci-dessous (event verrouillé, quotas de photos).
      config: { rateLimit: { max: 120, timeWindow: "10 minutes" } },
      preHandler: requireOrganizerOrGuest(deps),
      schema: {
        body: AuthorizeUploadInput,
        response: { 201: AuthorizeUploadResponse },
      },
    },
    async (request, reply) => {
      if (request.body.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
        throw badRequest(
          `Le fichier dépasse la taille maximale autorisée (${MAX_UPLOAD_SIZE_BYTES} octets).`,
          { field: "sizeBytes", maxUploadSizeBytes: MAX_UPLOAD_SIZE_BYTES }
        );
      }

      const guestSessionId = request.guest?.guestSessionId;
      const eventId = request.guest
        ? request.guest.eventId
        : request.body.eventId;

      if (!eventId) {
        throw badRequest(
          "eventId requis pour une demande d'upload organisateur.",
          { field: "eventId" }
        );
      }

      // Même principe que getOwnedEvent (routes/events.ts) : pour un
      // organisateur, la propriété fait partie de la clause WHERE, pas d'une
      // vérification après coup — l'événement d'un tiers reste un 404, jamais
      // un 403 qui en confirmerait l'existence. Un invité a déjà prouvé son
      // droit sur cet event via son jeton, aucune clause supplémentaire requise.
      const eventCondition = request.organizer
        ? and(eq(events.id, eventId), eq(events.ownerId, request.organizer.userId))
        : eq(events.id, eventId);

      const [event] = await deps.db
        .select()
        .from(events)
        .where(eventCondition)
        .limit(1);

      if (!event) {
        throw notFound("Événement introuvable.", "EVENT_NOT_FOUND");
      }

      if (event.status !== "ACTIVE_LOCKED") {
        throw conflict(
          "Cet événement n'accepte plus de nouvelles photos pour le moment.",
          "EVENT_NOT_ACTIVE_LOCKED"
        );
      }

      // Limite connue (même esprit que la dette technique documentée en
      // section 10 de l'addendum) : ce compteur ne voit que les photos déjà
      // confirmées en base. Tant que la confirmation d'upload (Phase 4)
      // n'écrit pas de ligne dès l'émission de cette URL signée, un client qui
      // enchaînerait des appels à /uploads/authorize sans jamais uploader
      // n'est pas ralenti par ce quota — seul un usage normal (une demande par
      // photo réellement envoyée) est couvert ici.
      if (guestSessionId) {
        const [{ value: sessionCount }] = await deps.db
          .select({ value: count() })
          .from(photos)
          .where(
            and(
              eq(photos.guestSessionId, guestSessionId),
              ne(photos.status, "DELETED")
            )
          );
        if (sessionCount >= deps.env.SESSION_PHOTO_QUOTA) {
          throw conflict(
            `Quota de ${deps.env.SESSION_PHOTO_QUOTA} photos atteint pour cette session.`,
            "SESSION_QUOTA_EXCEEDED"
          );
        }
      }

      const [{ value: eventCount }] = await deps.db
        .select({ value: count() })
        .from(photos)
        .where(and(eq(photos.eventId, eventId), ne(photos.status, "DELETED")));
      if (eventCount >= deps.env.EVENT_PHOTO_QUOTA) {
        throw conflict(
          `Quota de ${deps.env.EVENT_PHOTO_QUOTA} photos atteint pour cet événement.`,
          "EVENT_QUOTA_EXCEEDED"
        );
      }

      const photoId = randomUUID();
      const key = originalKey(eventId, photoId);

      const { url, expiresAt } = await deps.storage.getUploadUrl({
        key,
        contentType: UPLOAD_CONTENT_TYPE,
        expiresInSeconds: deps.env.UPLOAD_URL_TTL_SECONDS,
      });

      reply.status(201);
      return {
        photoId,
        uploadUrl: url,
        method: "PUT" as const,
        key,
        contentType: UPLOAD_CONTENT_TYPE,
        expiresAt: expiresAt.toISOString(),
      };
    }
  );
}
