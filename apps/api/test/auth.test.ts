import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import {
  createTestContext,
  registerOrganizer,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe("inscription organisateur", () => {
  it("crée un compte et renvoie une session complète", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "Camille@Admemrize.test",
        password: "MotDePasseTresSolide!42",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.organizer.email).toBe("camille@admemrize.test"); // normalisé en minuscules
    expect(body.organizer.plan).toBe("FREE");
    expect(body.tokens.tokenType).toBe("Bearer");
    expect(body.tokens.expiresIn).toBe(900);
    expect(body.tokens.accessToken).not.toBe(body.tokens.refreshToken);
  });

  it("stocke un hash Argon2id, jamais le mot de passe", async () => {
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.email, "camille@admemrize.test"))
      .limit(1);

    expect(user!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user!.passwordHash).not.toContain("MotDePasseTresSolide!42");
  });

  it("refuse un email déjà inscrit, quelle que soit la casse", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "CAMILLE@admemrize.test",
        password: "UnAutreMotDePasse!77",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("EMAIL_ALREADY_REGISTERED");
  });

  it("refuse un email invalide ou un mot de passe trop court", async () => {
    const cases = [
      { email: "pas-un-email", password: "MotDePasseTresSolide!42" },
      { email: "court@admemrize.test", password: "court" },
    ];

    for (const payload of cases) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("connexion organisateur", () => {
  it("accepte les bons identifiants", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "camille@admemrize.test",
        password: "MotDePasseTresSolide!42",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tokens.accessToken).toBeTruthy();
  });

  it("renvoie exactement la même erreur pour un mot de passe faux et un compte inconnu", async () => {
    const mauvaisMotDePasse = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "camille@admemrize.test", password: "MauvaisMotDePasse!1" },
    });
    const compteInconnu = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "inconnu@admemrize.test", password: "MauvaisMotDePasse!1" },
    });

    expect(mauvaisMotDePasse.statusCode).toBe(401);
    expect(compteInconnu.statusCode).toBe(401);
    // Réponses identiques au caractère près : rien ne permet de savoir si le
    // compte existe (pas d'énumération d'utilisateurs).
    expect(compteInconnu.body).toBe(mauvaisMotDePasse.body);
    expect(mauvaisMotDePasse.json().error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("rafraîchissement de session", () => {
  it("échange un refresh token contre une nouvelle paire", async () => {
    const organizer = await registerOrganizer(ctx.app);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: organizer.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organizer.id).toBe(organizer.organizerId);
    expect(body.tokens.accessToken).toBeTruthy();
    expect(body.tokens.refreshToken).toBeTruthy();

    // Le nouvel access token ouvre bien les routes protégées.
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.tokens.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(organizer.organizerId);
  });

  it("refuse un refresh token bidon", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "pas-un-jeton" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_TOKEN");
  });
});
