import type { CameraFailure } from "../../lib/camera";

interface CameraPermissionProps {
  eventName: string;
  busy: boolean;
  failure: CameraFailure | null;
  onAllow: () => void;
  onSkip: () => void;
}

/**
 * Étape 3 : la demande d'accès à la caméra.
 *
 * L'invite du navigateur naît forcément d'un geste de l'invité (bouton) : sur
 * iOS, une demande automatique au chargement est ignorée, et sur les autres
 * navigateurs elle arriverait sans que l'invité sache pourquoi.
 *
 * Cet écran porte aussi le cas du refus. La gestion complète des erreurs est
 * prévue en Phase 10, mais celui-là ne peut pas attendre : un invité qui a dit
 * non — ou dont le navigateur a dit non pour lui — se retrouverait sinon
 * devant un écran noir sans la moindre explication.
 */
export default function CameraPermission({
  eventName,
  busy,
  failure,
  onAllow,
  onSkip,
}: CameraPermissionProps) {
  return (
    <section className="guest-screen">
      <p className="guest-eyebrow">{eventName}</p>
      <h1 className="guest-title">
        {failure ? failure.title : "Autorisez la caméra"}
      </h1>

      {failure ? (
        <div className="notice" role="alert">
          <p className="notice__body">{failure.message}</p>
          {failure.kind === "denied" ? (
            <p className="notice__body">
              Sur iPhone : Réglages → Safari → Caméra. Sur Android : l'icône à
              gauche de l'adresse → Autorisations.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="guest-lede">
          ADMEMRIZE utilise la caméra uniquement pendant que vous prenez des
          photos. Rien n'est enregistré sur votre téléphone, rien ne s'affiche
          après la prise de vue.
        </p>
      )}

      <div className="guest-actions">
        {!failure || failure.retryable ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onAllow}
            disabled={busy}
          >
            {busy
              ? "Ouverture de la caméra…"
              : failure
                ? "Réessayer"
                : "Autoriser la caméra"}
          </button>
        ) : null}

        <button type="button" className="btn btn--link" onClick={onSkip}>
          {failure
            ? "Continuer sans prendre de photo"
            : "Plus tard — voir le compte à rebours"}
        </button>
      </div>
    </section>
  );
}
