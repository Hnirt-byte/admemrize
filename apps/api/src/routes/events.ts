import {
  CreateEventInput,
  EventDTO,
  UpdateEventInput,
} from "@admemrize/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { events, favorites, guestSessions, photos } from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireOrganizer, type AuthDeps } from "../plugins/auth.js";
import type { AppInstance } from "../types.js";

const EventParams = z.object({ eventId: z.uuid() });

type EventRow = typeof events.$inferSelect;

function toEventDTO(event: EventRow) {
  return {
    id: event.id,
    name: event.name,
    type: event.type,
    eventDate: event.eventDate.toISOString(),
    revealAt: event.revealAt.toISOString(),
    deleteAt: event.deleteAt.toISOString(),
    status: event.status,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

/**
 * Charge un événement **appartenant à l'organisateur appelant**. La propriété
 * fait partie de la clause WHERE, elle n'est pas vérifiée après coup : l'API ne
 * peut pas répondre autre chose que 404 pour l'événement d'un autre organisateur,
 * et ne révèle donc jamais son existence.
 */
async function getOwnedEvent(
  db: Database,
  ownerId: string,
  eventId: string
): Promise<EventRow> {
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.ownerId, ownerId)))
    .limit(1);

  if (!event) {
    throw notFound("Événement introuvable.", "EVENT_NOT_FOUND");
  }
  return event;
}

function assertRevealInFuture(revealAt: Date): void {
  if (revealAt.getTime() <= Date.now()) {
    throw badRequest(
      "La date de révélation doit être dans le futur.",
      { field: "revealAt" }
    );
  }
}

export function registerEventRoutes(app: AppInstance, deps: AuthDeps): void {
  const organizerOnly = requireOrganizer(deps);

  app.post(
    "/api/v1/events",
    {
      preHandler: organizerOnly,
      schema: { body: CreateEventInput, response: { 201: EventDTO } },
    },
    async (request, reply) => {
      const body = request.body;
      const revealAt = new Date(body.revealAt);
      assertRevealInFuture(revealAt);

      // `retentionHours` n'est pas stocké : il n'existe que pour calculer
      // `deleteAt`, la seule date qui compte pour le worker d'expiration.
      const deleteAt = new Date(
        revealAt.getTime() + body.retentionHours * 3600 * 1000
      );

      const [created] = await deps.db
        .insert(events)
        .values({
          ownerId: request.organizer!.userId,
          name: body.name,
          type: body.type,
          eventDate: new Date(body.eventDate),
          revealAt,
          deleteAt,
        })
        .returning();

      reply.status(201);
      return toEventDTO(created!);
    }
  );

  app.get(
    "/api/v1/events",
    {
      preHandler: organizerOnly,
      schema: { response: { 200: z.object({ events: z.array(EventDTO) }) } },
    },
    async (request) => {
      const rows = await deps.db
        .select()
        .from(events)
        .where(eq(events.ownerId, request.organizer!.userId))
        .orderBy(desc(events.createdAt));

      return { events: rows.map(toEventDTO) };
    }
  );

  app.get(
    "/api/v1/events/:eventId",
    {
      preHandler: organizerOnly,
      schema: { params: EventParams, response: { 200: EventDTO } },
    },
    async (request) => {
      const event = await getOwnedEvent(
        deps.db,
        request.organizer!.userId,
        request.params.eventId
      );
      return toEventDTO(event);
    }
  );

  app.patch(
    "/api/v1/events/:eventId",
    {
      preHandler: organizerOnly,
      schema: {
        params: EventParams,
        body: UpdateEventInput,
        response: { 200: EventDTO },
      },
    },
    async (request) => {
      const existing = await getOwnedEvent(
        deps.db,
        request.organizer!.userId,
        request.params.eventId
      );
      const body = request.body;

      const revealAt = body.revealAt ? new Date(body.revealAt) : existing.revealAt;
      if (body.revealAt) {
        assertRevealInFuture(revealAt);
      }

      // Si seule la date de révélation bouge, la durée de rétention déjà choisie
      // est conservée (on la déduit de l'écart deleteAt - revealAt existant).
      const retentionMs = body.retentionHours
        ? body.retentionHours * 3600 * 1000
        : existing.deleteAt.getTime() - existing.revealAt.getTime();

      const [updated] = await deps.db
        .update(events)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.type === undefined ? {} : { type: body.type }),
          ...(body.eventDate === undefined
            ? {}
            : { eventDate: new Date(body.eventDate) }),
          revealAt,
          deleteAt: new Date(revealAt.getTime() + retentionMs),
          updatedAt: new Date(),
        })
        .where(eq(events.id, existing.id))
        .returning();

      return toEventDTO(updated!);
    }
  );

  app.delete(
    "/api/v1/events/:eventId",
    { preHandler: organizerOnly, schema: { params: EventParams } },
    async (request, reply) => {
      const existing = await getOwnedEvent(
        deps.db,
        request.organizer!.userId,
        request.params.eventId
      );

      // Suppression en cascade explicite, dans une transaction : l'événement et
      // tout ce qui y pend disparaissent ensemble ou pas du tout.
      // Les objets S3 correspondants seront nettoyés par la couche stockage
      // (Phase 3) ; en Phase 2 aucune photo n'existe encore.
      await deps.db.transaction(async (tx) => {
        const eventPhotos = tx
          .select({ id: photos.id })
          .from(photos)
          .where(eq(photos.eventId, existing.id));
        const eventSessions = tx
          .select({ id: guestSessions.id })
          .from(guestSessions)
          .where(eq(guestSessions.eventId, existing.id));

        await tx.delete(favorites).where(inArray(favorites.photoId, eventPhotos));
        await tx
          .delete(favorites)
          .where(inArray(favorites.guestSessionId, eventSessions));
        await tx.delete(photos).where(eq(photos.eventId, existing.id));
        await tx
          .delete(guestSessions)
          .where(eq(guestSessions.eventId, existing.id));
        await tx.delete(events).where(eq(events.id, existing.id));
      });

      return reply.status(204).send();
    }
  );
}
