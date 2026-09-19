import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, PermissionDeniedError, UnprocessableEntityError, ValidationError, VeriPuraCoreError } from "../errors.js";
import { adminRoutes } from "./admin.js";
import { assertDevModeSafe, devActorEnabled, type ActorOptions } from "./actor.js";
import { consignmentRoutes } from "./consignments.js";
import { issueRoutes } from "./issues.js";
import { meRoutes } from "./me.js";
import { createSampleRuntime, type TrackingRuntime } from "../tracking/runtime.js";
import { purchaseOrderRoutes } from "./purchaseOrders.js";
import { trackingRoutes } from "./tracking.js";
import { viewRoutes } from "./views.js";
import { webhookRoutes, type WebhookRouteOptions } from "./webhooks.js";

export interface AppOptions {
  logger?: boolean;
  webhook?: WebhookRouteOptions;
  /**
   * Actor resolution for every route that needs an acting user. Defaults to on when
   * AUTH_MODE=dev (or the deprecated ALLOW_DEV_ACTOR_HEADER=true), otherwise off.
   */
  actor?: ActorOptions;
  /** Deprecated alias for `actor`, kept so earlier callers and tests keep working. */
  purchaseOrders?: ActorOptions;
  /**
   * The position provider and its budget. Left out, the app uses sample positions whatever the
   * environment says, so an app built in a test can never reach a live provider by accident. The
   * server builds one from the environment on purpose (see src/server.ts).
   */
  tracking?: TrackingRuntime;
}

/**
 * Builds the HTTP app without listening, so tests can drive it with app.inject().
 * Throws, and so refuses to start, if the dev-only acting user is on under NODE_ENV=production.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const actorOptions: ActorOptions = {
    allowDevActorHeader: devActorEnabled(),
    ...options.purchaseOrders,
    ...options.actor,
  };
  assertDevModeSafe(actorOptions.allowDevActorHeader ?? false);

  const app = Fastify({ logger: options.logger ?? false });

  // Set before the routes are registered so every encapsulated plugin inherits it.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PermissionDeniedError) return reply.code(403).send({ error: "forbidden", message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: "not_found", message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: "invalid_request", message: error.message });
    if (error instanceof UnprocessableEntityError) return reply.code(422).send({ error: "unprocessable", message: error.message });
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
  app.register(purchaseOrderRoutes, actorOptions);
  app.register(viewRoutes, actorOptions);
  app.register(meRoutes, actorOptions);
  app.register(issueRoutes, actorOptions);
  app.register(adminRoutes, actorOptions);
  app.register(consignmentRoutes, actorOptions);
  app.register(trackingRoutes, { ...actorOptions, tracking: options.tracking ?? createSampleRuntime() });

  return app;
}
