import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, guestSessions, photos } from "../src/db/schema.js";
import {
  createEvent,
  createTestContext,
  joinAsGuest,
  registerOrganizer,
  testEnv,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let organizer: Awaited<ReturnType<typeof registerOrganizer>>;

beforeAll(async () => {
  ctx = await createTestContext();
  organizer = await registerOrganizer(ctx.app);
});

afterAll(async () => {
  await ctx.close();
});

/** Insère directement une ligne `photos` "confirmée", sans passer par l'upload réel. */
async function insertConfirmedPhoto(eventId: string, guestSessionId: string) {
  await ctx.db.insert(photos).values({
    eventId,
    guestSessionId,
    originalKey: `events/${eventId}/originals/${randomUUID()}.jpg`,
    capturedAt: new Date(),
  });
}

function authorize(token: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/uploads/authorize",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("POST /api/v1/uploads/authorize", () => {
  it("autorise un invité et renvoie une URL PUT signée vers la bonne clé", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-upload-ok-000000001",
    });

    const response = await authorize(guest.guestToken, { sizeBytes: 2_000_000 });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.method).toBe("PUT");
    expect(body.contentType).toBe("image/jpeg");
    expect(body.key).toBe(`events/${event.id}/originals/${body.photoId}.jpg`);
    expect(body.uploadUrl.startsWith("https://")).toBe(true);
    expect(body.uploadUrl).toContain(testEnv.S3_BUCKET);
  });

  it("autorise l'organisateur propriétaire de l'événement, eventId fourni dans le corps", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);

    const response = await authorize(organizer.accessToken, {
      eventId: event.id,
      sizeBytes: 2_000_000,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().key).toContain(`events/${event.id}/originals/`);
  });

  it("refuse un appel organisateur sans eventId", async () => {
    const response = await authorize(organizer.accessToken, { sizeBytes: 2_000_000 });
    expect(response.statusCode).toBe(400);
  });

  it("refuse l'événement d'un autre organisateur (404, jamais 403)", async () => {
    const victime = await registerOrganizer(ctx.app);
    const event = await createEvent(ctx.app, victime.accessToken);

    const response = await authorize(organizer.accessToken, {
      eventId: event.id,
      sizeBytes: 2_000_000,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EVENT_NOT_FOUND");
  });

  describe("session invalide refusée", () => {
    it("refuse une requête sans en-tête Authorization", async () => {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/uploads/authorize",
        payload: { sizeBytes: 1000 },
      });
      expect(response.statusCode).toBe(401);
    });

    it("refuse un jeton qui n'est ni un invité ni un organisateur valide", async () => {
      const response = await authorize("pas-un-jeton-valide", { sizeBytes: 1000 });
      expect(response.statusCode).toBe(401);
    });

    it("refuse le jeton d'une session invitée supprimée en base", async () => {
      const event = await createEvent(ctx.app, organizer.accessToken);
      const guest = await joinAsGuest(ctx.app, event.id, {
        deviceId: "device-upload-revoque-00001",
      });

      await ctx.db
        .delete(guestSessions)
        .where(eq(guestSessions.id, guest.session.id));

      const response = await authorize(guest.guestToken, { sizeBytes: 1000 });
      expect(response.statusCode).toBe(401);
    });
  });

  it("refuse une taille annoncée au-delà de 15 Mo", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-upload-trop-gros-0001",
    });

    const response = await authorize(guest.guestToken, {
      sizeBytes: 15 * 1024 * 1024 + 1,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });

  it("refuse un upload tant que l'événement n'est pas ACTIVE_LOCKED", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-upload-revele-000001",
    });

    await ctx.db
      .update(events)
      .set({ status: "REVEALED" })
      .where(eq(events.id, event.id));

    const response = await authorize(guest.guestToken, { sizeBytes: 1000 });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EVENT_NOT_ACTIVE_LOCKED");
  });

  it("refuse un upload au-delà du quota de photos par session", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-quota-session-000001",
    });

    for (let i = 0; i < testEnv.SESSION_PHOTO_QUOTA; i++) {
      await insertConfirmedPhoto(event.id, guest.session.id);
    }

    const response = await authorize(guest.guestToken, { sizeBytes: 1000 });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SESSION_QUOTA_EXCEEDED");
  });

  it("refuse un upload au-delà du quota de photos par événement, même sous le quota par session", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);

    // Plusieurs sessions distinctes, chacune très en-dessous du quota par
    // session : seul le total de l'événement doit bloquer la suivante.
    for (let i = 0; i < testEnv.EVENT_PHOTO_QUOTA; i++) {
      const guest = await joinAsGuest(ctx.app, event.id, {
        deviceId: `device-quota-event-${String(i).padStart(4, "0")}`,
      });
      await insertConfirmedPhoto(event.id, guest.session.id);
    }

    const dernierInvite = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-quota-event-dernier01",
    });
    const response = await authorize(dernierInvite.guestToken, { sizeBytes: 1000 });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EVENT_QUOTA_EXCEEDED");
  });
});
