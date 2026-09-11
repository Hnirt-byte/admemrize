import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Même cause qu'côté API : npm workspaces exécute ce script depuis apps/worker/,
// dotenv/config chercherait .env au mauvais endroit sans ce chemin explicite.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

// Squelette du worker d'expiration (section 22 du cahier des charges).
// Boucle simple, pas de Redis : recherche deleteAt <= now AND status = REVEALED,
// supprime les objets S3 (originaux/previews/thumbnails), passe l'event à EXPIRED.
// L'implémentation réelle arrive en Phase 6, une fois le stockage S3 branché (Phase 3).

const INTERVAL_MS = 5 * 60 * 1000; // toutes les 5 minutes

async function runExpirationSweep() {
  console.log(`[worker] sweep expiration — ${new Date().toISOString()}`);
  // TODO Phase 6 : requête Drizzle sur events, suppression S3 idempotente, passage EXPIRED.
}

console.log("[worker] démarré");
runExpirationSweep();
setInterval(runExpirationSweep, INTERVAL_MS);
