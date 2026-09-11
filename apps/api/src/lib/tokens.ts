import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "../env.js";
import { unauthorized } from "./errors.js";

/**
 * Trois familles de jetons, volontairement non interchangeables.
 *
 * Séparation à trois niveaux, chacun suffisant à lui seul :
 *   1. un secret de signature différent par famille  -> la signature d'un jeton
 *      invité ne peut pas être validée avec le secret organisateur ;
 *   2. une audience JWT différente ("aud")           -> rejet par jose ;
 *   3. un claim "tkn" explicite vérifié à la main    -> rejet applicatif.
 *
 * Conséquence recherchée (section 35) : un jeton invité présenté sur une route
 * organisateur échoue à l'étape 1, avant même d'atteindre la moindre logique
 * métier. Il n'existe aucun chemin de code où un jeton invité produit un
 * contexte organisateur.
 */
export const TOKEN_ISSUER = "admemrize";
export const ORGANIZER_AUDIENCE = "admemrize:organizer";
export const GUEST_AUDIENCE = "admemrize:guest";

const ALGORITHM = "HS256";
// Tolérance d'horloge : suffisante pour un décalage NTP, trop courte pour
// rattraper un jeton réellement expiré.
const CLOCK_TOLERANCE_SECONDS = 5;

export type TokenKind =
  | "organizer_access"
  | "organizer_refresh"
  | "guest_session";

export interface OrganizerAccessClaims {
  userId: string;
  plan: string;
}

export interface OrganizerRefreshClaims {
  userId: string;
}

export interface GuestSessionClaims {
  guestSessionId: string;
  eventId: string;
  deviceId: string;
}

const encoder = new TextEncoder();

function secretKey(secret: string): Uint8Array {
  return encoder.encode(secret);
}

function secretFor(env: Env, kind: TokenKind): Uint8Array {
  switch (kind) {
    case "organizer_access":
      return secretKey(env.JWT_ACCESS_SECRET);
    case "organizer_refresh":
      return secretKey(env.JWT_REFRESH_SECRET);
    case "guest_session":
      return secretKey(env.JWT_GUEST_SECRET);
  }
}

function audienceFor(kind: TokenKind): string {
  return kind === "guest_session" ? GUEST_AUDIENCE : ORGANIZER_AUDIENCE;
}

async function sign(
  env: Env,
  kind: TokenKind,
  subject: string,
  claims: JWTPayload,
  expiration: number | Date
): Promise<string> {
  return new SignJWT({ ...claims, tkn: kind })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    // Identifiant unique par émission : sans lui, deux jetons signés dans la même
    // seconde avec les mêmes claims seraient identiques au caractère près — et la
    // rotation d'une session invité ne révoquerait donc pas l'ancien jeton, dont
    // l'empreinte en base serait la même.
    .setJti(randomUUID())
    .setIssuer(TOKEN_ISSUER)
    .setAudience(audienceFor(kind))
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(secretFor(env, kind));
}

async function verifyOfKind(
  env: Env,
  kind: TokenKind,
  token: string
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, secretFor(env, kind), {
      issuer: TOKEN_ISSUER,
      audience: audienceFor(kind),
      algorithms: [ALGORITHM],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch {
    // Signature invalide, jeton expiré, audience étrangère, jeton tronqué :
    // tout donne le même 401, sans indiquer laquelle des causes s'applique.
    throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
  }

  if (payload.tkn !== kind || typeof payload.sub !== "string") {
    throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
  }
  return payload;
}

// --- Organisateur ---------------------------------------------------------

export function signOrganizerAccessToken(
  env: Env,
  input: OrganizerAccessClaims
): Promise<string> {
  return sign(
    env,
    "organizer_access",
    input.userId,
    { role: "organizer", plan: input.plan },
    Math.floor(Date.now() / 1000) + env.ACCESS_TOKEN_TTL_SECONDS
  );
}

export function signOrganizerRefreshToken(
  env: Env,
  input: OrganizerRefreshClaims
): Promise<string> {
  return sign(
    env,
    "organizer_refresh",
    input.userId,
    { role: "organizer" },
    Math.floor(Date.now() / 1000) + env.REFRESH_TOKEN_TTL_SECONDS
  );
}

export async function verifyOrganizerAccessToken(
  env: Env,
  token: string
): Promise<OrganizerAccessClaims> {
  const payload = await verifyOfKind(env, "organizer_access", token);
  return {
    userId: payload.sub as string,
    plan: typeof payload.plan === "string" ? payload.plan : "FREE",
  };
}

export async function verifyOrganizerRefreshToken(
  env: Env,
  token: string
): Promise<OrganizerRefreshClaims> {
  const payload = await verifyOfKind(env, "organizer_refresh", token);
  return { userId: payload.sub as string };
}

// --- Invité ---------------------------------------------------------------

/**
 * Le jeton invité expire exactement à la suppression de l'événement
 * (`event.deleteAt`) : aucun invité ne conserve un accès à des photos qui
 * n'existent plus.
 */
export function signGuestSessionToken(
  env: Env,
  input: GuestSessionClaims,
  expiresAt: Date
): Promise<string> {
  return sign(
    env,
    "guest_session",
    input.guestSessionId,
    { role: "guest", evt: input.eventId, did: input.deviceId },
    expiresAt
  );
}

export async function verifyGuestSessionToken(
  env: Env,
  token: string
): Promise<GuestSessionClaims> {
  const payload = await verifyOfKind(env, "guest_session", token);
  if (typeof payload.evt !== "string" || typeof payload.did !== "string") {
    throw unauthorized("Jeton invalide ou expiré.", "INVALID_TOKEN");
  }
  return {
    guestSessionId: payload.sub as string,
    eventId: payload.evt,
    deviceId: payload.did,
  };
}

// --- Empreinte de jeton ---------------------------------------------------

/**
 * Empreinte stockée en base pour les sessions invité : le jeton en clair ne doit
 * jamais exister ailleurs que dans le navigateur de l'invité (schema.ts,
 * commentaire `tokenHash`). Un SHA-256 suffit ici — contrairement à un mot de
 * passe, le jeton est une valeur aléatoire de haute entropie, il n'y a rien à
 * ralentir contre une attaque par dictionnaire.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashMatches(token: string, storedHash: string): boolean {
  const computed = Buffer.from(hashToken(token), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}
