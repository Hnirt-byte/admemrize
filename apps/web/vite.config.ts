import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        // Placeholder — le nom définitif remplacera ADMEMRIZE (section 27)
        name: "ADMEMRIZE",
        short_name: "ADMEMRIZE",
        description: "Capturez. Scellez. Révélez ensemble.",
        theme_color: "#E8DCC8", // sable — direction Organic Premium (section 26)
        background_color: "#FAF7F0",
        display: "standalone",
        start_url: "/",
        icons: [
          // TODO Phase 10 : icônes réelles (192x192, 512x512) une fois l'identité définie
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
