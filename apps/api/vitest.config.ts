import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // PGlite embarque un Postgres WebAssembly : on lui laisse le temps de démarrer
    // et de jouer les migrations dans les hooks.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Un processus par fichier de test : chaque suite a sa propre base isolée.
    pool: "forks",
  },
});
