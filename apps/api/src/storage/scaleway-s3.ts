import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  DownloadUrlRequest,
  DownloadUrlResult,
  HeadObjectResult,
  ObjectStorage,
  UploadUrlRequest,
  UploadUrlResult,
} from "./types.js";

export interface ScalewayStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Implémentation concrète pour Scaleway Object Storage (région Paris), choisi
 * en remplacement de MinIO — voir architecture-v1-addendum.md section 1.
 * Scaleway expose une API S3 standard : `@aws-sdk/client-s3` fonctionne tel
 * quel en pointant `endpoint` vers `https://s3.fr-par.scw.cloud`.
 *
 * La génération d'URL signée (`getSignedUrl`) est un calcul cryptographique
 * local — aucun appel réseau n'est fait vers Scaleway pour émettre une URL, ce
 * qui rend `getUploadUrl`/`getDownloadUrl` testables hors ligne avec des
 * identifiants fictifs. Seul `deleteObject` effectue un vrai appel réseau.
 */
export class ScalewayObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ScalewayStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async getUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResult> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
      ContentType: request.contentType,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: request.expiresInSeconds,
    });

    return {
      url,
      method: "PUT",
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000),
    };
  }

  async getDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrlResult> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: request.key,
      ...(request.downloadFilename
        ? {
            ResponseContentDisposition: `attachment; filename="${request.downloadFilename}"`,
          }
        : {}),
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: request.expiresInSeconds,
    });

    return {
      url,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000),
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  /**
   * Vérifie la taille réelle de l'objet sans le télécharger (dette technique
   * documentée en Phase 3, à corriger ici — addendum section 10, point 7) :
   * une URL PUT signée n'impose pas elle-même la taille annoncée à
   * /uploads/authorize, rien n'empêche d'envoyer un fichier plus gros
   * directement à Scaleway, hors du contrôle de l'API.
   */
  async headObject(key: string): Promise<HeadObjectResult | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const bytes = await result.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  const statusCode =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
      : undefined;
  return name === "NotFound" || name === "NoSuchKey" || statusCode === 404;
}
