import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, favorites, guestSessions, photos } from "../src/db/schema.js";
import { runExpirationSweep } from "../src/services/expiration.js";
import {
  eventExportPrefix,
  exportKey,
  originalKey,
  previewKey,
  thumbnailKey,
} from "../src/storage/keys.js";
import type { ObjectStorage } from "../src/storage/types.js";
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

let deviceCounter = 0;
function nextDeviceId(): string {
  deviceCounter += 1;
  return `device-expir-${String(deviceCounter).padStart(12, "0")}`;
}

const sweep = (override: Partial<{ storage: ObjectStorage }> = {}) =>
  runExpirationSweep({
    db: ctx.db,
    storage: override.storage ?? storage,
  });

async function readEvent(eventId: string) {
  const [row] = await ctx.db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row;
}

async function countRows(eventId: string) {
  const photoRows = await ctx.db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.eventId, eventId));
  const sessionRows = await ctx.db
    .select({ id: guestSessions.id })
    .from(guestSessions)
    .where(eq(guestSessions.eventId, eventId));
  return { photos: photoRows.length, guestSessions: sessionRows.length };
}

/**
 * L'API refuse un `deleteAt` déjà passé (il se déduit de `revealAt`, qui doit
 * être dans le futur) : on antidate la ligne, exactement comme le fait la
 * commande SQL documentée dans le README pour un test manuel.
 */
async function makeDue(
  eventId: string,
  status: "ACTIVE_LOCKED" | "REVEALED" | "EXPIRED" = "REVEALED"
): Promise<void> {
  await ctx.db
    .update(events)
    .set({ deleteAt: new Date(Date.now() - 60_000), status })
    .where(eq(events.id, eventId));
}

/**
 * Un événement complet : session invité, photo confirmée en base, et les trois
 * fichiers correspondants sur le stockage.
 */
async function seedFullEvent(
  options: { withFavorite?: boolean; withExport?: boolean } = {}
) {
  const event = await createEvent(ctx.app, organizer.accessToken);
  const guest = await joinAsGuest(ctx.app, event.id, { deviceId: nextDeviceId() });

  const photoId = randomUUID();
  const keys = [
    originalKey(event.id, photoId),
    previewKey(event.id, photoId),
    thumbnailKey(event.id, photoId),
  ];
  for (const key of keys) {
    storage.seed(key, Buffer.from("photo"), "image/jpeg");
  }

  await ctx.db.insert(photos).values({
    id: photoId,
    eventId: event.id,
    guestSessionId: guest.session.id,
    originalKey: keys[0]!,
    previewKey: keys[1]!,
    thumbnailKey: keys[2]!,
    capturedAt: new Date(),
    status: "READY",
  });

  if (options.withFavorite) {
    await ctx.db.insert(favorites).values({
      photoId,
      guestSessionId: guest.session.id,
    });
  }

  const exportObjectKey = exportKey(event.id, "souvenirs.zip");
  if (options.withExport) {
    storage.seed(exportObjectKey, Buffer.from("zip"), "application/zip");
  }

  return { event, guest, photoId, keys, exportObjectKey };
}

describe("Balayage d'expiration", () => {
  it("supprime fichiers et données, et passe l'événement à EXPIRED", async () => {
    const { event, photoId, keys, exportObjectKey } = await seedFullEvent({
      withFavorite: true,
      withExport: true,
    });
    await makeDue(event.id);

    const result = await sweep();

    expect(result.failed).toHaveLength(0);
    expect(result.expired.map((entry) => entry.eventId)).toContain(event.id);

    // Stockage : original, aperçu, vignette et export ZIP.
    for (const key of [...keys, exportObjectKey]) {
      expect(storage.has(key)).toBe(false);
    }
    expect(await storage.listObjects(`events/${event.id}/`)).toEqual([]);
    expect(await storage.listObjects(eventExportPrefix(event.id))).toEqual([]);

    // Base : photos, sessions invité et favoris.
    expect(await countRows(event.id)).toEqual({ photos: 0, guestSessions: 0 });
    const remainingFavorites = await ctx.db
      .select({ id: favorites.id })
      .from(favorites)
      .where(eq(favorites.photoId, photoId));
    expect(remainingFavorites).toHaveLength(0);

    // La ligne `events` survit, vidée : c'est elle qui permet de répondre 410
    // à un vieux lien invité plutôt qu'un 404 indistinct d'une faute de frappe.
    const after = await readEvent(event.id);
    expect(after?.status).toBe("EXPIRED");
  });

  it("ne plante pas et ne change rien à un deuxième passage", async () => {
    const { event } = await seedFullEvent();
    await makeDue(event.id);

    const first = await sweep();
    expect(first.expired.some((entry) => entry.eventId === event.id)).toBe(true);
    const afterFirst = await readEvent(event.id);

    // Deuxième passage : l'événement est déjà EXPIRED, il ne fait plus partie
    // des candidats. Rien à supprimer, rien à réécrire.
    const second = await sweep();
    expect(second.failed).toHaveLength(0);
    expect(second.expired.some((entry) => entry.eventId === event.id)).toBe(false);

    const afterSecond = await readEvent(event.id);
    expect(afterSecond?.status).toBe("EXPIRED");
    expect(afterSecond?.updatedAt.toISOString()).toBe(
      afterFirst?.updatedAt.toISOString()
    );
  });

  it("reprend un événement interrompu à mi-chemin, sans erreur ni doublon", async () => {
    const { event, keys } = await seedFullEvent();
    await makeDue(event.id);

    // État laissé par un worker tué entre la suppression des fichiers et celle
    // de la base : objets partis, lignes encore là, statut pas encore EXPIRED.
    await storage.deleteObjects(keys);

    const result = await sweep();

    expect(result.failed).toHaveLength(0);
    const summary = result.expired.find((entry) => entry.eventId === event.id);
    expect(summary).toBeDefined();
    // Zéro objet supprimé : ils l'étaient déjà. Aucune erreur pour autant.
    expect(summary!.deletedObjects).toBe(0);
    expect(summary!.deletedPhotos).toBe(1);
    expect(await readEvent(event.id).then((row) => row?.status)).toBe("EXPIRED");
  });

  it("supprime un événement échu jamais consulté, resté ACTIVE_LOCKED", async () => {
    // Le cas que la révélation paresseuse de la Phase 5 rend possible : plus
    // personne n'a ouvert cet événement après son revealAt, il n'est donc
    // jamais passé à REVEALED. Filtrer sur REVEALED le rendrait immortel.
    const { event, keys } = await seedFullEvent();
    await makeDue(event.id, "ACTIVE_LOCKED");

    const result = await sweep();

    expect(result.expired.some((entry) => entry.eventId === event.id)).toBe(true);
    expect(keys.every((key) => !storage.has(key))).toBe(true);
    expect(await readEvent(event.id).then((row) => row?.status)).toBe("EXPIRED");
  });

  it("emporte aussi un fichier orphelin, uploadé mais jamais confirmé", async () => {
    const { event } = await seedFullEvent();
    // /uploads/authorize délivre une URL signée sans écrire de ligne : si le
    // client envoie le fichier puis n'appelle jamais /photos/confirm, l'objet
    // existe sans aucune trace en base. Supprimer seulement les clés connues
    // de la base le laisserait sur Scaleway pour toujours.
    const orphelin = originalKey(event.id, randomUUID());
    storage.seed(orphelin, Buffer.from("jamais confirme"), "image/jpeg");
    await makeDue(event.id);

    await sweep();

    expect(storage.has(orphelin)).toBe(false);
  });

  it("laisse intact un événement dont l'échéance n'est pas atteinte", async () => {
    const encoreVivant = await seedFullEvent();
    const echu = await seedFullEvent();
    await makeDue(echu.event.id);

    await sweep();

    expect(await readEvent(encoreVivant.event.id).then((row) => row?.status)).toBe(
      "ACTIVE_LOCKED"
    );
    expect(encoreVivant.keys.every((key) => storage.has(key))).toBe(true);
    expect(await countRows(encoreVivant.event.id)).toEqual({
      photos: 1,
      guestSessions: 1,
    });
  });

  it("isole les échecs : un événement en erreur n'empêche pas les autres", async () => {
    const casse = await seedFullEvent();
    const sain = await seedFullEvent();
    await makeDue(casse.event.id);
    await makeDue(sain.event.id);

    // Stockage qui refuse de lister les objets d'un seul événement — une panne
    // de bucket, un droit retiré, une coupure réseau au mauvais moment.
    const stockageCapricieux: ObjectStorage = {
      ...storage,
      async listObjects(prefix) {
        if (prefix.includes(casse.event.id)) {
          throw new Error("Scaleway injoignable pour cet événement");
        }
        return storage.listObjects(prefix);
      },
    };

    const result = await sweep({ storage: stockageCapricieux });

    // L'événement sain est bel et bien supprimé, malgré l'échec de l'autre.
    expect(result.expired.map((entry) => entry.eventId)).toContain(sain.event.id);
    expect(sain.keys.every((key) => !storage.has(key))).toBe(true);
    expect(await readEvent(sain.event.id).then((row) => row?.status)).toBe("EXPIRED");

    // L'événement en échec est signalé et reste intact : il sera repris.
    expect(result.failed.map((entry) => entry.eventId)).toEqual([casse.event.id]);
    expect(casse.keys.every((key) => storage.has(key))).toBe(true);
    expect(await readEvent(casse.event.id).then((row) => row?.status)).not.toBe(
      "EXPIRED"
    );

    // Et la reprise fonctionne dès que le stockage répond de nouveau.
    const reprise = await sweep();
    expect(reprise.expired.map((entry) => entry.eventId)).toContain(casse.event.id);
    expect(casse.keys.every((key) => storage.has(key))).toBe(false);
    expect(await readEvent(casse.event.id).then((row) => row?.status)).toBe(
      "EXPIRED"
    );
  });

  it("ne touche à rien quand aucun événement n'est échu", async () => {
    const result = await sweep();

    expect(result.found).toBe(0);
    expect(result.expired).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("borne le nombre d'événements traités par passage", async () => {
    const premier = await seedFullEvent();
    const second = await seedFullEvent();
    await makeDue(premier.event.id);
    await makeDue(second.event.id);

    const result = await runExpirationSweep({
      db: ctx.db,
      storage,
      batchSize: 1,
    });

    expect(result.found).toBe(1);
    expect(result.expired).toHaveLength(1);

    // Le reste part au passage suivant, rien n'est perdu.
    const suite = await runExpirationSweep({ db: ctx.db, storage, batchSize: 1 });
    expect(suite.expired).toHaveLength(1);
    expect(await readEvent(premier.event.id).then((row) => row?.status)).toBe(
      "EXPIRED"
    );
    expect(await readEvent(second.event.id).then((row) => row?.status)).toBe(
      "EXPIRED"
    );
  });
});

describe("Accès après expiration", () => {
  it("renvoie 410 à un invité qui rouvre un lien expiré", async () => {
    const { event } = await seedFullEvent();
    await makeDue(event.id);
    await sweep();

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/events/${event.id}/guest/join`,
      payload: { nickname: "Retardataire", deviceId: nextDeviceId() },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("EVENT_EXPIRED");
  });
});
