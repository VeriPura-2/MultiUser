import Fastify, { type FastifyInstance } from "fastify";
import { webhookRoutes, type WebhookRouteOptions } from "./webhooks.js";

export interface AppOptions {
  logger?: boolean;
  webhook?: WebhookRouteOptions;
}

/** Builds the HTTP app without listening, so tests can drive it with app.inject(). */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({ ok: true }));
  app.register(webhookRoutes, options.webhook ?? {});

  return app;
}
