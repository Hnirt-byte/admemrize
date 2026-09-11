import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { buildApp } from "../src/app.js";
import { EnvSchema, type Env } from "../src/env.js";
import type { AppInstance } from "../src/types.js";

/**
 * Environnement de test. Les trois secrets sont distincts, comme l'exige
 * EnvSchema : les tests tournent donc avec exactement la même séparation
 * cryptographique qu'en production.
 */
export const testEnv: Env = EnvSchema.parse({
  NODE_ENV: "test",
  DATABASE_URL: "pglite://memory",
  JWT_ACCESS_SECRET: "test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaa",
  JWT_REFRESH_SECRET: "test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbb",
  JWT_GUEST_SECRET: "test-guest-secret-ccccccccccccccccccccccccc",
  APP_NAME: "ADMEMRIZE",
  APP_DOMAIN: "http://localhost:5173",
});

export interface TestContext {
  app: AppInstance;
  db: Database;
  close: () => Promise<void>;
}

/**
 * Monte l'API complète sur un Postgres réel compilé en WebAssembly (PGlite) :
 * mêmes migrations, mêmes types, mêmes contraintes d'intégrité qu'en production,
 * sans dépendre de Docker sur la machine de dev.
 */
export async function createTestContext(): Promise<TestContext> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as unknown as Database;

  // Le migrateur PGlite de Drizzle ne lit pas le même format de journal que le
  // migrateur postgres-js : on applique directement le SQL généré, ce qui teste
  // les migrations réellement livrées plutôt qu'un schéma recréé à la volée.
  const journalPath = join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const sql = await readFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await pg.exec(trimmed);
    }
  }

  const app = await buildApp({
    db,
    env: testEnv,
    enableRateLimit: false,
    logger: false,
  });
  await app.ready();

  return {
    app,
    db,
    close: async () => {
      await app.close();
      await pg.close();
    },
  };
}

// --- Raccourcis de scénario -----------------------------------------------

export interface OrganizerFixture {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  organizerId: string;
}

let organizerCounter = 0;

export async function registerOrganizer(
  app: AppInstance,
  overrides: Partial<{ email: string; password: string }> = {}
): Promise<OrganizerFixture> {
  organizerCounter += 1;
  const email = overrides.email ?? `organisateur${organizerCounter}@admemrize.test`;
  const password = overrides.password ?? "MotDePasseTresSolide!42";

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Inscription échouée: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  return {
    email,
    password,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
    organizerId: body.organizer.id,
  };
}

/** Date ISO décalée de N jours par rapport à maintenant. */
export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

export async function createEvent(
  app: AppInstance,
  accessToken: string,
  overrides: Record<string, unknown> = {}
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/events",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Mariage de Camille et Sofiane",
      type: "MARIAGE",
      eventDate: daysFromNow(30),
      revealAt: daysFromNow(31),
      retentionHours: 72,
      ...overrides,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Création d'événement échouée: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

export async function joinAsGuest(
  app: AppInstance,
  eventId: string,
  overrides: Partial<{ nickname: string; deviceId: string }> = {}
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/events/${eventId}/guest/join`,
    payload: {
      nickname: overrides.nickname ?? "Tante Jacqueline",
      deviceId: overrides.deviceId ?? "device-test-0000000000000001",
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Jonction invité échouée: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}
