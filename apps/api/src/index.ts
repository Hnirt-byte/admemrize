import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// npm workspaces exécute ce script avec le dossier courant = apps/api/, pas la
// racine du repo — dotenv/config cherche .env dans le dossier courant par
// défaut et ne le trouve donc jamais en dev local. Chemin explicite vers la
// racine. Sans effet en prod : Docker injecte déjà les variables via
// env_file, avant même que Node ne démarre.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);

const app = await buildApp({ db: database.db, env });

try {
  await runMigrations(database.db);
  app.log.info("Migrations à jour");
} catch (err) {
  app.log.error(err, "Échec des migrations — démarrage interrompu");
  process.exit(1);
}

// Arrêt propre : on laisse les requêtes en cours se terminer avant de fermer le
// pool Postgres, sinon Docker tue des transactions en vol à chaque déploiement.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`Signal ${signal} reçu, arrêt en cours...`);
    app
      .close()
      .then(() => database.close())
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}

app
  .listen({ port: env.API_PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`API démarrée sur le port ${env.API_PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
