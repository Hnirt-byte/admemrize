import {
  ACCEPTED_PHOTO_FORMATS,
  ConfirmPhotoInput,
  EventPhotosResponse,
  ListPhotosQuery,
  MAX_UPLOAD_SIZE_BYTES,
  PhotoDownloadResponse,
  PhotoDTO,
  type AcceptedPhotoFormat,
} from "@admemrize/shared";
import { and, asc, count, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { events, photos } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { resolveOrganizerGuestSessionId } from "../lib/organizer-guest-session.js";
import {
  requireOrganizerOrGuest,
  type AuthDeps,
  type GuestContext,
  type OrganizerContext,
} from "../plugins/auth.js";
import { requireRevealedEvent, serverNow } from "../services/reveal.js";
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
type EventRow = typeof events.$inferSelect;

const EventParams = z.object({ eventId: z.uuid() });
const PhotoParams = z.object({ photoId: z.uuid() });

/**
 * Charge un événement pour un lecteur (organisateur *ou* invité), sans encore
 * rien dire de la révélation — c'est `requireRevealedEvent` qui s'en charge
 * juste après, dans chaque route.
 *
 * Même principe que partout ailleurs (routes/events.ts, routes/uploads.ts) :
 * le droit d'accès fait partie de la clause WHERE. Un organisateur ne voit que
 * ses événements, un invité que celui de son jeton — tout le reste est un 404
 * indifférencié, qui ne confirme jamais l'existence de l'événement d'un tiers.
 */
async function findReadableEvent(
  db: Database,
  reader: { organizer?: OrganizerContext; guest?: GuestContext },
  eventId: string
): Promise<EventRow | null> {
  // Un jeton invité est cantonné à un seul événement : il ne suffit pas qu'il
  // soit valide, il doit être celui de *cet* événement.
  if (reader.guest && reader.guest.eventId !== eventId) {
    return null;
  }

  const condition = reader.organizer
    ? and(eq(events.id, eventId), eq(events.ownerId, reader.organizer.userId))
    : eq(events.id, eventId);

  const [event] = await db.select().from(events).where(condition).limit(1);

  return event ?? null;
}

/** Variante qui échoue en 404 — celle qu'utilisent les routes portées par un eventId. */
async function loadReadableEvent(
  db: Database,
  reader: { organizer?: OrganizerContext; guest?: GuestContext },
  eventId: string
): Promise<EventRow> {
  const event = await findReadableEvent(db, reader, eventId);

  if (!event) {
    throw notFound("Événement introuvable.", "EVENT_NOT_FOUND");
  }
  return event;
}

/**
 * Nom de fichier proposé au téléchargement : reconnaissable par l'invité dans
 * son dossier de téléchargements, et réduit à `[a-z0-9-]` pour ne pas pouvoir
 * injecter quoi que ce soit dans l'en-tête Content-Disposition signé.
 */
function downloadFilename(event: EventRow, photo: PhotoRow): string {
  const slug =
    event.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "evenement";

  const stamp = photo.capturedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");

  return `${slug}-${stamp}-${photo.id.slice(0, 8)}.jpg`;
}

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

  /**
   * Liste les photos d'un événement **révélé** — nouvel endpoint de la Phase 5,
   * c'est lui que consommera la galerie (Phase 9).
   *
   * Premier des deux endpoints qui donnent réellement accès à une photo : rien
   * n'en sort avant que `requireRevealedEvent` n'ait laissé passer, ni
   * métadonnée, ni URL signée, ni même le nombre de photos. Y compris pour
   * l'organisateur : il a le droit de déclencher la révélation, pas celui de
   * regarder avant tout le monde (section 21).
   */
  app.get(
    "/api/v1/events/:eventId/photos",
    {
      preHandler: requireOrganizerOrGuest(deps),
      schema: {
        params: EventParams,
        querystring: ListPhotosQuery,
        response: { 200: EventPhotosResponse },
      },
    },
    async (request) => {
      const now = serverNow();
      const event = await requireRevealedEvent(
        deps.db,
        await loadReadableEvent(deps.db, request, request.params.eventId),
        now
      );

      const { limit, offset } = request.query;

      // Seules les photos READY existent en tant qu'image : une PENDING n'a pas
      // encore été confirmée, une FAILED n'a pas passé la validation (Phase 4),
      // une DELETED n'a plus de fichier derrière elle.
      const readyPhotos = and(
        eq(photos.eventId, event.id),
        eq(photos.status, "READY")
      );

      const [{ value: total }] = await deps.db
        .select({ value: count() })
        .from(photos)
        .where(readyPhotos);

      const rows = await deps.db
        .select()
        .from(photos)
        .where(readyPhotos)
        // Ordre chronologique de prise de vue : la galerie raconte la soirée
        // dans l'ordre où elle s'est passée. `id` départage deux photos prises
        // dans la même milliseconde, pour que la pagination reste stable.
        .orderBy(asc(photos.capturedAt), asc(photos.id))
        .limit(limit)
        .offset(offset);

      // Le bucket est privé : ces URL signées sont le seul chemin vers un
      // fichier, et elles n'existent que de l'autre côté du gate. Les calculer
      // ne coûte aucun appel réseau (signature locale, storage/scaleway-s3.ts).
      const signed = await Promise.all(
        rows.map(async (photo) => {
          const [thumbnail, preview] = await Promise.all([
            deps.storage.getDownloadUrl({
              key: photo.thumbnailKey!,
              expiresInSeconds: deps.env.DOWNLOAD_URL_TTL_SECONDS,
            }),
            deps.storage.getDownloadUrl({
              key: photo.previewKey!,
              expiresInSeconds: deps.env.DOWNLOAD_URL_TTL_SECONDS,
            }),
          ]);

          return {
            ...toPhotoDTO(photo),
            thumbnailUrl: thumbnail.url,
            previewUrl: preview.url,
            expiresAt: Math.min(
              thumbnail.expiresAt.getTime(),
              preview.expiresAt.getTime()
            ),
          };
        })
      );

      // La plus proche des expirations réelles, pas une estimation : le client
      // sait exactement quand re-lister pour ne pas afficher d'image morte.
      const urlsExpireAt = signed.reduce(
        (earliest, photo) => Math.min(earliest, photo.expiresAt),
        now.getTime() + deps.env.DOWNLOAD_URL_TTL_SECONDS * 1000
      );

      return {
        event: {
          id: event.id,
          name: event.name,
          type: event.type,
          status: event.status,
          revealAt: event.revealAt.toISOString(),
        },
        photos: signed.map(({ expiresAt: _expiresAt, ...photo }) => photo),
        total,
        limit,
        offset,
        urlsExpireAt: new Date(urlsExpireAt).toISOString(),
        serverTime: now.toISOString(),
      };
    }
  );

  /**
   * URL de téléchargement d'une photo — second endpoint d'accès de la Phase 5,
   * même gate que la liste.
   *
   * Toujours l'aperçu nettoyé, jamais l'original : celui-ci porte encore son
   * EXIF, donc potentiellement les coordonnées GPS de l'invité qui a pris la
   * photo, et ne doit jamais quitter le serveur (section 15, et
   * architecture-v1-addendum.md section 1, ligne "Téléchargements").
   */
  app.get(
    "/api/v1/photos/:photoId/download",
    {
      preHandler: requireOrganizerOrGuest(deps),
      schema: {
        params: PhotoParams,
        response: { 200: PhotoDownloadResponse },
      },
    },
    async (request) => {
      const now = serverNow();

      const [photo] = await deps.db
        .select()
        .from(photos)
        .where(eq(photos.id, request.params.photoId))
        .limit(1);

      if (!photo) {
        throw notFound("Photo introuvable.", "PHOTO_NOT_FOUND");
      }

      // Le jeton présenté doit appartenir à l'événement *de cette photo* : un
      // invité de l'événement A ne télécharge rien de l'événement B, un
      // organisateur rien de l'événement d'un confrère. La vérification passe
      // par la clause de droit d'accès du rôle appelant, et vient avant le
      // gate de révélation comme avant le contrôle de disponibilité — aucun
      // des deux ne peut donc la masquer.
      //
      // Le refus est un 404 de photo, jamais un 403 : comme partout ailleurs
      // dans l'API, un identifiant auquel on n'a pas droit se comporte comme
      // un identifiant qui n'existe pas, et ne confirme donc pas son
      // existence.
      const event = await findReadableEvent(deps.db, request, photo.eventId);

      if (!event) {
        throw notFound("Photo introuvable.", "PHOTO_NOT_FOUND");
      }

      const revealed = await requireRevealedEvent(deps.db, event, now);

      if (photo.status !== "READY" || !photo.previewKey) {
        throw notFound(
          "Cette photo n'est pas disponible au téléchargement.",
          "PHOTO_NOT_READY"
        );
      }

      const filename = downloadFilename(revealed, photo);

      const { url, expiresAt } = await deps.storage.getDownloadUrl({
        key: photo.previewKey,
        expiresInSeconds: deps.env.DOWNLOAD_URL_TTL_SECONDS,
        downloadFilename: filename,
      });

      return {
        photoId: photo.id,
        url,
        filename,
        expiresAt: expiresAt.toISOString(),
      };
    }
  );
}
