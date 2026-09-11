import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Ce fichier est à apps/api/ (pas apps/api/src/) : un niveau de moins que
// index.ts pour remonter à la racine du repo. Même cause que index.ts et
// worker/index.ts — voir architecture-v1-addendum.md section 8.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
