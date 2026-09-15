import { UPLOAD_CONTENT_TYPE } from "@admemrize/shared";

export type CameraFacing = "environment" | "user";

/**
 * Côté le plus long de la photo produite, en pixels. La capture part de la
 * résolution réelle du flux vidéo (souvent 1280 ou 1920 de large) et n'est
 * réduite que si elle dépasse : un JPEG de 2560 px reste largement au-dessus
 * de ce dont a besoin l'aperçu généré côté serveur (1600 px, routes/photos.ts)
 * et très loin de la limite de 15 Mo.
 */
const MAX_CAPTURE_DIMENSION = 2560;

/** Compromis qualité/poids habituel pour une photo souvenir. */
const JPEG_QUALITY = 0.92;

export type CameraErrorKind =
  | "denied"
  | "unavailable"
  | "insecure-context"
  | "in-use"
  | "unknown";

export interface CameraFailure {
  kind: CameraErrorKind;
  title: string;
  message: string;
  /** Faux quand réessayer ne peut rien changer sans action de l'invité. */
  retryable: boolean;
}

/**
 * Traduit l'échec de `getUserMedia` en quelque chose d'affichable.
 *
 * La gestion complète des erreurs arrive en Phase 10, mais un refus de la
 * caméra ne doit jamais laisser l'invité devant un écran vide : c'est le seul
 * cas où il n'a aucun moyen de deviner ce qui se passe ni quoi faire.
 */
export function describeCameraFailure(error: unknown): CameraFailure {
  if (!isSecureCameraContext()) {
    return {
      kind: "insecure-context",
      title: "Caméra indisponible sur cette adresse",
      message:
        "Les navigateurs n'autorisent la caméra qu'en HTTPS (ou sur localhost). Ouvrez le lien de l'événement en https:// pour prendre des photos.",
      retryable: false,
    };
  }

  const name = error instanceof DOMException ? error.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        kind: "denied",
        title: "Caméra bloquée",
        message:
          "Vous avez refusé l'accès à la caméra, ou votre navigateur l'a bloqué. Autorisez-la dans les réglages du site (l'icône à gauche de l'adresse), puis réessayez.",
        retryable: true,
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        kind: "unavailable",
        title: "Aucune caméra détectée",
        message:
          "Cet appareil ne semble pas avoir de caméra utilisable par le navigateur.",
        retryable: true,
      };
    case "NotReadableError":
    case "AbortError":
      return {
        kind: "in-use",
        title: "Caméra occupée",
        message:
          "Une autre application utilise déjà la caméra. Fermez-la, puis réessayez.",
        retryable: true,
      };
    default:
      return {
        kind: "unknown",
        title: "La caméra n'a pas pu démarrer",
        message:
          "Réessayez ; si rien ne change, rouvrez le lien de l'événement dans un autre navigateur.",
        retryable: true,
      };
  }
}

/** `getUserMedia` n'existe que dans un contexte sécurisé (HTTPS, ou localhost en dev). */
export function isSecureCameraContext(): boolean {
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Ouvre le flux vidéo. `facingMode: "environment"` demande la caméra arrière
 * (architecture-v1-addendum.md, section 2) : c'est celle qui filme la scène,
 * pas l'invité. `ideal` et non `exact` — un ordinateur portable n'a qu'une
 * caméra frontale, et il vaut mieux la lui donner que d'échouer.
 */
export async function openCamera(facing: CameraFacing): Promise<MediaStream> {
  if (!isSecureCameraContext()) {
    throw new DOMException("getUserMedia indisponible", "SecurityError");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
}

export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Fige l'image courante du flux en JPEG.
 *
 * Le canvas n'est jamais attaché au document et le blob n'est jamais rendu à
 * l'écran : l'invité ne voit pas la photo qu'il vient de prendre, c'est la
 * promesse même de la capsule (section 7 du master prompt).
 *
 * Passer par `canvas.toBlob("image/jpeg")` garantit aussi qu'aucun fichier
 * HEIC n'entre jamais dans le système (addendum, section 1) : le JPEG est
 * produit par le navigateur, pas choisi par l'appareil photo. Corollaire
 * utile pour la vie privée : un canvas ne porte aucune métadonnée EXIF, donc
 * aucune coordonnée GPS ne quitte le téléphone.
 */
export async function captureJpeg(video: HTMLVideoElement): Promise<Blob> {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Le flux vidéo n'est pas encore prêt.");
  }

  const scale = Math.min(
    1,
    MAX_CAPTURE_DIMENSION / Math.max(sourceWidth, sourceHeight)
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Impossible de préparer la capture.");
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, UPLOAD_CONTENT_TYPE, JPEG_QUALITY);
  });

  if (!blob) {
    throw new Error("La photo n'a pas pu être encodée.");
  }
  return blob;
}

export type CameraPermissionState = "granted" | "denied" | "prompt" | "unknown";

/**
 * Consulte l'état de la permission caméra sans ouvrir le flux ni faire
 * apparaître d'invite.
 *
 * Sert à décider, au retour d'un invité déjà inscrit, s'il peut aller
 * directement à l'écran de capture ou s'il faut repasser par l'écran qui
 * explique la demande. L'API Permissions n'est pas implémentée partout pour
 * `camera` (Safari notamment) : "unknown" fait alors repasser par l'écran
 * d'explication, qui est de toute façon le comportement sûr — une invite du
 * navigateur doit naître d'un geste de l'invité.
 */
export async function probeCameraPermission(): Promise<CameraPermissionState> {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({
      name: "camera" as PermissionName,
    });
    return status.state;
  } catch {
    return "unknown";
  }
}
