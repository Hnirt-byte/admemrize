import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import GuestWelcome from "./routes/guest/GuestWelcome";
import OrganizerHome from "./routes/organizer/OrganizerHome";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        {/* Flux invité : /e/:eventSlug — étape 1 du flux (section 8) */}
        <Route path="/e/:eventSlug" element={<GuestWelcome />} />
        {/* Flux organisateur : /app/... (section 25) */}
        <Route path="/app" element={<OrganizerHome />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
