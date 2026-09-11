import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors, { origin: process.env.APP_DOMAIN ?? true });

// Route de santé : confirme que l'API, sa validation Zod et son typage tournent.
app.get(
  "/api/v1/health",
  {
    schema: {
      response: {
        200: z.object({
          status: z.literal("ok"),
          appName: z.string(),
        }),
      },
    },
  },
  async () => ({
    status: "ok" as const,
    appName: process.env.ADMEMRIZE ?? "ADMEMRIZE",
  })
);

const port = Number(process.env.API_PORT ?? 3000);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`API démarrée sur le port ${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
