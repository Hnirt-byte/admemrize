import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { guestSessions, users } from "../src/db/schema.js";
import {
  ORGANIZER_AUDIENCE,
  TOKEN_ISSUER,
  signGuestSessionToken,
  signOrganizerAccessToken,
} from "../src/lib/tokens.js";
import {
  createEvent,
  createTestContext,
  joinAsGuest,
  registerOrganizer,
  testEnv,
  type TestContext,
} from "./helpers.js";

/**
 * Tests de sécurité — section 35 du master prompt.
 *
 * Trois propriétés à démontrer, pas seulement à affirmer :
 *   1. un jeton invité ne peut pas agir comme organisateur ;
 *   2. un jeton invalide ou expiré est rejeté ;
 *   3. un eventId inexistant produit une erreur propre (jamais une 500).
 */

let ctx: TestContext;
let organizer: Awaited<ReturnType<typeof registerOrganizer>>;
let event: { id: string };
let guest: { guestToken: string; session: { id: string } };

beforeAll(async () => {
  ctx = await createTestContext();
  organizer = await registerOrganizer(ctx.app);
  event = await createEvent(ctx.app, organizer.accessToken);
  guest = await joinAsGuest(ctx.app, event.id);
});

afterAll(async () => {
  await ctx.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Une erreur "propre" = un JSON conforme à l'enveloppe { error: { code, message } }. */
function expectCleanError(response: { statusCode: number; body: string }) {
  const body = JSON.parse(response.body);
  expect(body).toHaveProperty("error");
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  // Aucune trace interne ne doit fuir dans la réponse.
  expect(response.body).not.toMatch(/stack|node_modules|postgres:\/\//i);
  return body;
}

// ---------------------------------------------------------------------------
// 35.1 — Un jeton invité ne peut jamais agir comme organisateur
// ---------------------------------------------------------------------------

describe("35.1 — cloisonnement invité / organisateur", () => {
  it("refuse la création d'un événement avec un jeton invité", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: bearer(guest.guestToken),
      payload: {
        name: "Événement pirate",
        type: "FETE",
        eventDate: new Date(Date.now() + 86_400_000).toISOString(),
        revealAt: new Date(Date.now() + 172_800_000).toISOString(),
        retentionHours: 24,
      },
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);

    // Et rien n'a été créé en base : le refus est réel, pas seulement un statut.
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(organizer.accessToken),
    });
    expect(list.json().events).toHaveLength(1);
  });

  it("refuse la modification d'un événement avec un jeton invité", async () => {
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/events/${event.id}`,
      headers: bearer(guest.guestToken),
      payload: { name: "Nom détourné" },
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);

    const unchanged = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}`,
      headers: bearer(organizer.accessToken),
    });
    expect(unchanged.json().name).not.toBe("Nom détourné");
  });

  it("refuse la suppression d'un événement avec un jeton invité", async () => {
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/events/${event.id}`,
      headers: bearer(guest.guestToken),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);

    const stillThere = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}`,
      headers: bearer(organizer.accessToken),
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("refuse la lecture des routes organisateur avec un jeton invité", async () => {
    for (const url of ["/api/v1/events", `/api/v1/events/${event.id}`, "/api/v1/auth/me"]) {
      const response = await ctx.app.inject({
        method: "GET",
        url,
        headers: bearer(guest.guestToken),
      });
      expect(response.statusCode, `route ${url}`).toBe(401);
      expectCleanError(response);
    }
  });

  it("accepte ce même jeton invité sur une route invité (contrôle positif)", async () => {
    // Sans ce test, les précédents passeraient aussi avec un jeton simplement cassé.
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: bearer(guest.guestToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(guest.session.id);
  });

  it("refuse un jeton organisateur sur une route invité (cloisonnement symétrique)", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: bearer(organizer.accessToken),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);
  });

  it("ne place jamais le rôle organisateur dans un jeton invité", async () => {
    const [, payloadPart] = guest.guestToken.split(".");
    const claims = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8")
    );

    expect(claims.role).toBe("guest");
    expect(claims.tkn).toBe("guest_session");
    expect(claims.aud).toBe("admemrize:guest");
    expect(claims.aud).not.toBe(ORGANIZER_AUDIENCE);
  });

  it("refuse un jeton forgé avec des claims d'organisateur mais le secret invité", async () => {
    // Scénario réaliste : fuite du seul secret invité. La séparation des secrets
    // doit suffire à contenir la compromission côté invité.
    const forged = await new SignJWT({ tkn: "organizer_access", role: "organizer" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(ORGANIZER_AUDIENCE)
      .setSubject(organizer.organizerId)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(testEnv.JWT_GUEST_SECRET));

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(forged),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);
  });
});

// ---------------------------------------------------------------------------
// 35.2 — Jeton invalide, manquant, altéré ou expiré
// ---------------------------------------------------------------------------

describe("35.2 — rejet des jetons invalides ou expirés", () => {
  it("refuse une requête sans en-tête Authorization", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/events" });
    expect(response.statusCode).toBe(401);
    expect(expectCleanError(response).error.code).toBe("MISSING_TOKEN");
  });

  it("refuse un en-tête mal formé", async () => {
    for (const authorization of [
      organizer.accessToken, // sans le schéma "Bearer"
      `Basic ${organizer.accessToken}`,
      "Bearer",
    ]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/events",
        headers: { authorization },
      });
      expect(response.statusCode, `header "${authorization}"`).toBe(401);
      expectCleanError(response);
    }
  });

  it("refuse un jeton qui n'est pas un JWT", async () => {
    for (const token of ["", "pas-un-jwt", "a.b.c", "null", "undefined"]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/events",
        headers: bearer(token),
      });
      expect(response.statusCode, `token "${token}"`).toBe(401);
      expectCleanError(response);
    }
  });

  it("refuse un jeton dont la charge utile a été altérée", async () => {
    const [header, payload, signature] = organizer.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.sub = randomUUID(); // usurpation d'un autre compte
    const tampered = [
      header,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      signature,
    ].join(".");

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(tampered),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);
  });

  it('refuse un jeton non signé (attaque alg:"none")', async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url"
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: organizer.organizerId,
        tkn: "organizer_access",
        role: "organizer",
        iss: TOKEN_ISSUER,
        aud: ORGANIZER_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(`${header}.${payload}.`),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);
  });

  it("refuse un access token expiré", async () => {
    const expired = await signOrganizerAccessToken(
      { ...testEnv, ACCESS_TOKEN_TTL_SECONDS: -3600 },
      { userId: organizer.organizerId, plan: "FREE" }
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(expired),
    });

    expect(response.statusCode).toBe(401);
    expect(expectCleanError(response).error.code).toBe("INVALID_TOKEN");
  });

  it("refuse un jeton invité expiré", async () => {
    const expired = await signGuestSessionToken(
      testEnv,
      {
        guestSessionId: guest.session.id,
        eventId: event.id,
        deviceId: "device-test-0000000000000001",
      },
      new Date(Date.now() - 60_000)
    );

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: bearer(expired),
    });

    expect(response.statusCode).toBe(401);
    expect(expectCleanError(response).error.code).toBe("INVALID_TOKEN");
  });

  it("refuse un refresh token présenté comme access token, et inversement", async () => {
    const asAccess = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(organizer.refreshToken),
    });
    expect(asAccess.statusCode).toBe(401);
    expectCleanError(asAccess);

    const asRefresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: organizer.accessToken },
    });
    expect(asRefresh.statusCode).toBe(401);
    expectCleanError(asRefresh);
  });

  it("refuse le jeton invité dont la session a été supprimée en base", async () => {
    // Révocation immédiate : l'empreinte en base fait autorité, pas seulement la
    // signature du jeton.
    const other = await joinAsGuest(ctx.app, event.id, {
      nickname: "Invité éphémère",
      deviceId: "device-test-a-supprimer-000001",
    });

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: bearer(other.guestToken),
    });
    expect(before.statusCode).toBe(200);

    await ctx.db.delete(guestSessions).where(eq(guestSessions.id, other.session.id));

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/guest/me",
      headers: bearer(other.guestToken),
    });
    expect(after.statusCode).toBe(401);
    expectCleanError(after);
  });

  it("refuse l'access token d'un compte organisateur supprimé", async () => {
    const doomed = await registerOrganizer(ctx.app, {
      email: "compte-supprime@admemrize.test",
    });
    await ctx.db.delete(users).where(eq(users.id, doomed.organizerId));

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/events",
      headers: bearer(doomed.accessToken),
    });

    expect(response.statusCode).toBe(401);
    expectCleanError(response);
  });
});

// ---------------------------------------------------------------------------
// 35.3 — eventId inexistant ou malformé : erreur propre
// ---------------------------------------------------------------------------

describe("35.3 — eventId inexistant ou malformé", () => {
  const ghostId = randomUUID();

  it("renvoie 404 EVENT_NOT_FOUND en lecture, modification et suppression", async () => {
    const cases = [
      { method: "GET" as const, url: `/api/v1/events/${ghostId}`, payload: undefined },
      {
        method: "PATCH" as const,
        url: `/api/v1/events/${ghostId}`,
        payload: { name: "Peu importe" },
      },
      { method: "DELETE" as const, url: `/api/v1/events/${ghostId}`, payload: undefined },
    ];

    for (const testCase of cases) {
      const response = await ctx.app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: bearer(organizer.accessToken),
        ...(testCase.payload ? { payload: testCase.payload } : {}),
      });

      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(404);
      expect(expectCleanError(response).error.code).toBe("EVENT_NOT_FOUND");
    }
  });

  it("renvoie 404 EVENT_NOT_FOUND quand un invité rejoint un événement inexistant", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/events/${ghostId}/guest/join`,
      payload: { nickname: "Personne", deviceId: "device-test-0000000000000002" },
    });

    expect(response.statusCode).toBe(404);
    expect(expectCleanError(response).error.code).toBe("EVENT_NOT_FOUND");
  });

  it("renvoie 400 (jamais 500) sur un eventId qui n'est pas un UUID", async () => {
    const malformed = [
      "pas-un-uuid",
      "1",
      "00000000-0000-0000-0000-00000000000", // un caractère de trop court
      "' OR 1=1 --",
      "../../etc/passwd",
    ];

    for (const eventId of malformed) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/events/${encodeURIComponent(eventId)}`,
        headers: bearer(organizer.accessToken),
      });

      expect(response.statusCode, `eventId "${eventId}"`).toBe(400);
      expect(expectCleanError(response).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("renvoie 400 sur un eventId malformé côté jonction invité, sans toucher la base", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/events/pas-un-uuid/guest/join",
      payload: { nickname: "Personne", deviceId: "device-test-0000000000000003" },
    });

    expect(response.statusCode).toBe(400);
    expect(expectCleanError(response).error.code).toBe("VALIDATION_ERROR");
  });

  it("renvoie 404 EVENT_NOT_FOUND pour l'événement d'un autre organisateur (pas 403)", async () => {
    // Répondre 403 confirmerait l'existence de l'événement : on renvoie la même
    // chose que pour un identifiant inconnu.
    const autre = await registerOrganizer(ctx.app);
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/events/${event.id}`,
      headers: bearer(autre.accessToken),
    });

    expect(response.statusCode).toBe(404);
    expect(expectCleanError(response).error.code).toBe("EVENT_NOT_FOUND");
  });

  it("renvoie une route inconnue proprement (404 JSON, pas une page HTML)", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/evenements-inexistants",
    });

    expect(response.statusCode).toBe(404);
    expect(expectCleanError(response).error.code).toBe("ROUTE_NOT_FOUND");
  });
});
