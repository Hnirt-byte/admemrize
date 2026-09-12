import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { buildApp } from "../src/app.js";
import { EnvSchema, type Env } from "../src/env.js";
import { ScalewayObjectStorage } from "../src/storage/scaleway-s3.js";
import type { ObjectStorage } from "../src/storage/types.js";
import type { AppInstance } from "../src/types.js";

/**
 * Environnement de test. Les trois secrets sont distincts, comme l'exige
 * EnvSchema : les tests tournent donc avec exactement la même séparation
 * cryptographique qu'en production.
 *
 * Quotas volontairement bas (au lieu des 500/10000 par défaut) : les tests de
 * dépassement de quota insèrent des lignes `photos` directement en base, pas
 * la peine d'en créer des centaines pour déclencher le même comportement.
 */
export const testEnv: Env = EnvSchema.parse({
  NODE_ENV: "test",
  DATABASE_URL: "pglite://memory",
  JWT_ACCESS_SECRET: "test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaa",
  JWT_REFRESH_SECRET: "test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbb",
  JWT_GUEST_SECRET: "test-guest-secret-ccccccccccccccccccccccccc",
  APP_NAME: "ADMEMRIZE",
  APP_DOMAIN: "http://localhost:5173",
  S3_ENDPOINT: "https://s3.fr-par.scw.cloud",
  S3_REGION: "fr-par",
  S3_BUCKET: "admemrize-events-test",
  S3_ACCESS_KEY_ID: "test-access-key-id",
  S3_SECRET_ACCESS_KEY: "test-secret-access-key",
  SESSION_PHOTO_QUOTA: 3,
  EVENT_PHOTO_QUOTA: 5,
});

/**
 * `getSignedUrl` est un calcul cryptographique local (aucun appel réseau vers
 * Scaleway) : la même implémentation qu'en production peut donc signer des URL
 * de test avec des identifiants fictifs, sans mock ni double de test à
 * maintenir. Seul `deleteObject` ferait un vrai appel réseau — aucun test ne
 * l'exerce pour l'instant.
 */
export function createTestStorage(): ObjectStorage {
  return new ScalewayObjectStorage({
    endpoint: testEnv.S3_ENDPOINT,
    region: testEnv.S3_REGION,
    bucket: testEnv.S3_BUCKET,
    accessKeyId: testEnv.S3_ACCESS_KEY_ID,
    secretAccessKey: testEnv.S3_SECRET_ACCESS_KEY,
  });
}

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
    storage: createTestStorage(),
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
