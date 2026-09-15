import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeCamera,
  describeCameraFailure,
  openCamera,
  type CameraFacing,
  type CameraFailure,
} from "./camera";

export type CameraStatus = "idle" | "starting" | "ready" | "error";

export interface CameraController {
  status: CameraStatus;
  stream: MediaStream | null;
  failure: CameraFailure | null;
  facing: CameraFacing;
  /** Relance une ouverture — après un refus, ou une caméra occupée. */
  retry: () => Promise<void>;
  /** Bascule avant/arrière. */
  flip: () => Promise<void>;
}

/**
 * Cycle de vie du flux vidéo, piloté par un seul booléen : la caméra est
 * allumée quand l'écran qui en a besoin est affiché, éteinte sinon.
 *
 * Deux exigences se croisent ici. D'abord une caméra allumée consomme de la
 * batterie et garde la diode allumée : elle est coupée dès qu'on quitte
 * l'écran de capture, et dès que l'onglet passe en arrière-plan. Ensuite, sur
 * iOS, un flux obtenu avant une mise en arrière-plan revient souvent noir : la
 * seule parade est de rappeler `getUserMedia` au retour au premier plan, ce
 * qui ne redemande aucune permission une fois celle-ci accordée.
 *
 * `active` est la seule source de vérité — rappeler l'ouverture sur un flux
 * déjà ouvert est sans danger : l'ancien est fermé, le nouveau prend sa place.
 */
export function useCamera(active: boolean): CameraController {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [facing, setFacing] = useState<CameraFacing>("environment");

  const streamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<CameraFacing>("environment");
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Invalide le résultat d'une ouverture devenue obsolète (bascule, démontage). */
  const generationRef = useRef(0);

  /** Coupe les pistes sans toucher à l'état React — utilisable dans un nettoyage d'effet. */
  const releaseTracks = useCallback(() => {
    generationRef.current += 1;
    closeCamera(streamRef.current);
    streamRef.current = null;
  }, []);

  const start = useCallback(
    async (nextFacing?: CameraFacing) => {
      const wanted = nextFacing ?? facingRef.current;
      facingRef.current = wanted;

      releaseTracks();
      setStream(null);
      setFacing(wanted);
      setFailure(null);
      setStatus("starting");

      const generation = generationRef.current;

      try {
        const media = await openCamera(wanted);

        // Entre-temps l'invité a pu quitter l'écran ou rebasculer de caméra :
        // ce flux-là n'intéresse plus personne et ne doit pas rester ouvert.
        if (generation !== generationRef.current || !activeRef.current) {
          closeCamera(media);
          return;
        }

        streamRef.current = media;
        setStream(media);
        setStatus("ready");
      } catch (error) {
        if (generation !== generationRef.current) return;
        setFailure(describeCameraFailure(error));
        setStatus("error");
      }
    },
    [releaseTracks]
  );

  useEffect(() => {
    if (!active) {
      releaseTracks();
      setStream(null);
      setStatus("idle");
      setFailure(null);
      return;
    }

    void start();

    // Sur un démontage réel comme sur le double montage de StrictMode, les
    // pistes sont coupées ; l'ouverture qui suit repart d'une génération
    // neuve et écrase tout état laissé par la précédente.
    return releaseTracks;
  }, [active, start, releaseTracks]);

  useEffect(() => {
    if (!active) return;

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        releaseTracks();
        setStream(null);
        setStatus("starting");
      } else {
        void start();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [active, start, releaseTracks]);

  const retry = useCallback(() => start(), [start]);

  const flip = useCallback(
    () => start(facingRef.current === "environment" ? "user" : "environment"),
    [start]
  );

  return { status, stream, failure, facing, retry, flip };
}
