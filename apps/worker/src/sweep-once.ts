import { runExpirationSweep } from "@admemrize/api/services/expiration";
import { createWorkerContext } from "./context.js";

/**
 * Un seul balayage, puis sortie — pour déclencher l'expiration à la main sans
 * attendre le tour du worker (`npm run sweep`, ou
 * `docker compose exec worker node apps/worker/dist/sweep-once.js` en prod).
 *
 * Sans danger à côté du worker qui tourne : le traitement est idempotent, et
 * deux passages simultanés sur le même événement ne peuvent au pire que se
 * disputer des suppressions déjà faites.
 *
 * Code de sortie 1 si au moins un événement a échoué : utilisable tel quel
 * dans un script de vérification après déploiement.
 */

const { env, database, storage, logger } = createWorkerContext();

try {
  const result = await runExpirationSweep({
    db: database.db,
    storage,
    logger,
    batchSize: env.EXPIRATION_SWEEP_BATCH_SIZE,
  });

  const objects = result.expired.reduce(
    (total, entry) => total + entry.deletedObjects,
    0
  );
  const photos = result.expired.reduce(
    (total, entry) => total + entry.deletedPhotos,
    0
  );

  logger.info(
    `Passage terminé : ${result.expired.length}/${result.found} événement(s) expiré(s), ` +
      `${objects} objet(s) et ${photos} photo(s) supprimé(s), ${result.failed.length} en échec`
  );

  await database.close();
  process.exit(result.failed.length > 0 ? 1 : 0);
} catch (error) {
  logger.error(
    `Balayage interrompu : ${error instanceof Error ? error.message : String(error)}`
  );
  await database.close();
  process.exit(1);
}
