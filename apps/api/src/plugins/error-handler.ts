import type { FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { AppError } from "../lib/errors.js";

/** Lit statut, code et message d'une erreur Fastify sans supposer sa forme exacte. */
function describeError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  const candidate = error as {
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    statusCode:
      typeof candidate.statusCode === "number" ? candidate.statusCode : 500,
    code: typeof candidate.code === "string" ? candidate.code : "BAD_REQUEST",
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Requête invalide.",
  };
}

/**
 * Toutes les réponses en échec sortent sous la même forme :
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * Rien d'interne ne fuit : une erreur non prévue devient un 500 générique, le
 * détail reste dans les logs serveur.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: `Route inconnue : ${request.method} ${request.url}`,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }

    // Corps, paramètres ou query invalides au regard du schéma Zod de la route.
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Requête invalide.",
          details: error.validation.map((issue) => ({
            // instancePath vaut par exemple "/revealAt" ou "/eventId".
            path: issue.instancePath.replace(/^\//, "") || "(corps)",
            message: issue.message ?? "Valeur invalide.",
          })),
        },
      });
    }

    // Une réponse qui ne respecte pas son propre schéma est un bug serveur :
    // on le log, on ne l'explique pas au client.
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, route: `${request.method} ${request.url}` },
        "Réponse non conforme au schéma déclaré"
      );
      return reply.status(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Une erreur interne est survenue.",
        },
      });
    }

    // Erreurs portant déjà un statut client (429 du rate limit, 400 de parsing
    // JSON, 413 de payload trop gros...).
    const { statusCode, code, message } = describeError(error);
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code, message },
      });
    }

    request.log.error(
      { err: error, route: `${request.method} ${request.url}` },
      "Erreur non gérée"
    );
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Une erreur interne est survenue.",
      },
    });
  });
}
