import { z } from "zod";

// Les trois secrets sont volontairement distincts et longs : c'est ce qui fait
// qu'un jeton invité ne peut pas être vérifié comme un jeton organisateur, même
// si un jour une vérification de claim était oubliée quelque part (défense en
// profondeur — voir lib/tokens.ts).
const SECRET_MIN_LENGTH = 32;

const Secret = z
  .string()
  .min(
    SECRET_MIN_LENGTH,
    `Le secret doit faire au moins ${SECRET_MIN_LENGTH} caractères (générer avec: openssl rand -base64 48).`
  );

export const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().min(1),

    JWT_ACCESS_SECRET: Secret,
    JWT_REFRESH_SECRET: Secret,
    JWT_GUEST_SECRET: Secret,

    // 15 min : court, parce qu'un access token n'est jamais révocable côté serveur.
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    // 30 jours : l'organisateur ne doit pas se reconnecter au milieu de son mariage.
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),

    APP_NAME: z.string().default("ADMEMRIZE"),
    APP_DOMAIN: z.string().default("http://localhost:5173"),
    API_PORT: z.coerce.number().int().positive().default(3000),

    // Stockage objet S3-compatible (Scaleway Object Storage, région Paris) —
    // voir architecture-v1-addendum.md section 1. Pas de défaut : un endpoint ou
    // des identifiants manquants doivent faire échouer le boot, pas produire une
    // API qui signe des URL vers un bucket "undefined".
    S3_ENDPOINT: z.string().min(1),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    // Durée de vie de l'URL signée d'upload : courte, puisqu'elle ne sert qu'à
    // l'envoi direct qui suit immédiatement /uploads/authorize (section 12).
    UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

    // Quotas anti-abus, configurables sans déploiement de code (section 12).
    SESSION_PHOTO_QUOTA: z.coerce.number().int().positive().default(500),
    EVENT_PHOTO_QUOTA: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((env, ctx) => {
    const secrets = [
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.JWT_GUEST_SECRET,
    ];
    if (new Set(secrets).size !== secrets.length) {
      ctx.addIssue({
        code: "custom",
        message:
          "JWT_ACCESS_SECRET, JWT_REFRESH_SECRET et JWT_GUEST_SECRET doivent être trois valeurs différentes.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Valide l'environnement au démarrage. Un secret manquant doit faire échouer le
 * boot bruyamment, pas produire une API qui signe des jetons avec "undefined".
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(global)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return parsed.data;
}
