import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, photos } from "../src/db/schema.js";
import { previewKey, thumbnailKey } from "../src/storage/keys.js";
import {
  createEvent,
  createTestContext,
  daysFromNow,
  joinAsGuest,
  registerOrganizer,
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

const organizerAuth = () => ({ authorization: `Bearer ${organizer.accessToken}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let deviceCounter = 0;
/** deviceId unique par appel : deux invités d'un même test ne se partagent pas une session. */
function nextDeviceId(): string {
  deviceCounter += 1;
  return `device-reveal-${String(deviceCounter).padStart(12, "0")}`;
}

/**
 * L'API refuse un `revealAt` dans le passé à la création (routes/events.ts) :
 * c'est une règle produit, pas une limite de test. Pour observer la bascule
 * automatique sans attendre une vraie échéance, on antidate la ligne
 * directement en base — exactement l'état dans lequel se trouve un événement
 * dont l'heure vient de passer. `deleteAt` reste dans le futur : on teste ici
 * la révélation, pas l'expiration.
 */
async function backdateRevealAt(eventId: string): Promise<void> {
  await ctx.db
    .update(events)
    .set({ revealAt: new Date(Date.now() - 60_000) })
    .where(eq(events.id, eventId));
}

async function setStatus(
  eventId: string,
  status: "ACTIVE_LOCKED" | "REVEALED" | "EXPIRED"
): Promise<void> {
  await ctx.db.update(events).set({ status }).where(eq(events.id, eventId));
}

async function readStatus(eventId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row!.status;
}

/** Insère une photo déjà confirmée (Phase 4), sans rejouer tout le cycle d'upload. */
async function seedPhoto(
  eventId: string,
  guestSessionId: string,
  overrides: Partial<{
    status: "PENDING" | "READY" | "FAILED";
    capturedAt: Date;
  }> = {}
): Promise<string> {
  const photoId = randomUUID();
  const status = overrides.status ?? "READY";
  const ready = status === "READY";

  await ctx.db.insert(photos).values({
    id: photoId,
    eventId,
    guestSessionId,
    originalKey: `events/${eventId}/originals/${photoId}.jpg`,
    thumbnailKey: ready ? thumbnailKey(eventId, photoId) : null,
    previewKey: ready ? previewKey(eventId, photoId) : null,
    capturedAt: overrides.capturedAt ?? new Date(),
    status,
  });

  return photoId;
}

function listPhotos(eventId: string, token: string, query = "") {
  return ctx.app.inject({
    method: "GET",
    url: `/api/v1/events/${eventId}/photos${query}`,
    headers: bearer(token),
  });
}

function reveal(eventId: string, token = organizer.accessToken) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/events/${eventId}/reveal`,
    headers: bearer(token),
  });
}

/** Un événement avec un invité et une photo prête, encore verrouillé. */
async function scenario() {
  const event = await createEvent(ctx.app, organizer.accessToken);
  const guest = await joinAsGuest(ctx.app, event.id, { deviceId: nextDeviceId() });
  const photoId = await seedPhoto(event.id, guest.session.id);
  return { event, guest, photoId };
}

describe("Gate de révélation — avant l'heure", () => {
  it("ne donne aucune photo à l'invité tant que l'événement est verrouillé", async () => {
    const { event, guest } = await scenario();

    const response = await listPhotos(event.id, guest.guestToken);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PHOTOS_NOT_REVEALED");
  });

  it("n'en donne pas davantage à l'organisateur, propriétaire de l'événement", async () => {
    const { event } = await scenario();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}/photos`,
      headers: organizerAuth(),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error.code).toBe("PHOTOS_NOT_REVEALED");
    // Le détail sert le compte à rebours du client : l'échéance, et l'heure du
    // serveur qui fait foi — jamais celle du navigateur.
    expect(body.error.details.status).toBe("ACTIVE_LOCKED");
    expect(body.error.details.revealAt).toBe(event.revealAt);
    expect(Date.parse(body.error.details.serverTime)).toBeGreaterThan(0);
  });

  it("refuse aussi le téléchargement direct d'une photo précise", async () => {
    const { guest, photoId } = await scenario();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/photos/${photoId}/download`,
      headers: bearer(guest.guestToken),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PHOTOS_NOT_REVEALED");
  });

  it("ignore toute heure envoyée par le client (section 21)", async () => {
    const { event, guest } = await scenario();
    const mensonge = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();

    // Un client qui prétend être après l'heure de révélation, par tous les
    // canaux qu'il contrôle : date HTTP, en-tête maison, paramètres de requête.
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}/photos?now=${encodeURIComponent(mensonge)}&revealAt=${encodeURIComponent(mensonge)}`,
      headers: {
        ...bearer(guest.guestToken),
        date: mensonge,
        "x-client-time": mensonge,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PHOTOS_NOT_REVEALED");
    // Et l'horloge du client n'a rien écrit en base non plus.
    expect(await readStatus(event.id)).toBe("ACTIVE_LOCKED");
  });
});

describe("POST /api/v1/events/:eventId/reveal — révélation anticipée", () => {
  it("ouvre l'accès immédiatement, alors que revealAt est encore dans le futur", async () => {
    const { event, guest, photoId } = await scenario();

    const revealed = await reveal(event.id);
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().status).toBe("REVEALED");
    // Révélation *anticipée* : l'échéance planifiée n'a pas bougé, c'est bien
    // le statut qui commande l'accès.
    expect(new Date(revealed.json().revealAt).getTime()).toBeGreaterThan(Date.now());

    const asGuest = await listPhotos(event.id, guest.guestToken);
    expect(asGuest.statusCode).toBe(200);

    const body = asGuest.json();
    expect(body.total).toBe(1);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0].id).toBe(photoId);
    expect(body.photos[0].thumbnailUrl).toContain(`/thumbnails/${photoId}.jpg`);
    expect(body.photos[0].previewUrl).toContain(`/previews/${photoId}.jpg`);
    // URL signée à durée limitée, pas un lien public permanent.
    expect(body.photos[0].previewUrl).toContain("X-Amz-Signature");
    expect(Date.parse(body.urlsExpireAt)).toBeGreaterThan(Date.now());

    const asOrganizer = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}/photos`,
      headers: organizerAuth(),
    });
    expect(asOrganizer.statusCode).toBe(200);
    expect(asOrganizer.json().total).toBe(1);
  });

  it("est idempotent : deux appels de suite laissent le même état", async () => {
    const { event } = await scenario();

    const first = await reveal(event.id);
    const second = await reveal(event.id);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("REVEALED");
    // Aucune seconde écriture : l'événement n'est pas "re-révélé".
    expect(second.json().updatedAt).toBe(first.json().updatedAt);
    expect(second.json().revealAt).toBe(first.json().revealAt);
    expect(await readStatus(event.id)).toBe("REVEALED");
  });

  it("reste réservé au propriétaire de l'événement", async () => {
    const { event } = await scenario();
    const autre = await registerOrganizer(ctx.app);

    const response = await reveal(event.id, autre.accessToken);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EVENT_NOT_FOUND");
    expect(await readStatus(event.id)).toBe("ACTIVE_LOCKED");
  });

  it("refuse un jeton invité", async () => {
    const { event, guest } = await scenario();

    const response = await reveal(event.id, guest.guestToken);

    expect(response.statusCode).toBe(401);
    expect(await readStatus(event.id)).toBe("ACTIVE_LOCKED");
  });

  it("refuse un événement expiré : ses photos n'existent plus", async () => {
    const { event } = await scenario();
    await setStatus(event.id, "EXPIRED");

    const response = await reveal(event.id);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EVENT_EXPIRED");
    expect(await readStatus(event.id)).toBe("EXPIRED");
  });
});

describe("Irréversibilité (section 6)", () => {
  it("refuse de reverrouiller en repoussant revealAt après la révélation", async () => {
    const { event, guest } = await scenario();
    await reveal(event.id);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: organizerAuth(),
      payload: { revealAt: daysFromNow(60) },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EVENT_ALREADY_REVEALED");
    expect(await readStatus(event.id)).toBe("REVEALED");

    // Et les photos sont toujours accessibles : rien n'a été refermé.
    const stillOpen = await listPhotos(event.id, guest.guestToken);
    expect(stillOpen.statusCode).toBe(200);
  });

  it("refuse toute modification de l'événement après révélation, même le nom", async () => {
    const { event } = await scenario();
    await reveal(event.id);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: organizerAuth(),
      payload: { name: "Tentative de renommage" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EVENT_ALREADY_REVEALED");
  });

  it("n'expose aucune transition REVEALED -> ACTIVE_LOCKED", async () => {
    const { event } = await scenario();
    await reveal(event.id);

    // Il n'existe pas de route inverse : la seule qui touche au statut est
    // /reveal, et elle ne sait que révéler.
    const inverse = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/events/${event.id}/lock`,
      headers: organizerAuth(),
    });
    expect(inverse.statusCode).toBe(404);
    expect(inverse.json().error.code).toBe("ROUTE_NOT_FOUND");

    expect((await reveal(event.id)).json().status).toBe("REVEALED");
    expect(await readStatus(event.id)).toBe("REVEALED");
  });
});

describe("Révélation automatique à l'échéance", () => {
  it("bascule l'événement sans aucune action de l'organisateur", async () => {
    const { event, guest, photoId } = await scenario();
    await backdateRevealAt(event.id);
    expect(await readStatus(event.id)).toBe("ACTIVE_LOCKED");

    // Aucun appel à /reveal ici : c'est la consultation qui déclenche la
    // bascule, parce que l'heure du serveur a dépassé revealAt.
    const response = await listPhotos(event.id, guest.guestToken);

    expect(response.statusCode).toBe(200);
    expect(response.json().event.status).toBe("REVEALED");
    expect(response.json().photos[0].id).toBe(photoId);
    // La bascule est persistée, pas seulement calculée pour la réponse.
    expect(await readStatus(event.id)).toBe("REVEALED");
  });

  it("se déclenche aussi à la jonction d'un invité", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    await backdateRevealAt(event.id);

    const guest = await joinAsGuest(ctx.app, event.id, { deviceId: nextDeviceId() });

    expect(guest.event.status).toBe("REVEALED");
    expect(await readStatus(event.id)).toBe("REVEALED");
  });

  it("se déclenche aussi quand l'organisateur liste ses événements", async () => {
    const solo = await registerOrganizer(ctx.app);
    const event = await createEvent(ctx.app, solo.accessToken);
    await backdateRevealAt(event.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(solo.accessToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events[0].status).toBe("REVEALED");
    expect(await readStatus(event.id)).toBe("REVEALED");
  });

  it("ne ressuscite pas un événement expiré dont l'heure est passée", async () => {
    const { event, guest } = await scenario();
    await backdateRevealAt(event.id);
    await setStatus(event.id, "EXPIRED");

    const response = await listPhotos(event.id, guest.guestToken);

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("EVENT_EXPIRED");
    expect(await readStatus(event.id)).toBe("EXPIRED");
  });
});

describe("Contenu servi après révélation", () => {
  it("ne liste que les photos réellement prêtes", async () => {
    const { event, guest, photoId } = await scenario();
    await seedPhoto(event.id, guest.session.id, { status: "PENDING" });
    await seedPhoto(event.id, guest.session.id, { status: "FAILED" });
    await reveal(event.id);

    const body = (await listPhotos(event.id, guest.guestToken)).json();

    expect(body.total).toBe(1);
    expect(body.photos.map((photo: { id: string }) => photo.id)).toEqual([photoId]);
  });

  it("pagine dans l'ordre chronologique de prise de vue", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, { deviceId: nextDeviceId() });

    const base = Date.now() - 3 * 3600 * 1000;
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(
        await seedPhoto(event.id, guest.session.id, {
          capturedAt: new Date(base + index * 60_000),
        })
      );
    }
    await reveal(event.id);

    const firstPage = (await listPhotos(event.id, guest.guestToken, "?limit=2")).json();
    expect(firstPage.total).toBe(3);
    expect(firstPage.photos.map((photo: { id: string }) => photo.id)).toEqual(
      ids.slice(0, 2)
    );

    const secondPage = (
      await listPhotos(event.id, guest.guestToken, "?limit=2&offset=2")
    ).json();
    expect(secondPage.photos.map((photo: { id: string }) => photo.id)).toEqual(
      ids.slice(2)
    );
  });

  it("sert l'aperçu nettoyé au téléchargement, jamais l'original", async () => {
    const { event, guest, photoId } = await scenario();
    await reveal(event.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/photos/${photoId}/download`,
      headers: bearer(guest.guestToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // L'original porte encore son EXIF (donc potentiellement le GPS) et ne
    // doit jamais quitter le serveur (section 15).
    expect(body.url).toContain(`/previews/${photoId}.jpg`);
    expect(body.url).not.toContain("/originals/");
    expect(body.filename).toMatch(/^mariage-de-camille-et-sofiane-.*\.jpg$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("ne laisse pas un invité lire les photos d'un autre événement", async () => {
    const cible = await scenario();
    await reveal(cible.event.id);

    const autreEvent = await createEvent(ctx.app, organizer.accessToken);
    const intrus = await joinAsGuest(ctx.app, autreEvent.id, {
      deviceId: nextDeviceId(),
    });

    const liste = await listPhotos(cible.event.id, intrus.guestToken);
    expect(liste.statusCode).toBe(404);
    expect(liste.json().error.code).toBe("EVENT_NOT_FOUND");

    const telechargement = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/photos/${cible.photoId}/download`,
      headers: bearer(intrus.guestToken),
    });
    expect(telechargement.statusCode).toBe(404);
    expect(telechargement.json().error.code).toBe("PHOTO_NOT_FOUND");
  });

  it("lie le jeton à l'événement de la photo, pas seulement à son état", async () => {
    // Deux événements révélés, chacun avec une photo READY : tout ce qui
    // pourrait justifier un refus par ailleurs (événement verrouillé, photo
    // non prête, jeton expiré) est neutralisé. Il ne reste à tester que la
    // liaison jeton -> événement propriétaire de la photo.
    const a = await scenario();
    await reveal(a.event.id);

    const b = await scenario();
    await reveal(b.event.id);

    const download = (photoId: string, token: string) =>
      ctx.app.inject({
        method: "GET",
        url: `/api/v1/photos/${photoId}/download`,
        headers: bearer(token),
      });

    // Le même jeton, dans la même seconde : accepté sur sa propre photo...
    const sienne = await download(b.photoId, b.guest.guestToken);
    expect(sienne.statusCode).toBe(200);

    // ...refusé sur celle de l'autre événement, malgré une photo READY dans un
    // événement bel et bien révélé. Et 404, pas 403 : l'API ne confirme pas
    // l'existence de la photo d'un événement auquel on n'a pas droit.
    const voisine = await download(a.photoId, b.guest.guestToken);
    expect(voisine.statusCode).toBe(404);
    expect(voisine.json().error.code).toBe("PHOTO_NOT_FOUND");

    // Symétrique, pour que le test ne passe pas par hasard sur un seul sens.
    const inverse = await download(b.photoId, a.guest.guestToken);
    expect(inverse.statusCode).toBe(404);
    expect(inverse.json().error.code).toBe("PHOTO_NOT_FOUND");
  });

  it("ne laisse pas un autre organisateur lire les photos d'un événement révélé", async () => {
    const { event, photoId } = await scenario();
    await reveal(event.id);
    const autre = await registerOrganizer(ctx.app);

    const liste = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}/photos`,
      headers: bearer(autre.accessToken),
    });
    expect(liste.statusCode).toBe(404);

    const telechargement = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/photos/${photoId}/download`,
      headers: bearer(autre.accessToken),
    });
    expect(telechargement.statusCode).toBe(404);
  });
});
