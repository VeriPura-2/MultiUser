import type { FastifyPluginAsync } from "fastify";
import { getConsignmentChecklist, listConsignments } from "../services/consignmentViews.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

/**
 * Read-only, role-scoped views. Every route needs an acting user; without one the answer is 401
 * (until real sign-in exists that means ALLOW_DEV_ACTOR_HEADER must be on, see actor.ts).
 * Errors map centrally in app.ts: 403 inactive user, 404 unknown or not-your consignment.
 */
export const viewRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  const actorFor = (request: Parameters<typeof resolveActingUser>[0]) =>
    resolveActingUser(request, options.allowDevActorHeader ?? false);

  app.get("/consignments", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return { consignments: await listConsignments(actingUser) };
  });

  app.get<{ Params: { consignmentId: string } }>("/consignments/:consignmentId/checklist", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getConsignmentChecklist(request.params.consignmentId, actingUser);
  });
};
