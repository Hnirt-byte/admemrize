import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEvent,
  createFakeObjectStorage,
  createTestContext,
  daysFromNow,
  joinAsGuest,
  registerOrganizer,
  type FakeObjectStorage,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let storage: FakeObjectStorage;
let organizer: Awaited<ReturnType<typeof registerOrganizer>>;

beforeAll(async () => {
  // Stockage en mémoire : depuis la Phase 6, DELETE /events/:eventId purge
  // aussi les objets de l'événement (services/expiration.ts), ce qui touche
  // réellement la couche de stockage.
  storage = createFakeObjectStorage();
  ctx = await createTestContext({ storage });
  organizer = await registerOrganizer(ctx.app);
});

afterAll(async () => {
  await ctx.close();
});

const auth = () => ({ authorization: `Bearer ${organizer.accessToken}` });

describe("CRUD événements", () => {
  it("crée un événement et calcule deleteAt à partir de la rétention", async () => {
    const revealAt = daysFromNow(10);
    const event = await createEvent(ctx.app, organizer.accessToken, {
      name: "Anniversaire de Louis",
      type: "ANNIVERSAIRE",
      revealAt,
      retentionHours: 48,
    });

    expect(event.status).toBe("ACTIVE_LOCKED");
    expect(new Date(event.deleteAt).getTime() - new Date(revealAt).getTime()).toBe(
      48 * 3600 * 1000
    );
  });

  it("refuse une date de révélation dans le passé", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: auth(),
      payload: {
        name: "Événement rétroactif",
        type: "FETE",
        eventDate: daysFromNow(-10),
        revealAt: daysFromNow(-1),
        retentionHours: 24,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });

  it("ne liste que les événements de l'organisateur connecté", async () => {
    const autre = await registerOrganizer(ctx.app);
    await createEvent(ctx.app, autre.accessToken, { name: "Événement d'un tiers" });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const noms = response.json().events.map((e: { name: string }) => e.name);
    expect(noms).not.toContain("Événement d'un tiers");
  });

  it("met à jour un événement et conserve la rétention quand seule la révélation bouge", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken, {
      retentionHours: 72,
    });
    const nouvelleRevelation = daysFromNow(40);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
      payload: { name: "Mariage — nouvelle date", revealAt: nouvelleRevelation },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json();
    expect(updated.name).toBe("Mariage — nouvelle date");
    expect(
      new Date(updated.deleteAt).getTime() - new Date(updated.revealAt).getTime()
    ).toBe(72 * 3600 * 1000);
  });

  it("refuse une mise à jour vide", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("supprime un événement et ses sessions invité", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const guest = await joinAsGuest(ctx.app, event.id, {
      deviceId: "device-suppression-000000001",
    });

    const deletion = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
    });
    expect(deletion.statusCode).toBe(204);

    const relecture = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
    });
    expect(relecture.statusCode).toBe(404);

    // La session invité disparaît avec l'événement : son jeton ne vaut plus rien.
    const jetonInvite = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: { authorization: `Bearer ${guest.guestToken}` },
    });
    expect(jetonInvite.statusCode).toBe(401);
  });

  it("emporte aussi les fichiers de l'événement (Phase 6)", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const cle = `events/${event.id}/originals/${randomUUID()}.jpg`;
    storage.seed(cle, Buffer.from("photo"), "image/jpeg");

    const deletion = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
    });

    expect(deletion.statusCode).toBe(204);
    // Sans cette purge, les objets survivraient à la ligne `events` qui les
    // désignait — plus rien en base pour dire qu'ils existent, donc plus rien
    // pour les supprimer un jour.
    expect(storage.has(cle)).toBe(false);
  });

  it("interdit de modifier ou supprimer l'événement d'un autre organisateur", async () => {
    const victime = await registerOrganizer(ctx.app);
    const event = await createEvent(ctx.app, victime.accessToken, {
      name: "Événement privé",
    });

    const modification = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
      payload: { name: "Détourné" },
    });
    const suppression = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/events/${event.id}`,
      headers: auth(),
    });

    expect(modification.statusCode).toBe(404);
    expect(suppression.statusCode).toBe(404);

    // L'événement est intact pour son propriétaire légitime.
    const relecture = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}`,
      headers: { authorization: `Bearer ${victime.accessToken}` },
    });
    expect(relecture.statusCode).toBe(200);
    expect(relecture.json().name).toBe("Événement privé");
  });
});

describe("jonction invité", () => {
  it("crée une session invité et renvoie une vue réduite de l'événement", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken, {
      name: "Soirée d'entreprise",
      type: "ENTREPRISE",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/events/${event.id}/guest/join`,
      payload: { nickname: "Léa", deviceId: "device-lea-00000000000001" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.session.nickname).toBe("Léa");
    expect(body.session.expiresAt).toBe(event.deleteAt); // le jeton meurt avec l'événement
    expect(body.event.name).toBe("Soirée d'entreprise");
    // Aucune donnée d'organisation ne fuit vers l'invité.
    expect(body.event).not.toHaveProperty("deleteAt");
    expect(body.event).not.toHaveProperty("ownerId");
  });

  it("réutilise la session existante quand le même appareil revient", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);
    const deviceId = "device-retour-0000000000001";

    const premier = await joinAsGuest(ctx.app, event.id, {
      nickname: "Tonton Bernard",
      deviceId,
    });
    const second = await joinAsGuest(ctx.app, event.id, {
      nickname: "Bernard",
      deviceId,
    });

    expect(second.session.id).toBe(premier.session.id);
    expect(second.session.nickname).toBe("Bernard");

    // Le jeton est renouvelé : l'ancien ne doit plus être accepté.
    const ancien = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: { authorization: `Bearer ${premier.guestToken}` },
    });
    expect(ancien.statusCode).toBe(401);

    const nouveau = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: { authorization: `Bearer ${second.guestToken}` },
    });
    expect(nouveau.statusCode).toBe(200);
  });

  it("refuse un pseudo vide ou un deviceId trop court", async () => {
    const event = await createEvent(ctx.app, organizer.accessToken);

    for (const payload of [
      { nickname: "", deviceId: "device-valide-000000000001" },
      { nickname: "Léa", deviceId: "court" },
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/events/${event.id}/guest/join`,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
