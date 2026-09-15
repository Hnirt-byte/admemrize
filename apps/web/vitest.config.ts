import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Pas de jsdom : ce qui est testé ici est la logique de la queue d'envoi,
    // pas du rendu React. Les quelques API navigateur dont elle dépend
    // (IndexedDB, navigator.onLine) sont fournies par test/setup.ts.
    environment: "node",
    setupFiles: ["test/setup.ts"],
  },
});
