import {
  ApiErrorResponse,
  AuthorizeUploadResponse,
  GuestJoinResponse,
  PhotoDTO,
  UPLOAD_CONTENT_TYPE,
  type GuestJoinInput,
} from "@admemrize/shared";

/**
 * Base de l'API.
 *
 * En production, la PWA et l'API partagent le même domaine — Traefik route
 * `/api` vers `admemrize-api` et le reste vers `admemrize-web`
 * (docker-compose.yml) : une base vide suffit et aucun CORS n'entre en jeu.
 * En dev, Vite sert la PWA sur :5173 pendant que l'API écoute sur :3000,
 * d'où la valeur par défaut — exactement l'origine croisée que `APP_DOMAIN`
 * autorise côté API (apps/api/src/app.ts).
 *
 * `VITE_API_BASE_URL` reste là pour les cas hybrides (PWA en local pointée
 * vers l'API du VPS, test depuis un téléphone sur le réseau local).
 */
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.DEV ? "http://localhost:3000" : "")
).replace(/\/+$/, "");

/** Une réponse d'erreur de l'API, avec le code métier de `plugins/error-handler.ts`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Aucune réponse n'est jamais arrivée : hors ligne, DNS, TLS, serveur
 * injoignable. Distinct d'`ApiError` parce que la conséquence est l'inverse :
 * ici il n'y a rien à corriger côté client, seulement à réessayer plus tard.
 */
export class NetworkError extends Error {
  constructor(message = "Le réseau est indisponible.") {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Décalage entre l'horloge du serveur et celle du navigateur, en
 * millisecondes (`serveur - client`), mis à jour à chaque réponse qui expose
 * son en-tête `Date`.
 *
 * L'horloge d'un téléphone peut être fausse de plusieurs minutes, ou avancée
 * exprès par un invité pressé. Le compte à rebours affiché s'appuie donc sur
 * cette correction — mais jamais l'accès aux photos, qui reste décidé par le
 * serveur seul (services/reveal.ts, section 21 du master prompt).
 *
 * Reste à 0 quand l'en-tête n'est pas lisible : `Date` ne fait pas partie des
 * en-têtes exposés par défaut en CORS, il n'est donc lu qu'en même origine
 * (la production) ou si l'API l'expose un jour explicitement. Le repli sur
 * l'horloge locale est sans gravité : il ne décale qu'un affichage.
 */
let serverClockOffsetMs = 0;

export function serverNow(): Date {
  return new Date(Date.now() + serverClockOffsetMs);
}

function rememberServerClock(response: Response): void {
  const header = response.headers.get("date");
  if (!header) return;
  const serverTime = Date.parse(header);
  if (Number.isNaN(serverTime)) return;
  serverClockOffsetMs = serverTime - Date.now();
}

interface RequestOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request(
  path: string,
  options: RequestOptions = {}
): Promise<unknown> {
  const { method = "GET", token, body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method,
      signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new NetworkError(
      error instanceof Error ? error.message : "Le réseau est indisponible."
    );
  }

  rememberServerClock(response);

  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = ApiErrorResponse.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details
      );
    }
    throw new ApiError(
      response.status,
      "UNEXPECTED_ERROR",
      `Réponse inattendue du serveur (HTTP ${response.status}).`
    );
  }

  return payload;
}

/**
 * Jonction d'un invité. Idempotente par `deviceId` (routes/guest.ts) : la
 * rappeler pour un appareil déjà connu ne crée pas de seconde session, elle
 * rafraîchit le jeton et renvoie l'état à jour de l'événement — c'est ce qui
 * permet à un invité de revenir sans repasser par la saisie du prénom.
 */
export async function joinEvent(
  eventId: string,
  input: GuestJoinInput
): Promise<GuestJoinResponse> {
  const payload = await request(`/events/${eventId}/guest/join`, {
    method: "POST",
    body: input,
  });
  return GuestJoinResponse.parse(payload);
}

/** Étape 1 de l'envoi (Phase 3) : obtenir une URL signée à durée courte. */
export async function authorizeUpload(
  token: string,
  sizeBytes: number
): Promise<AuthorizeUploadResponse> {
  const payload = await request("/uploads/authorize", {
    method: "POST",
    token,
    body: { sizeBytes },
  });
  return AuthorizeUploadResponse.parse(payload);
}

/**
 * Étape 2 : l'envoi lui-même, directement vers Scaleway. Le fichier ne passe
 * jamais par l'API (section 12 du master prompt).
 *
 * Le `Content-Type` doit être exactement celui qui a été signé, sinon
 * Scaleway rejette la signature.
 */
export async function uploadToStorage(
  uploadUrl: string,
  blob: Blob
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": UPLOAD_CONTENT_TYPE },
      body: blob,
    });
  } catch (error) {
    // Inclut le cas CORS : un bucket sans règle CORS autorisant PUT depuis
    // l'origine de la PWA échoue ici, sans statut lisible (voir README,
    // prérequis de la Phase 7).
    throw new NetworkError(
      error instanceof Error ? error.message : "Envoi impossible."
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      "STORAGE_UPLOAD_FAILED",
      `Le stockage a refusé l'envoi (HTTP ${response.status}).`
    );
  }
}

/**
 * Étape 3 (Phase 4) : confirmation. Le serveur valide le fichier par ses
 * magic bytes et génère les dérivés. Idempotente — un même `photoId` déjà
 * traité renvoie son résultat sans retraitement, ce dont dépend la reprise de
 * la queue offline.
 */
export async function confirmPhoto(
  token: string,
  input: { photoId: string; capturedAt: string }
): Promise<PhotoDTO> {
  const payload = await request("/photos/confirm", {
    method: "POST",
    token,
    body: input,
  });
  return PhotoDTO.parse(payload);
}
