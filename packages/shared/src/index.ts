import { z } from "zod";

// --- Statuts événement (section 6 du cahier des charges) ---
export const EventStatus = z.enum(["ACTIVE_LOCKED", "REVEALED", "EXPIRED"]);
export type EventStatus = z.infer<typeof EventStatus>;

// --- Statuts photo ---
export const PhotoStatus = z.enum([
  "PENDING",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETED",
]);
export type PhotoStatus = z.infer<typeof PhotoStatus>;

// --- Types d'événement ---
export const EventType = z.enum([
  "MARIAGE",
  "ANNIVERSAIRE",
  "ENTREPRISE",
  "FETE",
  "AUTRE",
]);
export type EventType = z.infer<typeof EventType>;

export const Plan = z.enum(["FREE", "PREMIUM"]);
export type Plan = z.infer<typeof Plan>;

// Durées de rétention proposées à l'organisateur, en heures.
export const RetentionHours = z.union([
  z.literal(24),
  z.literal(48),
  z.literal(72),
  z.literal(168), // 7 jours
]);
export type RetentionHours = z.infer<typeof RetentionHours>;

const IsoDateTime = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// Auth organisateur (Phase 2)
// ---------------------------------------------------------------------------

// 12 caractères minimum : le hachage Argon2id protège la base, pas l'utilisateur
// qui choisit "azerty". Le maximum évite qu'un mot de passe de 10 Mo ne devienne
// un déni de service sur la fonction de hachage.
export const Password = z.string().min(12).max(256);

export const RegisterInput = z.object({
  email: z.email().max(254),
  password: Password,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const RefreshInput = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshInput>;

export const OrganizerProfile = z.object({
  id: z.uuid(),
  email: z.email(),
  plan: Plan,
  createdAt: IsoDateTime,
});
export type OrganizerProfile = z.infer<typeof OrganizerProfile>;

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(), // durée de vie de l'access token, en secondes
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const AuthSession = z.object({
  organizer: OrganizerProfile,
  tokens: AuthTokens,
});
export type AuthSession = z.infer<typeof AuthSession>;

// ---------------------------------------------------------------------------
// Événements (Phase 2)
// ---------------------------------------------------------------------------

export const CreateEventInput = z.object({
  name: z.string().trim().min(1).max(120),
  type: EventType,
  eventDate: IsoDateTime,
  revealAt: IsoDateTime,
  retentionHours: RetentionHours,
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

// Mise à jour partielle : au moins un champ, sinon la requête ne veut rien dire.
export const UpdateEventInput = CreateEventInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Au moins un champ doit être fourni." }
);
export type UpdateEventInput = z.infer<typeof UpdateEventInput>;

export const EventDTO = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.string(),
  eventDate: IsoDateTime,
  revealAt: IsoDateTime,
  deleteAt: IsoDateTime,
  status: EventStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EventDTO = z.infer<typeof EventDTO>;

// ---------------------------------------------------------------------------
// Session invité (Phase 2)
// ---------------------------------------------------------------------------

// deviceId : identifiant persistant généré par le client (localStorage), pas un
// identifiant matériel. Il sert à retrouver la session d'un invité qui recharge
// la page, jamais à l'identifier personnellement (section 15, vie privée).
export const GuestJoinInput = z.object({
  nickname: z.string().trim().min(1).max(40),
  deviceId: z.string().min(8).max(128),
});
export type GuestJoinInput = z.infer<typeof GuestJoinInput>;

export const GuestSessionDTO = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  nickname: z.string(),
  expiresAt: IsoDateTime,
});
export type GuestSessionDTO = z.infer<typeof GuestSessionDTO>;

// Vue de l'événement accessible à un invité : volontairement plus pauvre que
// EventDTO (ni date de suppression, ni métadonnées d'organisation).
export const GuestEventView = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.string(),
  status: EventStatus,
  revealAt: IsoDateTime,
});
export type GuestEventView = z.infer<typeof GuestEventView>;

export const GuestJoinResponse = z.object({
  guestToken: z.string(),
  tokenType: z.literal("Bearer"),
  session: GuestSessionDTO,
  event: GuestEventView,
});
export type GuestJoinResponse = z.infer<typeof GuestJoinResponse>;

// ---------------------------------------------------------------------------
// Upload de photos (Phase 3)
// ---------------------------------------------------------------------------

// Capture toujours en JPEG côté client (canvas.toBlob), voir
// architecture-v1-addendum.md section 2 : jamais de HEIC ni d'autre format à
// gérer côté serveur.
export const UPLOAD_CONTENT_TYPE = "image/jpeg" as const;

// 15 Mo (section 12 du master prompt) : une photo JPEG issue d'un canvas web ne
// s'en approche pas en pratique, la marge absorbe les gros capteurs.
export const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024;

export const AuthorizeUploadInput = z.object({
  // Requis uniquement pour un appel organisateur : un jeton invité porte déjà
  // son eventId, un eventId fourni dans le corps est alors ignoré (voir
  // routes/uploads.ts).
  eventId: z.uuid().optional(),
  sizeBytes: z.number().int().positive(),
});
export type AuthorizeUploadInput = z.infer<typeof AuthorizeUploadInput>;

export const AuthorizeUploadResponse = z.object({
  photoId: z.uuid(),
  uploadUrl: z.string(),
  method: z.literal("PUT"),
  key: z.string(),
  contentType: z.literal(UPLOAD_CONTENT_TYPE),
  expiresAt: IsoDateTime,
});
export type AuthorizeUploadResponse = z.infer<typeof AuthorizeUploadResponse>;

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

// Toutes les erreurs de l'API partagent cette enveloppe : le client n'a jamais
// à deviner la forme d'une réponse en échec.
export const ApiErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;
