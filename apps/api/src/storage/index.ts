import type { Env } from "../env.js";
import { ScalewayObjectStorage } from "./scaleway-s3.js";
import type { ObjectStorage } from "./types.js";

export * from "./types.js";
export * from "./keys.js";
export { ScalewayObjectStorage } from "./scaleway-s3.js";

/** Construit l'implémentation de stockage à partir de la configuration validée. */
export function createObjectStorage(env: Env): ObjectStorage {
  return new ScalewayObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}
