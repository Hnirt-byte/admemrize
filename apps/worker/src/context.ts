import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDatabase, type DatabaseHandle } from "@admemrize/api/db";
import { loadEnv } from "@admemrize/api/env";
import { createObjectStorage } from "@admemrize/api/storage";
import type { ObjectStorage } from "@admemrize/api/storage";
import type { SweepLogger } from "@admemrize/api/services/expiration";

// Même cause qu'côté API : npm workspaces exécute ces scripts depuis
// apps/worker/, dotenv/config chercherait .env au mauvais endroit sans ce
// chemin explicite. `loadEnv()` n'est appelé qu'ensuite, à la construction du
// contexte, donc il lit bien un environnement déjà complété.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

export const logger: SweepLogger = {
  info: (message: string) =>
    console.log(`[worker] ${new Date().toISOString()} ${message}`),
  error: (message: string) =>
    console.error(`[worker] ${new Date().toISOString()} ${message}`),
};

export interface WorkerContext {
  env: ReturnType<typeof loadEnv>;
  database: DatabaseHandle;
  storage: ObjectStorage;
  logger: SweepLogger;
}

/**
 * Amorçage partagé par les deux points d'entrée du worker : la boucle
 * (`index.ts`) et le passage unique déclenché à la main (`sweep-once.ts`).
 * Une seule façon de lire la configuration et d'ouvrir la base, donc aucun
 * risque qu'un déclenchement manuel tourne contre une autre configuration que
 * le worker lui-même.
 */
export function createWorkerContext(): WorkerContext {
  const env = loadEnv();

  return {
    env,
    database: createDatabase(env.DATABASE_URL),
    storage: createObjectStorage(env),
    logger,
  };
}
