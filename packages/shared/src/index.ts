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

// --- Création d'un événement (payload organisateur) ---
export const CreateEventInput = z.object({
  name: z.string().min(1).max(120),
  type: EventType,
  eventDate: z.string().datetime(),
  revealAt: z.string().datetime(),
  retentionHours: z.union([
    z.literal(24),
    z.literal(48),
    z.literal(72),
    z.literal(168), // 7 jours
  ]),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

// --- Identité invité (étape 3 du flux invité) ---
export const GuestJoinInput = z.object({
  nickname: z.string().min(1).max(40),
});
export type GuestJoinInput = z.infer<typeof GuestJoinInput>;
