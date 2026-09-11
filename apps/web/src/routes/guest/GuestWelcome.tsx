import { useParams } from "react-router-dom";

// Étape 2 du flux invité (section 8) : écran de bienvenue expliquant
// le principe de la capsule avant de demander le prénom.
// Implémentation réelle en Phase 7.
export default function GuestWelcome() {
  const { eventSlug } = useParams();

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Bienvenue 👋</h1>
      <p>Événement : {eventSlug}</p>
      <p>
        Les photos que vous prenez seront scellées jusqu'à la révélation.
      </p>
    </main>
  );
}
