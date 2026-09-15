interface GuestWelcomeProps {
  onStart: () => void;
}

/**
 * Étape 1 du flux invité (section 8 du master prompt) : expliquer la capsule
 * avant de demander quoi que ce soit.
 *
 * L'invité arrive ici par un QR code, sans rien savoir. Le nom de l'événement
 * n'est volontairement pas affiché : l'API ne le donne qu'une fois l'invité
 * joint (routes/guest.ts), et c'est cohérent — un lien scanné au hasard ne
 * doit pas révéler ce qui se passe et où.
 */
export default function GuestWelcome({ onStart }: GuestWelcomeProps) {
  return (
    <section className="guest-screen">
      <p className="guest-eyebrow">Capsule souvenir</p>
      <h1 className="guest-title">Vous êtes invité à sceller des souvenirs</h1>
      <p className="guest-lede">
        Les photos que vous prenez ici sont scellées immédiatement. Personne ne
        les voit — pas même vous — jusqu'à l'heure de la révélation.
      </p>

      <ul className="guest-points">
        <li>
          <span aria-hidden="true">📷</span>
          <span>
            Vous photographiez la soirée telle que vous la vivez, sans écran
            entre vous et elle.
          </span>
        </li>
        <li>
          <span aria-hidden="true">🔒</span>
          <span>
            Aucune photo ne s'affiche après la prise de vue : la surprise est
            gardée pour tout le monde.
          </span>
        </li>
        <li>
          <span aria-hidden="true">✨</span>
          <span>
            À l'heure dite, la capsule s'ouvre et tous les souvenirs sont
            révélés d'un coup.
          </span>
        </li>
      </ul>

      <div className="guest-actions">
        <button type="button" className="btn btn--primary" onClick={onStart}>
          Commencer
        </button>
      </div>
    </section>
  );
}
