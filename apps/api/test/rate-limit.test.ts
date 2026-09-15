import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEvent,
  createFakeObjectStorage,
  createTestContext,
  joinAsGuest,
  registerOrganizer,
  type TestContext,
} from "./helpers.js";

/**
 * Le scénario que ces tests protègent : cent invités sur le Wi-Fi d'une salle
 * des fêtes, donc une seule IP publique pour tout le monde. Tant que le quota
 * était compté par IP, le premier invité à vider sa file de photos bloquait
 * tous les autres. Ces tests vérifient qu'une session ne peut plus consommer
 * que son propre quota.
 *
 * Plafond volontairement ridicule (3 appels) : ce qui est testé est la clé de
 * comptage, pas sa valeur. Émettre 300 requêtes pour prouver la même chose ne
 * ferait qu'allonger la suite.
 */
const SESSION_MAX = 3;

/** Toutes les requêtes injectées partent de la même adresse : c'est le Wi-Fi de la salle. */
const SALLE_DES_FETES = "203.0.113.10";

let ctx: TestContext;
let organizer: Awaited<ReturnType<typeof registerOrganizer>>;
let eventId: string;

beforeAll(async () => {
  ctx = await createTestContext({
    enableRateLimit: true,
    // Double en mémoire : la confirmation de photo interroge réellement le
    // stockage, et l'adaptateur Scaleway ferait ici un vrai appel réseau.
    storage: createFakeObjectStorage(),
    // Le plafond de /guest/join reste haut ici : ces tests doivent pouvoir
    // créer plusieurs sessions depuis la même IP. Il a son propre test, avec
    // son propre contexte, plus bas.
    env: { SESSION_RATE_LIMIT_MAX: SESSION_MAX },
  });
  organizer = await registerOrganizer(ctx.app);
  eventId = (await createEvent(ctx.app, organizer.accessToken)).id;
});

afterAll(async () => {
  await ctx.close();
});

function authorize(token: string | null, ip = SALLE_DES_FETES) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/uploads/authorize",
    remoteAddress: ip,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { sizeBytes: 1_000_000 },
  });
}

function confirm(token: string, ip = SALLE_DES_FETES) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/photos/confirm",
    remoteAddress: ip,
    headers: { authorization: `Bearer ${token}` },
    payload: { photoId: randomUUID(), capturedAt: new Date().toISOString() },
  });
}

/** Consomme exactement le quota d'une session, sans le dépasser. */
async function exhaust(token: string): Promise<void> {
  for (let i = 0; i < SESSION_MAX; i += 1) {
    const response = await authorize(token);
    expect(response.statusCode).toBe(201);
  }
}

describe("Quota de /uploads/authorize et /photos/confirm", () => {
  it("compte par session invité : un invité qui sature son quota n'entame pas celui des autres", async () => {
    // Trois appareils différents, un seul et même réseau — trois sessions
    // distinctes côté serveur, puisque le deviceId diffère.
    const [alice, bruno, chloe] = await Promise.all([
      joinAsGuest(ctx.app, eventId, {
        nickname: "Alice",
        deviceId: "device-salle-alice-000001",
      }),
      joinAsGuest(ctx.app, eventId, {
        nickname: "Bruno",
        deviceId: "device-salle-bruno-000002",
      }),
      joinAsGuest(ctx.app, eventId, {
        nickname: "Chloé",
        deviceId: "device-salle-chloe-000003",
      }),
    ]);

    expect(
      new Set([
        alice.session.id,
        bruno.session.id,
        chloe.session.id,
      ]).size
    ).toBe(3);

    // Alice vide sa file de photos et atteint son plafond.
    await exhaust(alice.guestToken);

    const aliceRefusee = await authorize(alice.guestToken);
    expect(aliceRefusee.statusCode).toBe(429);
    expect(aliceRefusee.json().error.code).toBe("RATE_LIMITED");

    // Bruno et Chloé, derrière exactement la même IP, ne doivent rien ressentir
    // de ce qu'a consommé Alice.
    for (const guest of [bruno, chloe]) {
      const response = await authorize(guest.guestToken);
      expect(response.statusCode).toBe(201);
      expect(response.headers["x-ratelimit-remaining"]).toBe(
        String(SESSION_MAX - 1)
      );
    }

    // Et Bruno peut aller jusqu'au bout de son propre quota, sans que le refus
    // d'Alice ne l'ait entamé.
    const brunoRestant = await Promise.all([
      authorize(bruno.guestToken),
      authorize(bruno.guestToken),
    ]);
    expect(brunoRestant.map((r) => r.statusCode)).toEqual([201, 201]);
    expect((await authorize(bruno.guestToken)).statusCode).toBe(429);

    // Chloé, elle, n'a toujours consommé qu'un seul appel.
    expect((await authorize(chloe.guestToken)).statusCode).toBe(201);
  });

  it("compte séparément chaque route : saturer l'autorisation ne ferme pas la confirmation", async () => {
    const guest = await joinAsGuest(ctx.app, eventId, {
      nickname: "Damien",
      deviceId: "device-salle-damien-00004",
    });

    await exhaust(guest.guestToken);
    expect((await authorize(guest.guestToken)).statusCode).toBe(429);

    // /photos/confirm a son propre compteur. La photo n'existe pas sur le
    // stockage, donc la route répond 404 — ce qui prouve justement qu'elle a
    // été exécutée, et non refusée en amont par le quota.
    const confirmation = await confirm(guest.guestToken);
    expect(confirmation.statusCode).toBe(404);
    expect(confirmation.json().error.code).toBe("ORIGINAL_NOT_FOUND");
  });

  it("compte par organisateur, sans jamais partager le quota d'un invité", async () => {
    const guest = await joinAsGuest(ctx.app, eventId, {
      nickname: "Élodie",
      deviceId: "device-salle-elodie-00005",
    });

    await exhaust(guest.guestToken);
    expect((await authorize(guest.guestToken)).statusCode).toBe(429);

    // L'organisateur capture aussi pendant son propre événement (Phase 4) :
    // son quota est le sien, même IP ou non.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/uploads/authorize",
      remoteAddress: SALLE_DES_FETES,
      headers: { authorization: `Bearer ${organizer.accessToken}` },
      payload: { eventId, sizeBytes: 1_000_000 },
    });
    expect(response.statusCode).toBe(201);
  });

  it("retombe sur l'adresse IP quand aucune session valable n'est présentée", async () => {
    // Sans jeton, il n'y a pas de session à débiter : ces appels doivent
    // malgré tout être comptés quelque part, sinon la route serait un moyen
    // gratuit de faire travailler le serveur. Ils partent d'une IP dédiée pour
    // ne pas empiéter sur les autres tests.
    const attaquant = "198.51.100.77";

    for (let i = 0; i < SESSION_MAX; i += 1) {
      // 401 : le quota laisse passer, c'est l'authentification qui refuse.
      expect((await authorize(null, attaquant)).statusCode).toBe(401);
    }

    const refusee = await authorize(null, attaquant);
    expect(refusee.statusCode).toBe(429);

    // Un jeton forgé ne permet pas davantage de choisir son compteur : il
    // n'est pas vérifiable, donc il retombe lui aussi sur l'IP.
    const forge = await authorize("pas.un.jeton", attaquant);
    expect(forge.statusCode).toBe(429);
  });
});

describe("Quota de /guest/join", () => {
  /**
   * Cette route reste comptée par IP, faute d'une session à compter : c'est
   * elle qui la crée. Le compromis est assumé, ce test le fige — y compris
   * son revers, qu'une salle partage bien ce quota-là.
   */
  it("reste compté par IP, avec un plafond qui absorbe une salle entière", async () => {
    const joinCtx = await createTestContext({
      enableRateLimit: true,
      env: { GUEST_JOIN_RATE_LIMIT_MAX: 2 },
    });

    try {
      const owner = await registerOrganizer(joinCtx.app);
      const event = await createEvent(joinCtx.app, owner.accessToken);

      const join = (deviceId: string, ip: string) =>
        joinCtx.app.inject({
          method: "POST",
          url: `/api/v1/events/${event.id}/guest/join`,
          remoteAddress: ip,
          payload: { nickname: "Invité", deviceId },
        });

      expect((await join("device-join-0000000001", SALLE_DES_FETES)).statusCode).toBe(201);
      expect((await join("device-join-0000000002", SALLE_DES_FETES)).statusCode).toBe(201);

      // Troisième appareil derrière la même IP : refusé, puisque le quota est
      // celui de l'adresse. C'est pour cela que son plafond réel est de 600 par
      // tranche de 5 minutes (GUEST_JOIN_RATE_LIMIT_MAX), pas 120 par
      // 10 minutes comme avant.
      const troisieme = await join("device-join-0000000003", SALLE_DES_FETES);
      expect(troisieme.statusCode).toBe(429);
      expect(troisieme.json().error.code).toBe("RATE_LIMITED");
      expect(troisieme.json().error.details.retryAfterSeconds).toBeGreaterThan(0);

      // Une autre IP garde son propre compteur : le refus ci-dessus ne
      // s'étend pas à l'invité qui arrive en 4G.
      expect((await join("device-join-0000000004", "198.51.100.4")).statusCode).toBe(201);
    } finally {
      await joinCtx.close();
    }
  });
});
