import {
  ACCEPTED_PHOTO_FORMATS,
  ConfirmPhotoInput,
  MAX_UPLOAD_SIZE_BYTES,
  PhotoDTO,
  type AcceptedPhotoFormat,
} from "@admemrize/shared";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { events, photos } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { resolveOrganizerGuestSessionId } from "../lib/organizer-guest-session.js";
import { requireOrganizerOrGuest, type AuthDeps } from "../plugins/auth.js";
import {
  originalKey,
  previewKey as previewKeyFor,
  thumbnailKey as thumbnailKeyFor,
} from "../storage/keys.js";
import type { ObjectStorage } from "../storage/types.js";
import type { AppInstance } from "../types.js";

export interface PhotoDeps extends AuthDeps {
  storage: ObjectStorage;
}

// Dimension max du côté le plus long, en pixels — l'aspect ratio est préservé
// (fit: "inside"), jamais d'agrandissement d'une photo déjà plus petite.
const THUMBNAIL_MAX_DIMENSION = 400;
const PREVIEW_MAX_DIMENSION = 1600;

// Les dérivés sortent toujours en JPEG, quel que soit le format d'origine
// (JPEG ou WebP) : cohérent avec la structure de clés déjà figée en ".jpg"
// (storage/keys.ts).
const DERIVATIVE_CONTENT_TYPE = "image/jpeg";

type PhotoRow = typeof photos.$inferSelect;

function toPhotoDTO(photo: PhotoRow) {
  return {
    id: photo.id,
    eventId: photo.eventId,
    status: photo.status,
    capturedAt: photo.capturedAt.toISOString(),
    createdAt: photo.createdAt.toISOString(),
    thumbnailKey: photo.thumbnailKey,
    previewKey: photo.previewKey,
  };
}

function isAcceptedFormat(
  format: string | undefined
): format is AcceptedPhotoFormat {
  return (ACCEPTED_PHOTO_FORMATS as readonly string[]).includes(format ?? "");
}

export function registerPhotoRoutes(app: AppInstance, deps: PhotoDeps): void {
  /**
   * Confirme un upload direct vers Scaleway effectué après /uploads/authorize
   * (Phase 3). Télécharge le fichier pour le valider réellement par ses magic
   * bytes (jamais par le Content-Type déclaré par le client — section 14 du
   * master prompt), génère thumbnail + preview via Sharp, les dépose sur
   * Scaleway, et fait passer `status` de PENDING à READY ou FAILED.
   *
   * Toujours un 200 avec le statut dans le corps pour un fichier réellement
   * uploadé (READY ou FAILED) : l'appel a réussi, c'est le contenu envoyé qui
   * est ou n'est pas valide. Seul un fichier jamais uploadé (rien à
   * télécharger) reste une vraie erreur HTTP (404).
   */
  app.post(
    "/api/v1/photos/confirm",
    {
      config: { rateLimit: { max: 120, timeWindow: "10 minutes" } },
      preHandler: requireOrganizerOrGuest(deps),
      schema: {
        body: ConfirmPhotoInput,
        response: { 200: PhotoDTO },
      },
    },
    async (request) => {
      const eventId = request.guest
        ? request.guest.eventId
        : request.body.eventId;

      if (!eventId) {
        throw badRequest(
          "eventId requis pour une confirmation organisateur.",
          { field: "eventId" }
        );
      }

      // Même principe que /uploads/authorize (routes/uploads.ts) : pour un
      // organisateur, la propriété fait partie de la clause WHERE, jamais
      // d'une vérification après coup.
      const eventCondition = request.organizer
        ? and(eq(events.id, eventId), eq(events.ownerId, request.organizer.userId))
        : eq(events.id, eventId);

      const [event] = await deps.db
        .select()
        .from(events)
        .where(eventCondition)
        .limit(1);

      if (!event) {
        throw notFound("Événement introuvable.", "EVENT_NOT_FOUND");
      }

      // Même gate que /uploads/authorize (routes/uploads.ts) : une
      // confirmation tardive reste acceptée après révélation, promesse
      // offline-first (addendum section 1, ligne "Photo uploadée après
      // revealAt") — un invité dont le téléphone se reconnecte juste après la
      // révélation doit pouvoir envoyer une photo prise avant, sans que le
      // réseau la fasse jamais disparaître. Seule l'expiration ferme
      // définitivement la porte.
      if (event.status === "EXPIRED") {
        throw conflict(
          "Cet événement est expiré, aucune nouvelle photo ne peut être confirmée.",
          "EVENT_EXPIRED"
        );
      }

      // Un organisateur qui confirme une photo prise pendant son propre
      // événement est traité comme un invité de son propre événement
      // (`photos.guest_session_id` reste NOT NULL) : auto-provisionné au
      // premier appel, réutilisé ensuite — voir lib/organizer-guest-session.ts.
      const guestSessionId = request.guest
        ? request.guest.guestSessionId
        : await resolveOrganizerGuestSessionId(
            deps.db,
            request.organizer!,
            event
          );

      const { photoId, capturedAt } = request.body;

      const [existing] = await deps.db
        .select()
        .from(photos)
        .where(and(eq(photos.id, photoId), eq(photos.eventId, eventId)))
        .limit(1);

      // Idempotent : un retry réseau du client sur une confirmation déjà
      // terminée renvoie le résultat existant sans re-télécharger ni
      // retraiter le fichier.
      if (existing && existing.status !== "PENDING") {
        return toPhotoDTO(existing);
      }

      const key = originalKey(eventId, photoId);

      const photoRow: PhotoRow =
        existing ??
        (
          await deps.db
            .insert(photos)
            .values({
              id: photoId,
              eventId,
              guestSessionId,
              originalKey: key,
              capturedAt: new Date(capturedAt),
              status: "PENDING",
            })
            .returning()
        )[0]!;

      async function fail(): Promise<ReturnType<typeof toPhotoDTO>> {
        const [updated] = await deps.db
          .update(photos)
          .set({ status: "FAILED" })
          .where(eq(photos.id, photoRow.id))
          .returning();
        return toPhotoDTO(updated!);
      }

      async function safeDelete(objectKey: string): Promise<void> {
        try {
          await deps.storage.deleteObject(objectKey);
        } catch (error) {
          request.log.warn(
            { err: error, key: objectKey },
            "Échec de suppression d'un objet invalide, ignoré"
          );
        }
      }

      const head = await deps.storage.headObject(key);
      if (!head) {
        throw notFound(
          "Aucun fichier original trouvé pour cette photo — uploadez-le d'abord vers l'URL signée.",
          "ORIGINAL_NOT_FOUND"
        );
      }

      // Taille réelle de l'objet stocké, pas celle annoncée à
      // /uploads/authorize (dette technique documentée en Phase 3, corrigée
      // ici — addendum section 10, point 7). Vérifiée avant même de
      // télécharger le contenu.
      if (head.contentLength > MAX_UPLOAD_SIZE_BYTES) {
        await safeDelete(key);
        return fail();
      }

      const original = await deps.storage.getObject(key);

      let format: string | undefined;
      try {
        format = (await sharp(original).metadata()).format;
      } catch {
        format = undefined;
      }

      // Seuls les magic bytes lus par Sharp/libvips font foi — jamais le
      // Content-Type déclaré par le client ni l'extension du fichier
      // (section 14 du master prompt).
      if (!isAcceptedFormat(format)) {
        await safeDelete(key);
        return fail();
      }

      let thumbnailBuffer: Buffer;
      let previewBuffer: Buffer;
      try {
        [thumbnailBuffer, previewBuffer] = await Promise.all([
          // .rotate() sans argument applique l'orientation EXIF puis Sharp ne
          // la réécrit pas (pas de .withMetadata()) : les dérivés sortent
          // sans EXIF, donc sans GPS (section 15, vie privée).
          sharp(original)
            .rotate()
            .resize({
              width: THUMBNAIL_MAX_DIMENSION,
              height: THUMBNAIL_MAX_DIMENSION,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 70 })
            .toBuffer(),
          sharp(original)
            .rotate()
            .resize({
              width: PREVIEW_MAX_DIMENSION,
              height: PREVIEW_MAX_DIMENSION,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 82 })
            .toBuffer(),
        ]);
      } catch {
        return fail();
      }

      const thumbKey = thumbnailKeyFor(eventId, photoId);
      const prevKey = previewKeyFor(eventId, photoId);

      await Promise.all([
        deps.storage.putObject(thumbKey, thumbnailBuffer, DERIVATIVE_CONTENT_TYPE),
        deps.storage.putObject(prevKey, previewBuffer, DERIVATIVE_CONTENT_TYPE),
      ]);

      const [ready] = await deps.db
        .update(photos)
        .set({ status: "READY", thumbnailKey: thumbKey, previewKey: prevKey })
        .where(eq(photos.id, photoRow.id))
        .returning();

      return toPhotoDTO(ready!);
    }
  );
}
