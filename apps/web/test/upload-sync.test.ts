import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Compteur de souvenirs scellés, tenu par la session invité en temps normal
 * (lib/guest-session.ts, qui s'appuie sur localStorage). `vi.hoisted` le rend
 * accessible aux fabriques de mocks, qui sont remontées en haut du fichier.
 */
const sessionState = vi.hoisted(() => ({ sealed: 0 }));

// Seules les fonctions réseau sont remplacées : `ApiError` et `NetworkError`
// restent les vraies classes, puisque c'est sur elles que le moteur décide de
// réessayer ou non.
vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...actual,
    authorizeUpload: vi.fn(),
    uploadToStorage: vi.fn(),
    confirmPhoto: vi.fn(),
  };
});

vi.mock("../src/lib/guest-session", () => ({
  withGuestToken: <T,>(_eventId: string, call: (token: string) => Promise<T>) =>
    call("jeton-invite-de-test"),
  countSealed: () => (sessionState.sealed += 1),
  loadSession: () => ({ sealedCount: sessionState.sealed }),
}));

import {
  ApiError,
  NetworkError,
  authorizeUpload,
  confirmPhoto,
  uploadToStorage,
} from "../src/lib/api";
import {
  enqueuePhoto,
  listQueuedPhotos,
  type QueuedPhoto,
} from "../src/lib/offline-queue";
import {
  flushQueue,
  refreshCounters,
  useSyncStore,
} from "../src/lib/upload-sync";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PHOTO_ID = "22222222-2222-4222-8222-222222222222";

/** Réponse d'`/uploads/authorize` (Phase 3), toujours la même ici. */
function authorization() {
  return {
    photoId: PHOTO_ID,
    uploadUrl: "https://stockage.test/objet",
    method: "PUT" as const,
    key: `events/${EVENT_ID}/originals/${PHOTO_ID}.jpg`,
    contentType: "image/jpeg" as const,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

/** Réponse de `/photos/confirm` (Phase 4) dans l'état demandé. */
function confirmation(status: "READY" | "FAILED") {
  return {
    id: PHOTO_ID,
    eventId: EVENT_ID,
    status,
    capturedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    thumbnailKey: status === "READY" ? `events/${EVENT_ID}/thumbnails/x.jpg` : null,
    previewKey: status === "READY" ? `events/${EVENT_ID}/previews/x.jpg` : null,
  };
}

async function enqueueOnePhoto(): Promise<QueuedPhoto> {
  const item = await enqueuePhoto({
    eventId: EVENT_ID,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    capturedAt: new Date().toISOString(),
  });
  await refreshCounters(EVENT_ID);
  return item;
}

beforeEach(async () => {
  // La queue survit d'un test à l'autre (même IndexedDB) : on la vide.
  for (const item of await listQueuedPhotos(EVENT_ID)) {
    const { dropQueuedPhoto } = await import("../src/lib/offline-queue");
    await dropQueuedPhoto(item.localId);
  }

  sessionState.sealed = 0;
  useSyncStore.setState({
    sealed: 0,
    pending: 0,
    failed: 0,
    syncing: false,
    online: true,
    lastError: null,
  });

  vi.mocked(authorizeUpload).mockReset().mockResolvedValue(authorization());
  vi.mocked(uploadToStorage).mockReset().mockResolvedValue(undefined);
  vi.mocked(confirmPhoto).mockReset();
});

describe("Photo refusée par le serveur (/photos/confirm → FAILED)", () => {
  it("quitte la queue et le compteur après une seule tentative, sans jamais être réessayée", async () => {
    vi.mocked(confirmPhoto).mockResolvedValue(confirmation("FAILED"));

    await enqueueOnePhoto();
    expect(useSyncStore.getState().pending).toBe(1);

    await flushQueue(EVENT_ID, { force: true });

    // La copie locale est supprimée : rien ne doit rester à occuper le
    // stockage du téléphone pour une photo que le serveur ne prendra jamais.
    expect(await listQueuedPhotos(EVENT_ID)).toHaveLength(0);

    const state = useSyncStore.getState();
    expect(state.pending).toBe(0);
    // Ni comptée comme scellée (elle n'existe pas côté serveur)...
    expect(state.sealed).toBe(0);
    // ...ni rangée parmi les refus en attente d'une action.
    expect(state.failed).toBe(0);
    // ...et rien à en dire à l'invité.
    expect(state.lastError).toBeNull();

    expect(confirmPhoto).toHaveBeenCalledTimes(1);

    // Deuxième passage, forcé comme après un retour au premier plan : il n'y a
    // plus rien à envoyer, donc aucun nouvel appel.
    await flushQueue(EVENT_ID, { force: true });
    expect(confirmPhoto).toHaveBeenCalledTimes(1);
    expect(authorizeUpload).toHaveBeenCalledTimes(1);
    expect(uploadToStorage).toHaveBeenCalledTimes(1);
  });

  it("laisse intactes les photos acceptées, qui elles comptent comme scellées", async () => {
    vi.mocked(confirmPhoto).mockResolvedValue(confirmation("READY"));

    await enqueueOnePhoto();
    await flushQueue(EVENT_ID, { force: true });

    expect(await listQueuedPhotos(EVENT_ID)).toHaveLength(0);
    expect(useSyncStore.getState().sealed).toBe(1);
    expect(useSyncStore.getState().pending).toBe(0);
  });
});

describe("Échecs temporaires", () => {
  it("garde la photo en file et la réessaie au passage suivant", async () => {
    vi.mocked(confirmPhoto)
      .mockRejectedValueOnce(new NetworkError("Réseau indisponible."))
      .mockResolvedValue(confirmation("READY"));

    await enqueueOnePhoto();
    await flushQueue(EVENT_ID, { force: true });

    // Toujours là, et toujours comptée : du point de vue de l'invité, la photo
    // est scellée dès la capture.
    const [enAttente] = await listQueuedPhotos(EVENT_ID);
    expect(enAttente).toBeDefined();
    expect(enAttente!.stage).toBe("UPLOADED");
    expect(enAttente!.attempts).toBe(1);
    expect(useSyncStore.getState().pending).toBe(1);
    expect(useSyncStore.getState().sealed).toBe(0);

    await flushQueue(EVENT_ID, { force: true });

    expect(await listQueuedPhotos(EVENT_ID)).toHaveLength(0);
    expect(useSyncStore.getState().sealed).toBe(1);
    // L'envoi vers le stockage n'a pas été refait : seule la confirmation,
    // idempotente, a été rejouée.
    expect(uploadToStorage).toHaveBeenCalledTimes(1);
    expect(confirmPhoto).toHaveBeenCalledTimes(2);
  });
});

describe("Refus définitif qui ne met pas en cause le fichier", () => {
  it("cesse de réessayer mais conserve la copie locale", async () => {
    vi.mocked(authorizeUpload).mockRejectedValue(
      new ApiError(
        409,
        "SESSION_QUOTA_EXCEEDED",
        "Quota de 500 photos atteint pour cette session."
      )
    );

    await enqueueOnePhoto();
    await flushQueue(EVENT_ID, { force: true });

    // La photo est bonne — c'est l'événement qui n'en veut plus. La jeter
    // serait perdre un souvenir valable.
    const [bloquee] = await listQueuedPhotos(EVENT_ID);
    expect(bloquee!.stage).toBe("FAILED");
    expect(useSyncStore.getState().failed).toBe(1);
    expect(useSyncStore.getState().pending).toBe(0);

    await flushQueue(EVENT_ID, { force: true });
    expect(authorizeUpload).toHaveBeenCalledTimes(1);
  });
});
