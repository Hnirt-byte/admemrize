import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";

export const eventStatusEnum = pgEnum("event_status", [
  "ACTIVE_LOCKED",
  "REVEALED",
  "EXPIRED",
]);

export const photoStatusEnum = pgEnum("photo_status", [
  "PENDING",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETED",
]);

export const planEnum = pgEnum("plan", ["FREE", "PREMIUM"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  plan: planEnum("plan").notNull().default("FREE"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  eventDate: timestamp("event_date", { withTimezone: true }).notNull(),
  revealAt: timestamp("reveal_at", { withTimezone: true }).notNull(),
  deleteAt: timestamp("delete_at", { withTimezone: true }).notNull(),
  status: eventStatusEnum("status").notNull().default("ACTIVE_LOCKED"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// tokenHash: on ne stocke jamais le token brut, seulement son hash (section 16 sécurité)
export const guestSessions = pgTable("guest_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id),
  nickname: text("nickname").notNull(),
  deviceId: text("device_id").notNull(), // identifiant client persistant (localStorage), pas un ID matériel
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // = event.deleteAt
});

export const photos = pgTable("photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id),
  guestSessionId: uuid("guest_session_id")
    .notNull()
    .references(() => guestSessions.id),
  originalKey: text("original_key").notNull(), // clé objet S3
  previewKey: text("preview_key"),
  thumbnailKey: text("thumbnail_key"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  status: photoStatusEnum("status").notNull().default("PENDING"),
});

export const favorites = pgTable("favorites", {
  id: uuid("id").primaryKey().defaultRandom(),
  photoId: uuid("photo_id")
    .notNull()
    .references(() => photos.id),
  guestSessionId: uuid("guest_session_id")
    .notNull()
    .references(() => guestSessions.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
