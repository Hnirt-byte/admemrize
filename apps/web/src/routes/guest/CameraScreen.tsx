import { useEffect, useRef, useState } from "react";
import { captureJpeg } from "../../lib/camera";
import type { CameraController } from "../../lib/use-camera";
import SealedFlash from "./SealedFlash";

interface CameraScreenProps {
  eventName: string;
  camera: CameraController;
  sealed: number;
  pending: number;
  online: boolean;
  onCapture: (blob: Blob, capturedAt: Date) => Promise<void>;
  onOpenWaiting: () => void;
}

/** Durée de l'animation « Souvenir scellé » avant le retour au cadrage. */
const SEAL_DURATION_MS = 1700;
const SEAL_DURATION_REDUCED_MS = 800;

function sealDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? SEAL_DURATION_REDUCED_MS
    : SEAL_DURATION_MS;
}

/**
 * Étape 4 : l'écran de capture (section 8 du master prompt).
 *
 * Le flux vidéo est le seul élément visuel : il n'y a ni galerie, ni dernière
 * photo prise, ni aperçu. Le `<canvas>` qui fige l'image vit le temps d'un
 * appel et n'est jamais attaché au document (lib/camera.ts).
 */
export default function CameraScreen({
  eventName,
  camera,
  sealed,
  pending,
  online,
  onCapture,
  onOpenWaiting,
}: CameraScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sealing, setSealing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.srcObject = camera.stream;
    if (camera.stream) {
      // Safari peut refuser la lecture automatique dans certains contextes ;
      // l'échec ne doit pas remonter en exception non gérée.
      void video.play().catch(() => undefined);
    }
  }, [camera.stream]);

  useEffect(() => {
    if (!sealing) return;
    const timer = window.setTimeout(() => setSealing(false), sealDuration());
    return () => window.clearTimeout(timer);
  }, [sealing]);

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video || camera.status !== "ready" || busy) return;

    setBusy(true);
    setCaptureError(null);

    try {
      // Horodatage pris avant l'encodage : c'est l'instant de la photo, pas
      // celui où le navigateur a fini son travail. L'original stocké ne garde
      // aucun EXIF, cette valeur est la seule trace de l'heure de prise de vue
      // (ConfirmPhotoInput, packages/shared).
      const capturedAt = new Date();
      const blob = await captureJpeg(video);
      setSealing(true);
      await onCapture(blob, capturedAt);
    } catch (error) {
      setSealing(false);
      setCaptureError(
        error instanceof Error
          ? error.message
          : "La photo n'a pas pu être enregistrée."
      );
    } finally {
      setBusy(false);
    }
  };

  const shutterDisabled = camera.status !== "ready" || busy;
  const sealedTotal = sealed + pending;

  return (
    <section className="camera">
      <video
        ref={videoRef}
        className={
          camera.facing === "user"
            ? "camera__video camera__video--mirrored"
            : "camera__video"
        }
        playsInline
        muted
        autoPlay
      />

      {camera.status !== "ready" ? (
        <div className="camera__status" role="status">
          {camera.status === "error" && camera.failure ? (
            <>
              <p className="notice__title">{camera.failure.title}</p>
              <p>{camera.failure.message}</p>
              <button
                type="button"
                className="camera__chip"
                onClick={() => void camera.retry()}
              >
                Réessayer
              </button>
            </>
          ) : (
            <p>Ouverture de la caméra…</p>
          )}
        </div>
      ) : null}

      <div className="camera__top">
        <div className="camera__event">
          <strong>{eventName}</strong>
          <span>
            {/* Une photo capturée est scellée du point de vue de l'invité, même
                si elle n'est pas encore partie : c'est la promesse tenue par la
                copie locale. L'état du réseau est dit à côté, sans inquiéter. */}
            {sealedTotal} scellé{sealedTotal > 1 ? "s" : ""}
            {pending > 0 ? ` · ${pending} en attente` : ""}
            {!online ? " · hors ligne" : ""}
          </span>
        </div>
        <button
          type="button"
          className="camera__chip"
          onClick={onOpenWaiting}
        >
          Révélation
        </button>
      </div>

      <div className="camera__bottom">
        <div className="camera__side">
          <button
            type="button"
            className="camera__chip"
            onClick={() => void camera.flip()}
            disabled={camera.status === "starting"}
          >
            {camera.facing === "environment" ? "Selfie" : "Arrière"}
          </button>
        </div>

        <button
          type="button"
          className="shutter"
          onClick={() => void handleCapture()}
          disabled={shutterDisabled}
          aria-label="Prendre une photo"
        />

        <div className="camera__side camera__side--right">
          {captureError ? (
            <span className="camera__chip" role="alert">
              {captureError}
            </span>
          ) : null}
        </div>
      </div>

      {sealing ? <SealedFlash /> : null}
    </section>
  );
}
