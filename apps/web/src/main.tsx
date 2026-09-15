import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import GuestFlow from "./routes/guest/GuestFlow";
import OrganizerHome from "./routes/organizer/OrganizerHome";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        {/* Flux invité complet (section 8, Phase 7). Le paramètre est l'`id`
            (UUID) de l'événement : il n'existe pas de slug dans le schéma
            (apps/api/src/db/schema.ts), et le QR code de la Phase 8 pointera
            sur cette même forme d'URL. */}
        <Route path="/e/:eventId" element={<GuestFlow />} />
        {/* Flux organisateur : /app/... (section 25) */}
        <Route path="/app" element={<OrganizerHome />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
