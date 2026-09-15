import type { GuestEventView } from "@admemrize/shared";
import { useCountdown } from "../../lib/use-countdown";

interface WaitingScreenProps {
  event: GuestEventView;
  sealed: number;
  pending: number;
  failed: number;
  online: boolean;
  syncing: boolean;
  /** Dernier échec d'envoi, affiché seulement s'il reste quelque chose à envoyer. */
  lastError: string | null;
  /** Vrai tant que la caméra reste une option (permission jamais refusée). */
  canCapture: boolean;
  onBackToCamera: () => void;
  onRetryNow: () => void;
  /** Appelé une fois quand le compte à rebours atteint zéro. */
  onRevealDue: () => void;
}

function CountdownUnit({ value, label }: { value: number; label: string }) {
  return (
    <div className="countdown__unit">
      <span className="countdown__number">
        {value.toString().padStart(2, "0")}
      </span>
      <span className="countdown__unit-label">{label}</span>
    </div>
  );
}

/**
 * Étape 5 : l'attente (section 8 du master prompt).
 *
 * Deux choses à dire à l'invité, et deux seulement : combien de souvenirs il a
 * scellés, et dans combien de temps la capsule s'ouvre.
 *
 * Le compte à rebours est un affichage, jamais une décision : c'est le
 * **statut** renvoyé par le serveur qui dit si la capsule est ouverte. Un
 * événement peut très bien être `REVEALED` alors que son `revealAt` est encore
 * dans le futur — révélation anticipée par l'organisateur (addendum,
 * section 10, point 11).
 */
export default function WaitingScreen({
  event,
  sealed,
  pending,
  failed,
  online,
  syncing,
  lastError,
  canCapture,
  onBackToCamera,
  onRetryNow,
  onRevealDue,
}: WaitingScreenProps) {
  const revealed = event.status === "REVEALED";
  const countdown = useCountdown(event.revealAt, onRevealDue);

  return (
    <section className="guest-screen guest-screen--top">
      <p className="guest-eyebrow">{event.name}</p>
      <h1 className="guest-title">
        {revealed ? "La capsule est ouverte" : "Vos souvenirs sont scellés"}
      </h1>

      <div className="counters">
        <div className="counter">
          <span className="counter__value">{sealed + pending}</span>
          <span className="counter__label">
            souvenir{sealed + pending > 1 ? "s" : ""} scellé
            {sealed + pending > 1 ? "s" : ""}
          </span>
        </div>
        {pending > 0 ? (
          <div className="counter">
            <span className="counter__value">{pending}</span>
            <span className="counter__label">en attente de réseau</span>
          </div>
        ) : null}
        {failed > 0 ? (
          <div className="counter">
            <span className="counter__value">{failed}</span>
            <span className="counter__label">refusée{failed > 1 ? "s" : ""}</span>
          </div>
        ) : null}
      </div>

      <p className="queue-state" role="status">
        <span
          className={
            !online
              ? "queue-state__dot queue-state__dot--offline"
              : pending > 0
                ? "queue-state__dot"
                : "queue-state__dot queue-state__dot--synced"
          }
          aria-hidden="true"
        />
        {!online
          ? "Hors ligne — vos photos sont gardées sur cet appareil."
          : syncing && pending > 0
            ? "Envoi en cours…"
            : pending > 0
              ? "Envoi dès que la connexion le permet."
              : "Tout est arrivé à bon port."}
      </p>

      {lastError && (pending > 0 || failed > 0) ? (
        <p className="field__hint" role="status">
          Dernier message du serveur : {lastError}
        </p>
      ) : null}

      {pending > 0 ? (
        <p className="guest-lede">
          Gardez cette page ouverte : les photos en attente repartent
          d'elles-mêmes au retour du réseau, ou dès que vous revenez sur cet
          onglet.
        </p>
      ) : null}

      {revealed ? (
        <p className="guest-lede">
          Les souvenirs de la soirée sont révélés. {/* Phase 9 : remplacer ce
          paragraphe par l'accès à la galerie. */}
        </p>
      ) : (
        <>
          <p className="guest-lede">La capsule s'ouvre dans</p>
          <div className="countdown">
            {countdown.days > 0 ? (
              <CountdownUnit value={countdown.days} label="jours" />
            ) : null}
            <CountdownUnit value={countdown.hours} label="heures" />
            <CountdownUnit value={countdown.minutes} label="min" />
            <CountdownUnit value={countdown.seconds} label="sec" />
          </div>
          {countdown.due ? (
            <p className="guest-lede">
              L'heure est passée — en attente de la confirmation du serveur.
            </p>
          ) : null}
        </>
      )}

      <div className="guest-actions">
        {canCapture ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onBackToCamera}
          >
            Prendre d'autres photos
          </button>
        ) : null}
        {pending > 0 || failed > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={onRetryNow}>
            Réessayer l'envoi maintenant
          </button>
        ) : null}
      </div>
    </section>
  );
}
