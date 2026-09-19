import { desc } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { getDb } from "../db/client.js";
import { tracking_runs } from "../db/schema.js";
import { PermissionDeniedError } from "../errors.js";
import { loadActiveActor } from "../services/actors.js";
import { getPosition, listPositions, parseTrailParam } from "../services/positions.js";
import { refreshNow, type TrackingRuntime } from "../tracking/runtime.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

export interface TrackingRouteOptions extends ActorOptions {
  tracking: TrackingRuntime;
}

/**
 * Tracking routes.
 *
 * READ routes (GET /positions, GET /consignments/:id/position, GET /admin/tracking/budget) only
 * read our own database. They are given no way to reach a provider (the position service imports
 * none, and these handlers never touch `options.tracking.provider`), so opening the dashboard,
 * refetching, or reloading can never cost a provider call. Positions arrive only through the
 * refresh job.
 *
 * POST /admin/positions/refresh runs one refresh now, as a person's decision. It is superadmin
 * only, it still obeys the call budget (it may use the reserve but never pass the monthly
 * allowance), and it still skips vessels whose latest position is recent, so pressing it twice in
 * a row spends nothing the second time. It answers with what the run did.
 */
export const trackingRoutes: FastifyPluginAsync<TrackingRouteOptions> = async (app, options) => {
  const actorFor = (request: FastifyRequest) => resolveActingUser(request, options.allowDevActorHeader ?? false);
  const recentMaxAgeSeconds = () => options.tracking.config.recentMaxAgeSeconds;

  const requireSuperadmin = async (actingUser: UserRef) => {
    const actor = await loadActiveActor(actingUser);
    if (!isSuperadmin(actor)) throw new PermissionDeniedError("Only VeriPura superadmin can do this");
    return actor;
  };

  /**
   * Every consignment the user can see, each with its position, how old it is, whether it is
   * "recent", "stale" or "unavailable" (with the reason), whether it is sample data, and the last
   * 24 hours of positions as a `trail`. `?trail=false` leaves the trail out.
   */
  app.get<{ Querystring: { trail?: string } }>("/positions", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const trail = parseTrailParam(request.query.trail);
    return { positions: await listPositions(actingUser, { recentMaxAgeSeconds: recentMaxAgeSeconds(), trail }) };
  });

  /** One consignment's position. The same 404 for a consignment that is missing and one the user cannot see. */
  app.get<{ Params: { consignmentId: string }; Querystring: { trail?: string } }>("/consignments/:consignmentId/position", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const trail = parseTrailParam(request.query.trail);
    return getPosition(request.params.consignmentId, actingUser, { recentMaxAgeSeconds: recentMaxAgeSeconds(), trail });
  });

  /**
   * How much of the provider's monthly allowance is spent, for the team. Superadmin only. It reports
   * counts and dates, never a key or a request.
   */
  app.get("/admin/tracking/budget", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    await requireSuperadmin(actingUser);

    const now = new Date();
    const { config, ledger } = options.tracking;
    const status = await ledger.status(now);
    const [last] = await getDb().select().from(tracking_runs).orderBy(desc(tracking_runs.started_at)).limit(1);
    const backoffUntil = await ledger.backoffUntil(now);
    return {
      provider: config.provider,
      live: options.tracking.provider.live,
      month: now.toISOString().slice(0, 7),
      callsUsed: status.used,
      budget: status.budget,
      reserve: status.reserve,
      remaining: status.remaining,
      automaticRemaining: status.automaticRemaining,
      percentUsed: status.percentUsed,
      backoffUntil: backoffUntil ? backoffUntil.toISOString() : null,
      lastRefreshAt: last ? last.started_at.toISOString() : null,
      lastRefresh: last
        ? {
            trigger: last.trigger,
            provider: last.provider,
            startedAt: last.started_at.toISOString(),
            finishedAt: last.finished_at ? last.finished_at.toISOString() : null,
            vesselsSelected: last.vessels_selected,
            callsMade: last.calls_made,
            positionsStored: last.positions_stored,
            stoppedReason: last.stopped_reason,
          }
        : null,
    };
  });

  app.post("/admin/positions/refresh", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    await requireSuperadmin(actingUser);
    return refreshNow(options.tracking, "manual");
  });
};
