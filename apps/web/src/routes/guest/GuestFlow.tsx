import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, NetworkError } from "../../lib/api";
import { probeCameraPermission } from "../../lib/camera";
import {
  clearSession,
  join,
  loadSession,
  refreshSession,
  type StoredGuestSession,
} from "../../lib/guest-session";
import { useCamera } from "../../lib/use-camera";
import {
  flushQueue,
  sealPhoto,
  startSync,
  useSyncStore,
} from "../../lib/upload-sync";
import CameraPermission from "./CameraPermission";
import CameraScreen from "./CameraScreen";
import GuestWelcome from "./GuestWelcome";
import NicknameForm from "./NicknameForm";
import WaitingScreen from "./WaitingScreen";
import "./guest.css";

type Step =
  | "loading"
  | "welcome"
  | "nickname"
  | "permission"
  | "camera"
  | "waiting"
  | "unavailable";

interface FatalState {
  title: string;
  message: string;
}

/** Le paramètre de route est l'`id` (UUID) de l'événement — il n'existe pas de slug en base. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Intervalle minimal entre deux rafraîchissements automatiques de l'état de
 * l'événement.
 *
 * `/guest/join` est la seule route invité encore comptée par IP — c'est elle
 * qui crée la session, il n'y a rien d'autre à compter à ce moment-là
 * (plugins/rate-limit.ts). Tous les invités d'une même salle partagent donc ce
 * quota, plafond relevé ou non : un rafraîchissement à chaque retour au premier
 * plan ferait tomber la salle entière dessus, alors que l'état de l'événement,
 * lui, ne change qu'une fois dans la soirée.
 */
const EVENT_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Orchestrateur du flux invité (sections 7 à 9 du master prompt) :
 * bienvenue → prénom → permission caméra → capture → attente.
 *
 * Deux principes gouvernent tout ce fichier :
 *
 * 1. Le réseau n'est jamais une condition pour avancer. Un invité déjà inscrit
 *    qui rouvre le lien dans une cave sans 4G doit arriver à l'écran caméra et
 *    pouvoir photographier — la session et l'événement connus sont relus
 *    depuis `localStorage`, le rafraîchissement se fait en arrière-plan et son
 *    échec ne bloque rien.
 * 2. L'invité ne revoit jamais la saisie du prénom une fois l'appareil connu :
 *    `/guest/join` est idempotent par `deviceId` (Phase 2), donc revenir
 *    revient simplement à rafraîchir le jeton.
 */
export default function GuestFlow() {
  const { eventId = "" } = useParams();
  const validEventId = UUID_PATTERN.test(eventId);

  const [step, setStep] = useState<Step>("loading");
  const [session, setSession] = useState<StoredGuestSession | null>(null);
  const [fatal, setFatal] = useState<FatalState | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Une invite de permission doit naître d'un geste : la caméra ne s'allume
  // sur l'écran d'explication qu'après le bouton « Autoriser ».
  const [cameraRequested, setCameraRequested] = useState(false);
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const camera = useCamera(
    step === "camera" || (step === "permission" && cameraRequested)
  );
  const sync = useSyncStore();

  const lastEventRefreshRef = useRef(0);

  /**
   * Traduit un échec d'appel à `/guest/join`. Un événement supprimé ou expiré
   * est définitif : la session locale est effacée, sinon l'invité reviendrait
   * indéfiniment sur un écran mort.
   */
  const handleJoinFailure = useCallback(
    (error: unknown): FatalState | null => {
      if (error instanceof NetworkError) return null;

      if (error instanceof ApiError) {
        if (error.status === 410 || error.code === "EVENT_EXPIRED") {
          clearSession(eventId);
          return {
            title: "Cet événement est terminé",
            message:
              "Les photos ont été supprimées, comme promis à l'organisateur. Il n'y a plus rien à voir ici.",
          };
        }
        if (error.status === 404) {
          clearSession(eventId);
          return {
            title: "Événement introuvable",
            message:
              "Ce lien ne correspond à aucun événement. Demandez à l'organisateur de vous renvoyer son QR code.",
          };
        }
      }
      return null;
    },
    [eventId]
  );

  /** Rafraîchit l'événement (statut, heure de révélation) sans jamais bloquer l'écran. */
  const refreshEvent = useCallback(
    async (force = false) => {
      if (!loadSession(eventId)) return;
      if (
        !force &&
        Date.now() - lastEventRefreshRef.current < EVENT_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      lastEventRefreshRef.current = Date.now();

      try {
        const refreshed = await refreshSession(eventId);
        if (refreshed) setSession(refreshed);
      } catch (error) {
        const failure = handleJoinFailure(error);
        if (failure) {
          setFatal(failure);
          setStep("unavailable");
        }
        // Sinon : hors ligne. La vue locale reste affichée, elle est
        // suffisamment juste pour continuer à prendre des photos.
      }
    },
    [eventId, handleJoinFailure]
  );

  // Démarrage : décider de l'écran d'entrée sans dépendre du réseau.
  useEffect(() => {
    if (!validEventId) {
      setFatal({
        title: "Lien invalide",
        message:
          "Ce lien n'a pas la forme attendue. Rescannez le QR code de l'événement.",
      });
      setStep("unavailable");
      return;
    }

    let cancelled = false;

    const stored = loadSession(eventId);
    if (!stored) {
      setStep("welcome");
      return;
    }

    setSession(stored);

    void (async () => {
      // Permission déjà accordée : l'invité retrouve son cadrage directement,
      // sans écran intermédiaire ni nouvelle invite du navigateur.
      const permission = await probeCameraPermission();
      if (cancelled) return;
      setStep(permission === "granted" ? "camera" : "permission");
    })();

    void refreshEvent(true);

    return () => {
      cancelled = true;
    };
  }, [eventId, validEventId, refreshEvent]);

  // Reprise de la queue offline : dès qu'une session existe, indépendamment de
  // l'écran affiché — une photo en attente doit repartir même si l'invité est
  // resté sur l'écran d'attente.
  const joined = session !== null;
  useEffect(() => {
    if (!validEventId || !joined) return;
    return startSync(eventId);
  }, [eventId, validEventId, joined]);

  // Retour au premier plan : le moment où l'on vérifie si la capsule s'est
  // ouverte pendant l'absence.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshEvent();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshEvent]);

  // Un refus définitif (contexte non sécurisé, pas de caméra du tout) se
  // retient : l'écran d'attente cesse alors de proposer de photographier,
  // plutôt que de renvoyer l'invité vers un bouton qui ne marchera pas.
  useEffect(() => {
    if (camera.failure && !camera.failure.retryable) setCameraBlocked(true);
  }, [camera.failure]);

  const handleJoin = async (nickname: string) => {
    setJoining(true);
    setJoinError(null);

    try {
      const created = await join(eventId, nickname);
      setSession(created);
      lastEventRefreshRef.current = Date.now();
      setStep("permission");
    } catch (error) {
      const failure = handleJoinFailure(error);
      if (failure) {
        setFatal(failure);
        setStep("unavailable");
      } else if (error instanceof NetworkError) {
        setJoinError(
          "Impossible de rejoindre l'événement sans connexion. Réessayez dès que vous avez du réseau."
        );
      } else {
        setJoinError(
          error instanceof Error
            ? error.message
            : "La connexion à l'événement a échoué."
        );
      }
    } finally {
      setJoining(false);
    }
  };

  const handleAllowCamera = () => {
    // Premier appui : allumer la caméra suffit à déclencher l'invite du
    // navigateur. Appuis suivants (après un refus) : forcer une relance.
    if (cameraRequested) {
      void camera.retry();
    } else {
      setCameraRequested(true);
    }
  };

  // C'est cet effet, et lui seul, qui fait avancer l'écran : la bascule suit
  // l'état réel du flux vidéo, jamais la simple résolution d'une promesse.
  useEffect(() => {
    if (step === "permission" && camera.status === "ready") {
      setStep("camera");
    }
  }, [step, camera.status]);

  const handleCapture = useCallback(
    async (blob: Blob, capturedAt: Date) => {
      await sealPhoto(eventId, blob, capturedAt);
    },
    [eventId]
  );

  if (step === "unavailable" && fatal) {
    return (
      <main className="guest-flow">
        <section className="guest-screen">
          <h1 className="guest-title">{fatal.title}</h1>
          <p className="guest-lede">{fatal.message}</p>
        </section>
      </main>
    );
  }

  if (step === "loading" || (step !== "welcome" && step !== "nickname" && !session)) {
    return (
      <main className="guest-flow">
        <section className="guest-screen">
          <p className="guest-lede" role="status">
            Ouverture de la capsule…
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="guest-flow">
      {step === "welcome" ? (
        <GuestWelcome onStart={() => setStep("nickname")} />
      ) : null}

      {step === "nickname" ? (
        <NicknameForm
          onSubmit={(nickname) => void handleJoin(nickname)}
          busy={joining}
          error={joinError}
        />
      ) : null}

      {step === "permission" && session ? (
        <CameraPermission
          eventName={session.event.name}
          busy={camera.status === "starting"}
          failure={camera.failure}
          onAllow={handleAllowCamera}
          onSkip={() => setStep("waiting")}
        />
      ) : null}

      {step === "camera" && session ? (
        <CameraScreen
          eventName={session.event.name}
          camera={camera}
          sealed={sync.sealed}
          pending={sync.pending}
          online={sync.online}
          onCapture={handleCapture}
          onOpenWaiting={() => setStep("waiting")}
        />
      ) : null}

      {step === "waiting" && session ? (
        <WaitingScreen
          event={session.event}
          sealed={sync.sealed}
          pending={sync.pending}
          failed={sync.failed}
          online={sync.online}
          syncing={sync.syncing}
          lastError={sync.lastError}
          canCapture={!cameraBlocked}
          onBackToCamera={() => setStep("camera")}
          onRetryNow={() => void flushQueue(eventId, { force: true })}
          onRevealDue={() => void refreshEvent(true)}
        />
      ) : null}
    </main>
  );
}
