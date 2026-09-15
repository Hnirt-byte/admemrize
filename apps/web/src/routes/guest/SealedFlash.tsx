/**
 * Animation qui suit chaque capture (section 8 du master prompt).
 *
 * Elle ne montre jamais la photo — c'est tout l'objet de la capsule. Elle ne
 * montre pas non plus de vignette, de flou, de « miniature rassurante » : rien
 * qui puisse laisser deviner l'image. Le sceau remplace le retour visuel
 * habituel d'un appareil photo, et le compteur juste au-dessus fait le reste
 * de la preuve.
 *
 * Elle ne dit pas « envoyé » mais « scellé » : à cet instant la photo est
 * garantie en local (IndexedDB), pas encore forcément arrivée sur le serveur —
 * et du point de vue de l'invité, c'est exactement la même promesse.
 */
export default function SealedFlash() {
  return (
    <div className="seal" role="status" aria-live="polite">
      <div className="seal__mark" aria-hidden="true">
        🕯️
      </div>
      <p className="seal__label">Souvenir scellé</p>
      <p className="seal__hint">Vous le découvrirez à la révélation.</p>
    </div>
  );
}
