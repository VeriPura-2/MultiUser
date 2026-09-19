import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, PermissionDeniedError, ValidationError, VeriPuraCoreError } from "../errors.js";
import { purchaseOrderRoutes, type PurchaseOrderRouteOptions } from "./purchaseOrders.js";
import { viewRoutes } from "./views.js";
import { webhookRoutes, type WebhookRouteOptions } from "./webhooks.js";

export interface AppOptions {
  logger?: boolean;
  webhook?: WebhookRouteOptions;
  /** Actor resolution for every route that needs one. Defaults to ALLOW_DEV_ACTOR_HEADER=true, otherwise off. */
  purchaseOrders?: PurchaseOrderRouteOptions;
}

/** Builds the HTTP app without listening, so tests can drive it with app.inject(). */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Set before the routes are registered so every encapsulated plugin inherits it.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PermissionDeniedError) return reply.code(403).send({ error: "forbidden", message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: "not_found", message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: "invalid_request", message: error.message });
    if (error instanceof VeriPuraCoreError) {
      return reply
        .code(502)
        .send({ error: "core_unavailable", message: error.message, consignmentId: error.consignmentId });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: "bad_request", message: (error as Error).message });
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ ok: true }));
  app.register(webhookRoutes, options.webhook ?? {});
  const actorOptions = { allowDevActorHeader: process.env.ALLOW_DEV_ACTOR_HEADER === "true", ...options.purchaseOrders };
  app.register(purchaseOrderRoutes, actorOptions);
  app.register(viewRoutes, actorOptions);

  return app;
}
