import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guestSessions, photos } from "../src/db/schema.js";
import { originalKey } from "../src/storage/keys.js";
import {
  createEvent,
  createFakeObjectStorage,
  createTestContext,
  joinAsGuest,
  registerOrganizer,
  type FakeObjectStorage,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let storage: FakeObjectStorage;
let organizer: Awaited<ReturnType<typeof registerOrganizer>>;

beforeAll(async () => {
  storage = createFakeObjectStorage();
  ctx = await createTestContext({ storage });
  organizer = await registerOrganizer(ctx.app);
});

afterAll(async () => {
  await ctx.close();
});

/** JPEG minimal mais réel (magic bytes valides), généré par Sharp lui-même. */
async function realJpegBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function realWebpBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .webp()
    .toBuffer();
}

function confirm(token: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/photos/confirm",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("POST /api/v1/photos/confirm", () => {
  it("valide un JPEG réel, génère thumbnail et preview, passe en READY", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-ok-000000001",
    });

    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    storage.seed(key, await realJpegBuffer(), "image/jpeg");

    const response = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("READY");
    expect(body.thumbnailKey).toBe(`events/${event.id}/thumbnails/${photoId}.jpg`);
    expect(body.previewKey).toBe(`events/${event.id}/previews/${photoId}.jpg`);
    expect(storage.has(body.thumbnailKey)).toBe(true);
    expect(storage.has(body.previewKey)).toBe(true);

    const thumb = storage.get(body.thumbnailKey)!;
    const thumbMeta = await sharp(thumb.body).metadata();
    expect(thumbMeta.format).toBe("jpeg");
    expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(400);

    const preview = storage.get(body.previewKey)!;
    const previewMeta = await sharp(preview.body).metadata();
    expect(previewMeta.format).toBe("jpeg");
  });

  it("accepte un WebP valide", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-webp-000001",
    });

    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    storage.seed(key, await realWebpBuffer(), "image/webp");

    const response = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("READY");
  });

  it("rejette un fichier renommé .jpg qui n'est pas un vrai JPEG, malgré un Content-Type falsifié", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-faux-0000001",
    });

    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    // Texte brut, pas une image — mais Content-Type déclaré frauduleusement
    // par le client, exactement comme dans un vrai renommage .txt -> .jpg.
    storage.seed(key, Buffer.from("ceci n'est pas une image"), "image/jpeg");

    const response = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("FAILED");
    // Le faux fichier est retiré du bucket : jamais servi comme photo valide.
    expect(storage.has(key)).toBe(false);
  });

  it("rejette un fichier trop volumineux (> 15 Mo), même avec un Content-Type valide", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-gros-0000001",
    });

    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    storage.seed(key, Buffer.alloc(15 * 1024 * 1024 + 1, 1), "image/jpeg");

    const response = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("FAILED");
    expect(storage.has(key)).toBe(false);
  });

  it("404 ORIGINAL_NOT_FOUND si le fichier n'a jamais été uploadé", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-absent-000001",
    });

    const response = await confirm(guest.guestToken, {
      photoId: randomUUID(),
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ORIGINAL_NOT_FOUND");
  });

  it("est idempotent : un second appel renvoie le même résultat sans retraiter", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-confirm-idem-0000001",
    });

    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    storage.seed(key, await realJpegBuffer(), "image/jpeg");

    const first = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });
    expect(first.statusCode).toBe(200);

    const second = await confirm(guest.guestToken, {
      photoId,
      capturedAt: new Date().toISOString(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("accepte l'organisateur propriétaire de l'événement, eventId dans le corps", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const photoId = randomUUID();
    const key = originalKey(event.id, photoId);
    storage.seed(key, await realJpegBuffer(), "image/jpeg");

    const response = await confirm(organizer.accessToken, {
      photoId,
      eventId: event.id,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("READY");
  });

  it("auto-provisionne une session invité pour l'organisateur, réutilisée d'une photo à l'autre (guest_session_id reste NOT NULL)", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);

    const firstPhotoId = randomUUID();
    storage.seed(originalKey(event.id, firstPhotoId), await realJpegBuffer(), "image/jpeg");
    const first = await confirm(organizer.accessToken, {
      photoId: firstPhotoId,
      eventId: event.id,
      capturedAt: new Date().toISOString(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("READY");

    const secondPhotoId = randomUUID();
    storage.seed(originalKey(event.id, secondPhotoId), await realJpegBuffer(), "image/jpeg");
    const second = await confirm(organizer.accessToken, {
      photoId: secondPhotoId,
      eventId: event.id,
      capturedAt: new Date().toISOString(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("READY");

    const [firstRow] = await ctx.db
      .select()
      .from(photos)
      .where(eq(photos.id, firstPhotoId));
    const [secondRow] = await ctx.db
      .select()
      .from(photos)
      .where(eq(photos.id, secondPhotoId));

    expect(firstRow!.guestSessionId).not.toBeNull();
    // Même session réutilisée pour les deux photos, pas une par appel.
    expect(secondRow!.guestSessionId).toBe(firstRow!.guestSessionId);

    const sessions = await ctx.db
      .select()
      .from(guestSessions)
      .where(
        and(
          eq(guestSessions.eventId, event.id),
          eq(guestSessions.deviceId, `organizer:${organizer.organizerId}`)
        )
      );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(firstRow!.guestSessionId);
  });

  it("refuse une confirmation organisateur sans eventId", async () => {
    const response = await confirm(organizer.accessToken, {
      photoId: randomUUID(),
      capturedAt: new Date().toISOString(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuse l'événement d'un autre organisateur (404, jamais 403)", async () => {
    const victime = await registerOrganizer(ctx.app);
    const event = await createEvent(ctx.app, victime.accessToken);

    const response = await confirm(organizer.accessToken, {
      photoId: randomUUID(),
      eventId: event.id,
      capturedAt: new Date().toISOString(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EVENT_NOT_FOUND");
  });
});
