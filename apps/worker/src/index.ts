import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Même cause qu'côté API : npm workspaces exécute ce script depuis apps/worker/,
// dotenv/config chercherait .env au mauvais endroit sans ce chemin explicite.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

// Squelette du worker d'expiration (section 22 du cahier des charges).
// Boucle simple, pas de Redis : recherche les événements échus, supprime les
// objets S3 (originaux/previews/thumbnails), passe l'event à EXPIRED.
// L'implémentation réelle arrive en Phase 6, une fois le stockage S3 branché (Phase 3).
//
// ATTENTION Phase 6 — le critère de balayage est `deleteAt <= now() AND status
// <> 'EXPIRED'`, PAS `status = 'REVEALED'` comme prévu initialement. Depuis la
// Phase 5, la révélation est paresseuse : un événement bascule en REVEALED
// quand on le consulte après son `revealAt` (apps/api/src/services/reveal.ts).
// Un événement que personne n'a ouvert après l'heure reste donc ACTIVE_LOCKED
// en base alors que sa date de suppression est passée — filtrer sur REVEALED
// le rendrait immortel, et ses photos ne seraient jamais supprimées (ce qui
// serait aussi un manquement à la promesse de rétention, section 15).

const INTERVAL_MS = 5 * 60 * 1000; // toutes les 5 minutes

async function runExpirationSweep() {
  console.log(`[worker] sweep expiration — ${new Date().toISOString()}`);
  // TODO Phase 6 : requête Drizzle sur events, suppression S3 idempotente, passage EXPIRED.
}

console.log("[worker] démarré");
runExpirationSweep();
setInterval(runExpirationSweep, INTERVAL_MS);
