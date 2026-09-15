import { create } from "zustand";
import {
  ApiError,
  NetworkError,
  authorizeUpload,
  confirmPhoto,
  uploadToStorage,
} from "./api";
import { countSealed, loadSession, withGuestToken } from "./guest-session";
import {
  dropQueuedPhoto,
  enqueuePhoto,
  getQueuedPhoto,
  listQueuedPhotos,
  saveQueuedPhoto,
  type QueuedPhoto,
} from "./offline-queue";

/**
 * Moteur de synchronisation de la queue offline.
 *
 * Il n'y a pas de Background Sync : Safari/WebKit ne l'implémente pas
 * (addendum, section 2), donc aucune resynchronisation silencieuse onglet
 * fermé. La reprise se fait sur des événements du navigateur — retour au
 * premier plan, retour du réseau — et c'est une limite assumée de la V1 :
 * l'invité garde la page ouverte pendant l'événement, ou y revient.
 */

interface SyncState {
  /** Photos prises sur cet appareil et confirmées par le serveur. */
  sealed: number;
  /** Photos capturées, pas encore confirmées : elles existent, en local. */
  pending: number;
  /**
   * Photos bloquées par un refus qui ne concerne pas le fichier (quota,
   * événement expiré) : plus de tentative, mais la copie locale est gardée.
   * Une photo rejetée par la validation du serveur, elle, disparaît sans
   * jamais passer par ce compteur.
   */
  failed: number;
  syncing: boolean;
  online: boolean;
  /** Dernier échec rencontré, pour une ligne d'explication discrète. */
  lastError: string | null;
}

export const useSyncStore = create<SyncState>(() => ({
  sealed: 0,
  pending: 0,
  failed: 0,
  syncing: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  lastError: null,
}));

/** Palier de reprise : 30 s, 1 min, 2 min... plafonné à 5 min. */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

type Disposition =
  /**
   * Réessayable : le réseau, le serveur ou le quota du moment, pas la photo.
   * `retryAfterMs` n'est renseigné que si le serveur a dit quand revenir.
   */
  | { kind: "retry"; message: string; retryAfterMs?: number }
  /** Le fichier n'est plus sur le stockage : tout reprendre depuis l'envoi. */
  | { kind: "restart"; message: string }
  /** Rien ne changera en réessayant. */
  | { kind: "permanent"; message: string };

/** Lit `details.retryAfterSeconds` d'une réponse 429, s'il est exploitable. */
function retryAfterMs(details: unknown): number | undefined {
  const value = (details as { retryAfterSeconds?: unknown } | undefined)
    ?.retryAfterSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // Borne haute : un serveur mal configuré ne doit pas endormir la file pour
  // une heure. Au-delà, le rythme de reprise habituel reprend la main.
  return Math.min(value, 600) * 1000;
}

/**
 * Décide du sort d'une photo après un échec.
 *
 * Le doute profite toujours à la photo : tout ce qui n'est pas clairement
 * définitif est réessayé, parce que la promesse de la Phase 7 est qu'une photo
 * ne se perd jamais à cause du réseau.
 */
function classify(error: unknown): Disposition {
  if (error instanceof NetworkError) {
    return { kind: "retry", message: "Réseau indisponible." };
  }

  if (error instanceof ApiError) {
    if (error.status === 404 && error.code === "ORIGINAL_NOT_FOUND") {
      return { kind: "restart", message: "Envoi à refaire." };
    }
    if (error.status === 429) {
      // Le serveur dit lui-même quand son quota se rouvre
      // (details.retryAfterSeconds, apps/api/src/plugins/rate-limit.ts) : le
      // suivre évite autant de revenir trop tôt pour rien que d'attendre bien
      // après la réouverture.
      return {
        kind: "retry",
        message: error.message,
        retryAfterMs: retryAfterMs(error.details),
      };
    }
    if (
      error.status === 408 ||
      error.status >= 500 ||
      error.status === 401 ||
      error.code === "STORAGE_UPLOAD_FAILED"
    ) {
      return { kind: "retry", message: error.message };
    }
    // 400, 404 EVENT_NOT_FOUND, 409 (quotas, événement expiré), 410 : le
    // serveur a tranché, réessayer ne ferait que consommer du réseau.
    return { kind: "permanent", message: error.message };
  }

  return {
    kind: "retry",
    message: error instanceof Error ? error.message : "Échec inattendu.",
  };
}

/**
 * Envoie une photo en attente, de l'autorisation jusqu'à la confirmation.
 *
 * La progression est écrite en base locale entre les deux étapes : si la
 * confirmation échoue, la reprise repart de là et ne renvoie pas le fichier une
 * seconde fois. `/photos/confirm` étant idempotent (routes/photos.ts), la
 * rejouer sur un `photoId` déjà traité est sans effet de bord.
 */
async function processItem(item: QueuedPhoto): Promise<void> {
  let current = item;

  if (current.stage === "TO_UPLOAD" || !current.photoId) {
    const authorization = await withGuestToken(current.eventId, (token) =>
      authorizeUpload(token, current.blob.size),
    );
    await uploadToStorage(authorization.uploadUrl, current.blob);

    current = { ...current, stage: "UPLOADED", photoId: authorization.photoId };
    await saveQueuedPhoto(current);
  }

  const photo = await withGuestToken(current.eventId, (token) =>
    confirmPhoto(token, {
      photoId: current.photoId!,
      capturedAt: current.capturedAt,
    }),
  );

  if (photo.status === "READY") {
    // Le serveur a la photo, ses dérivés sont générés : elle est scellée pour
    // de bon, la copie locale n'a plus de raison d'être.
    await dropQueuedPhoto(current.localId);
    countSealed(current.eventId);
    return;
  }

  if (photo.status === "FAILED") {
    // Verdict définitif et déjà rendu : le serveur a téléchargé le fichier,
    // lu ses magic bytes, vérifié sa taille, et l'a refusé (routes/photos.ts).
    // Le renvoyer donnerait exactement le même résultat, et le garder ne
    // ferait qu'occuper le téléphone pour rien. Il part, sans compter comme un
    // souvenir scellé — cette photo n'existe pas côté serveur.
    //
    // L'invité n'en saura rien. Il n'a jamais vu cette image et ne peut pas la
    // refaire : lui signaler une perte qu'il ne peut ni constater ni réparer
    // trahirait la promesse de la capsule sans lui rendre le moindre service.
    // La trace reste dans la console, pour le débogage.
    console.warn(
      `[admemrize] Photo refusée par le serveur, copie locale supprimée (${current.photoId}).`,
    );
    await dropQueuedPhoto(current.localId);
    return;
  }

  // PENDING/PROCESSING/DELETED : état transitoire ou inattendu, on réessaiera.
  throw new ApiError(
    503,
    "PHOTO_NOT_SETTLED",
    "Confirmation encore en cours (statut " + photo.status + ").",
  );
}

let flushing = false;
let flushAgain = false;

/**
 * Vide la queue, une photo après l'autre.
 *
 * Séquentiel et non parallèle : sur le Wi-Fi saturé d'une salle des fêtes,
 * trois envois simultanés se gênent plus qu'ils ne s'aident, et l'ordre
 * chronologique des photos est préservé.
 */
export async function flushQueue(
  eventId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (flushing) {
    // Un second déclencheur pendant un passage (retour du réseau au milieu
    // d'un envoi) ne se perd pas : il relance un passage à la fin.
    flushAgain = true;
    return;
  }

  flushing = true;
  useSyncStore.setState({ syncing: true });

  try {
    do {
      flushAgain = false;

      const queue = await listQueuedPhotos(eventId);
      const now = Date.now();

      for (const item of queue) {
        if (item.stage === "FAILED") continue;
        if (!options.force && item.nextAttemptAt > now) continue;
        // Inutile d'essayer : le navigateur sait déjà qu'il n'y a pas de
        // réseau. L'appel échouerait de toute façon, avec une erreur en
        // console par photo.
        if (!navigator.onLine) break;

        try {
          await processItem(item);
          useSyncStore.setState({ lastError: null });
        } catch (error) {
          const disposition = classify(error);

          // Relecture plutôt que réutilisation de `item` : entre-temps
          // `processItem` a pu enregistrer que le fichier était arrivé sur le
          // stockage. Repartir de la version d'avant l'appel effacerait cette
          // progression, et la reprise renverrait inutilement toute la photo.
          const latest = await getQueuedPhoto(item.localId);
          const attempts = (latest ?? item).attempts + 1;

          // Absente : elle s'est réglée entre-temps (verdict du serveur). Il
          // n'y a rien à réécrire — surtout pas à la ressusciter.
          if (latest) {
            await saveQueuedPhoto({
              ...latest,
              // `restart` : le fichier n'est pas sur le stockage (URL signée
              // expirée en plein envoi, purge) — on repart d'une nouvelle
              // autorisation plutôt que de confirmer dans le vide.
              ...(disposition.kind === "restart"
                ? { stage: "TO_UPLOAD" as const, photoId: undefined }
                : {}),
              ...(disposition.kind === "permanent"
                ? { stage: "FAILED" as const }
                : {}),
              attempts,
              nextAttemptAt:
                Date.now() +
                (disposition.kind === "retry" && disposition.retryAfterMs
                  ? disposition.retryAfterMs
                  : backoffMs(attempts)),
              lastError: disposition.message,
            });
          }

          useSyncStore.setState({ lastError: disposition.message });

          if (disposition.kind === "retry") {
            // Ce qui bloque cette photo bloquera la suivante (réseau coupé,
            // quota d'appels atteint) : inutile d'insister sur toute la queue.
            break;
          }
        }

        await refreshCounters(item.eventId);
      }
    } while (flushAgain);
  } catch (error) {
    // La queue elle-même est inaccessible (IndexedDB refusé en navigation
    // privée, quota de stockage plein). Rien à réessayer ici, mais l'écran
    // d'attente doit pouvoir le dire au lieu d'afficher un compteur figé.
    useSyncStore.setState({
      lastError:
        error instanceof Error
          ? error.message
          : "La file d'attente locale est inaccessible.",
    });
  } finally {
    flushing = false;
    useSyncStore.setState({ syncing: false });
    await refreshCounters(eventId).catch(() => undefined);
  }
}

/** Recalcule les compteurs affichés à partir de la queue et de la session. */
export async function refreshCounters(eventId: string): Promise<void> {
  const queue = await listQueuedPhotos(eventId);
  const session = loadSession(eventId);

  useSyncStore.setState({
    sealed: session?.sealedCount ?? 0,
    pending: queue.filter((item) => item.stage !== "FAILED").length,
    failed: queue.filter((item) => item.stage === "FAILED").length,
  });
}

/**
 * Met une photo en attente puis tente immédiatement de l'envoyer. Rend la main
 * dès que la copie locale est écrite : l'invité voit son animation « Souvenir
 * scellé » sans attendre un réseau qui peut ne pas exister.
 */
export async function sealPhoto(
  eventId: string,
  blob: Blob,
  capturedAt: Date,
): Promise<void> {
  await enqueuePhoto({
    eventId,
    blob,
    capturedAt: capturedAt.toISOString(),
  });
  await refreshCounters(eventId);
  void flushQueue(eventId, { force: true });
}

/**
 * Installe les reprises automatiques et renvoie de quoi les retirer.
 *
 * Le retour au premier plan est le déclencheur principal — c'est lui qui
 * remplace la Background Sync absente sur iOS.
 */
export function startSync(eventId: string): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void flushQueue(eventId, { force: true });
    }
  };
  const onOnline = () => {
    useSyncStore.setState({ online: true });
    void flushQueue(eventId, { force: true });
  };
  const onOffline = () => useSyncStore.setState({ online: false });
  // Retour depuis le bfcache (bouton Précédent, réveil d'un onglet sur iOS) :
  // `visibilitychange` ne se déclenche pas toujours dans ce cas.
  const onPageShow = () => void flushQueue(eventId, { force: true });

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pageshow", onPageShow);

  // Filet de sécurité : certains navigateurs mobiles ne déclenchent pas
  // `online` de façon fiable quand le Wi-Fi revient. Sans photo en attente, ce
  // passage ne fait qu'une lecture IndexedDB.
  const timer = window.setInterval(() => void flushQueue(eventId), 60_000);

  void refreshCounters(eventId).catch(() => undefined);
  void flushQueue(eventId, { force: true });

  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pageshow", onPageShow);
    window.clearInterval(timer);
  };
}
