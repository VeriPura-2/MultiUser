import type { FastifyPluginAsync } from "fastify";
import { PermissionDeniedError } from "../errors.js";
import { loadActiveActor } from "../services/actors.js";
import { refreshNow, type TrackingRuntime } from "../tracking/runtime.js";
import { isSuperadmin } from "../types.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

export interface TrackingRouteOptions extends ActorOptions {
  tracking: TrackingRuntime;
}

/**
 * Tracking routes. Only the admin refresh exists so far; the position endpoints come next.
 *
 * POST /admin/positions/refresh runs one refresh now, as a person's decision. It is superadmin
 * only, it still obeys the call budget (it may use the reserve but never pass the monthly
 * allowance), and it still skips vessels whose latest position is recent, so pressing it twice in
 * a row spends nothing the second time. It answers with what the run did.
 */
export const trackingRoutes: FastifyPluginAsync<TrackingRouteOptions> = async (app, options) => {
  app.post("/admin/positions/refresh", async (request, reply) => {
    const actingUser = await resolveActingUser(request, options.allowDevActorHeader ?? false);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const actor = await loadActiveActor(actingUser);
    if (!isSuperadmin(actor)) throw new PermissionDeniedError("Only VeriPura superadmin can do this");
    return refreshNow(options.tracking, "manual");
  });
};
