import {
  AuthSession,
  LoginInput,
  OrganizerProfile,
  RefreshInput,
  RegisterInput,
} from "@admemrize/shared";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { conflict, unauthorized } from "../lib/errors.js";
import {
  getDummyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../lib/password.js";
import {
  signOrganizerAccessToken,
  signOrganizerRefreshToken,
  verifyOrganizerRefreshToken,
} from "../lib/tokens.js";
import { requireOrganizer, type AuthDeps } from "../plugins/auth.js";
import type { AppInstance } from "../types.js";

type OrganizerRow = {
  id: string;
  email: string;
  plan: string;
  createdAt: Date;
};

function toProfile(user: OrganizerRow) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan as "FREE" | "PREMIUM",
    createdAt: user.createdAt.toISOString(),
  };
}

/** Les emails sont comparés en minuscules : "A@b.fr" et "a@b.fr" sont le même compte. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function issueSession(deps: AuthDeps, user: OrganizerRow) {
  const [accessToken, refreshToken] = await Promise.all([
    signOrganizerAccessToken(deps.env, { userId: user.id, plan: user.plan }),
    signOrganizerRefreshToken(deps.env, { userId: user.id }),
  ]);

  return {
    organizer: toProfile(user),
    tokens: {
      accessToken,
      refreshToken,
      tokenType: "Bearer" as const,
      expiresIn: deps.env.ACCESS_TOKEN_TTL_SECONDS,
    },
  };
}

export function registerAuthRoutes(app: AppInstance, deps: AuthDeps): void {
  app.post(
    "/api/v1/auth/register",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: { body: RegisterInput, response: { 201: AuthSession } },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const passwordHash = await hashPassword(request.body.password);

      let created: OrganizerRow;
      try {
        const [row] = await deps.db
          .insert(users)
          .values({ email, passwordHash })
          .returning({
            id: users.id,
            email: users.email,
            plan: users.plan,
            createdAt: users.createdAt,
          });
        created = row!;
      } catch (error) {
        // L'unicité est tranchée par la contrainte en base, pas par un SELECT
        // préalable : deux inscriptions simultanées sur le même email ne peuvent
        // pas passer toutes les deux.
        if (isUniqueViolation(error)) {
          throw conflict(
            "Un compte existe déjà avec cet email.",
            "EMAIL_ALREADY_REGISTERED"
          );
        }
        throw error;
      }

      reply.status(201);
      return issueSession(deps, created);
    }
  );

  app.post(
    "/api/v1/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
      schema: { body: LoginInput, response: { 200: AuthSession } },
    },
    async (request) => {
      const email = normalizeEmail(request.body.email);

      const [user] = await deps.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      // Même travail cryptographique que le compte existe ou non : pas de canal
      // temporel permettant d'énumérer les emails inscrits.
      const storedHash = user?.passwordHash ?? (await getDummyHash());
      const passwordOk = await verifyPassword(storedHash, request.body.password);

      if (!user || !passwordOk) {
        throw unauthorized(
          "Email ou mot de passe incorrect.",
          "INVALID_CREDENTIALS"
        );
      }

      // Durcissement transparent : si les paramètres Argon2id ont évolué depuis
      // l'inscription, on re-hache maintenant qu'on tient le mot de passe en clair.
      if (needsRehash(user.passwordHash)) {
        const upgraded = await hashPassword(request.body.password);
        await deps.db
          .update(users)
          .set({ passwordHash: upgraded, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }

      return issueSession(deps, user);
    }
  );

  app.post(
    "/api/v1/auth/refresh",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 hour" } },
      schema: { body: RefreshInput, response: { 200: AuthSession } },
    },
    async (request) => {
      const claims = await verifyOrganizerRefreshToken(
        deps.env,
        request.body.refreshToken
      );

      const [user] = await deps.db
        .select()
        .from(users)
        .where(eq(users.id, claims.userId))
        .limit(1);

      if (!user) {
        throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
      }

      // Rotation : chaque rafraîchissement renvoie aussi un nouveau refresh token.
      // Limite connue de la V1 : ces jetons étant sans état (aucune table de
      // révocation dans schema.ts), l'ancien reste techniquement valide jusqu'à
      // son expiration. Une table `refresh_tokens` sera nécessaire le jour où on
      // voudra une déconnexion à distance réelle.
      return issueSession(deps, user);
    }
  );

  app.get(
    "/api/v1/auth/me",
    {
      preHandler: requireOrganizer(deps),
      schema: { response: { 200: OrganizerProfile } },
    },
    async (request) => {
      const [user] = await deps.db
        .select()
        .from(users)
        .where(eq(users.id, request.organizer!.userId))
        .limit(1);

      if (!user) {
        throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
      }
      return toProfile(user);
    }
  );
}
