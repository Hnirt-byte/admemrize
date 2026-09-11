import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { Database } from "./db/client.js";
import type { Env } from "./env.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerGuestRoutes } from "./routes/guest.js";
import type { AppInstance } from "./types.js";

export interface BuildAppOptions {
  db: Database;
  env: Env;
  /** Désactivable pour que les tests ne se heurtent pas au quota anti-force brute. */
  enableRateLimit?: boolean;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { db, env } = options;

  const app = Fastify({
    logger: options.logger ?? env.NODE_ENV !== "test",
    // Empêche un corps de requête démesuré d'atteindre la logique métier.
    bodyLimit: 1024 * 1024,
    // Sans ça, toutes les requêtes arrivent avec l'IP de Traefik et partagent le
    // même quota de rate limit. On ne fait confiance à X-Forwarded-For que pour
    // les sauts d'adresses privées (le réseau Docker par lequel Traefik nous
    // joint) : une entrée forgée depuis une IP publique n'est jamais retenue.
    trustProxy: "loopback, uniquelocal",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cors, {
    origin: env.APP_DOMAIN,
    credentials: true,
  });

  if (options.enableRateLimit ?? true) {
    // Quota global de sécurité ; chaque route sensible resserre le sien via
    // `config.rateLimit` (inscription, connexion, jonction invité).
    // Volontairement large : lors d'un mariage, tous les invités passent par le
    // même Wi-Fi, donc par une seule IP publique. Un quota serré punirait une
    // salle entière pour le comportement d'un seul appareil.
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: "1 minute",
    });
  }

  const deps = { db, env };

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok"), appName: z.string() }),
        },
      },
    },
    async () => ({ status: "ok" as const, appName: env.APP_NAME })
  );

  registerAuthRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerGuestRoutes(app, deps);

  return app;
}
