export interface UploadUrlRequest {
  key: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface UploadUrlResult {
  url: string;
  method: "PUT";
  expiresAt: Date;
}

export interface DownloadUrlRequest {
  key: string;
  expiresInSeconds: number;
  /** Force le téléchargement sous ce nom plutôt que sous la clé S3 brute. */
  downloadFilename?: string;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: Date;
}

/**
 * Abstraction de stockage objet S3-compatible. Toute route ou service métier
 * dépend de cette interface, jamais directement du SDK AWS : remplacer
 * Scaleway par un autre fournisseur S3-compatible (ou revenir à du self-hosted
 * si MinIO redevient viable un jour, voir architecture-v1-addendum.md
 * section 1) ne touche alors qu'un seul fichier (scaleway-s3.ts).
 *
 * Le fichier ne transite jamais par l'API : `getUploadUrl` et `getDownloadUrl`
 * renvoient des URL signées à durée courte que le client utilise directement
 * contre le bucket (upload direct depuis le navigateur, téléchargement direct
 * vers le navigateur).
 */
export interface ObjectStorage {
  getUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResult>;
  getDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrlResult>;
  deleteObject(key: string): Promise<void>;
}
