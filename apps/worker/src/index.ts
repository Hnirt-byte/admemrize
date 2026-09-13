import { runExpirationSweep } from "@admemrize/api/services/expiration";
import { createWorkerContext } from "./context.js";

/**
 * Worker d'expiration (section 22 du master prompt) : à `deleteAt`, les photos
 * d'un événement disparaissent définitivement, du bucket comme de la base.
 *
 * Ce fichier ne contient que le pilotage — boucle, arrêt propre, journal. La
 * suppression elle-même vit dans `apps/api/src/services/expiration.ts`, avec le
 * schéma Drizzle et l'abstraction de stockage qu'elle utilise, et où elle est
 * testée contre un vrai Postgres (`apps/api/test/expiration.test.ts`).
 * Redéclarer ici un second accès aux tables aurait créé deux vérités sur ce qui
 * compose un événement — la dernière chose à laisser diverger dans du code de
 * suppression.
 */

const { env, database, storage, logger } = createWorkerContext();

const INTERVAL_MS = env.EXPIRATION_SWEEP_INTERVAL_SECONDS * 1000;

let timer: NodeJS.Timeout | undefined;
let running: Promise<void> | undefined;
let stopping = false;

async function sweep(): Promise<void> {
  try {
    const result = await runExpirationSweep({
      db: database.db,
      storage,
      logger,
      batchSize: env.EXPIRATION_SWEEP_BATCH_SIZE,
    });

    if (result.failed.length > 0) {
      logger.error(
        `${result.failed.length} événement(s) en échec, repris au prochain passage`
      );
    }
  } catch (error) {
    // Une panne globale (Postgres injoignable, identifiants S3 refusés) ne doit
    // pas tuer le worker : le conteneur redémarrerait en boucle alors que le
    // passage suivant suffit souvent à repartir. Les échecs par événement, eux,
    // sont déjà isolés dans le service.
    logger.error(
      `Balayage interrompu : ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Chaînage par `setTimeout` plutôt que `setInterval` : le délai court entre la
 * fin d'un balayage et le début du suivant. Un balayage plus long que
 * l'intervalle ne peut donc pas se retrouver à tourner en double sur les mêmes
 * événements.
 */
function scheduleNext(): void {
  if (stopping) return;
  timer = setTimeout(start, INTERVAL_MS);
}

function start(): void {
  running = sweep().finally(() => {
    running = undefined;
    scheduleNext();
  });
}

// Arrêt propre : on laisse le balayage en cours se terminer avant de fermer le
// pool Postgres. Couper au milieu n'abîmerait rien (tout est idempotent et
// rejouable), mais laisserait des transactions en vol à chaque déploiement.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`Signal ${signal} reçu, arrêt en cours...`);
    stopping = true;
    if (timer) clearTimeout(timer);

    Promise.resolve(running)
      .then(() => database.close())
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error(String(error));
        process.exit(1);
      });
  });
}

logger.info(
  `démarré — balayage toutes les ${env.EXPIRATION_SWEEP_INTERVAL_SECONDS} s, ` +
    `${env.EXPIRATION_SWEEP_BATCH_SIZE} événement(s) par passage`
);

// Premier passage immédiat : après un redéploiement, les événements échus
// pendant l'arrêt n'attendent pas un intervalle complet.
start();
