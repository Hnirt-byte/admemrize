import { useState, type FormEvent } from "react";
import { lastNickname } from "../../lib/guest-session";

interface NicknameFormProps {
  onSubmit: (nickname: string) => void;
  busy: boolean;
  error: string | null;
}

/** Même borne que `GuestJoinInput` côté API : refusé au-delà (packages/shared). */
const MAX_NICKNAME_LENGTH = 40;

/**
 * Étape 2 : le prénom.
 *
 * C'est la seule donnée personnelle demandée à un invité, et elle ne sert qu'à
 * signer ses photos dans la galerie. Aucun compte, aucun email, aucun mot de
 * passe (section 15, vie privée).
 */
export default function NicknameForm({
  onSubmit,
  busy,
  error,
}: NicknameFormProps) {
  const [nickname, setNickname] = useState(lastNickname);

  const trimmed = nickname.trim();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <form className="guest-screen" onSubmit={handleSubmit}>
      <p className="guest-eyebrow">Étape 1 sur 2</p>
      <h1 className="guest-title">Comment vous appelez-vous ?</h1>
      <p className="guest-lede">
        Votre prénom accompagnera vos photos le jour de la révélation.
      </p>

      <div className="field">
        <label htmlFor="nickname">Prénom</label>
        <input
          id="nickname"
          name="nickname"
          type="text"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={MAX_NICKNAME_LENGTH}
          autoComplete="given-name"
          autoFocus
          enterKeyHint="go"
          required
          disabled={busy}
        />
        <span className="field__hint">
          {MAX_NICKNAME_LENGTH} caractères maximum. Un surnom fait très bien
          l'affaire.
        </span>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="guest-actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || trimmed.length === 0}
        >
          {busy ? "Connexion…" : "Rejoindre l'événement"}
        </button>
      </div>
    </form>
  );
}
