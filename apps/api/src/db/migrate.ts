import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client.js";

/**
 * Dossier des migrations, résolu relativement au fichier compilé
 * (`dist/db/migrate.js` -> `apps/api/drizzle`). Il est volontairement hors de
 * `src/` pour être copié tel quel dans l'image de production.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
);

/**
 * Joue les migrations en attente au démarrage de l'API. Choix assumé pour la V1 :
 * un seul conteneur API, donc pas de course entre répliques, et une étape
 * manuelle de moins à oublier lors d'un déploiement (voir section 8 de
 * architecture-v1-addendum.md). À revoir le jour où l'API sera répliquée.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
