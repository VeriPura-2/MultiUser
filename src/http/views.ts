import type { FastifyPluginAsync } from "fastify";
import {
  getActionQueue,
  getConsignmentChecklist,
  getConsignmentDetail,
  getPartyWorkload,
  listConsignments,
} from "../services/consignmentViews.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

/**
 * Read-only, role-scoped views. Every route needs an acting user; without one the answer is 401
 * (until real sign-in exists that means ALLOW_DEV_ACTOR_HEADER must be on, see actor.ts).
 * Errors map centrally in app.ts: 403 inactive user, 404 unknown or not-your consignment or org,
 * 400 for a superadmin who does not say whose workload to view.
 */
export const viewRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  const actorFor = (request: Parameters<typeof resolveActingUser>[0]) =>
    resolveActingUser(request, options.allowDevActorHeader ?? false);

  app.get("/consignments", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return { consignments: await listConsignments(actingUser) };
  });

  app.get<{ Querystring: { orgId?: string } }>("/parties/workload", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getPartyWorkload(actingUser, { orgId: request.query.orgId });
  });

  app.get<{ Querystring: { orgId?: string } }>("/action-queue", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getActionQueue(actingUser, { orgId: request.query.orgId });
  });

  app.get<{ Params: { consignmentId: string } }>("/consignments/:consignmentId", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getConsignmentDetail(request.params.consignmentId, actingUser);
  });

  app.get<{ Params: { consignmentId: string } }>("/consignments/:consignmentId/checklist", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getConsignmentChecklist(request.params.consignmentId, actingUser);
  });
};
