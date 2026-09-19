import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { NotFoundError, PermissionDeniedError } from "../errors.js";
import { getOrganizationForAdmin, listExporters, listOrganizationsForAdmin } from "../services/adminOrgs.js";
import { approveOrganization, rejectOrganization } from "../services/organizations.js";
import { loadActiveActor } from "../services/actors.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { UUID, resolveActingUser, type ActorOptions } from "./actor.js";
import { ignoreEmptyJsonBody } from "./emptyBody.js";

/**
 * GET /organizations/exporters (any active importer-org user, for the PO form), and the
 * superadmin-only approval endpoints under /admin. A non-superadmin gets 403 on every /admin
 * route. The approve and reject routes wrap approveOrganization and rejectOrganization and answer
 * with the refreshed organization.
 */
export const adminRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  ignoreEmptyJsonBody(app);
  const actorFor = (request: FastifyRequest) => resolveActingUser(request, options.allowDevActorHeader ?? false);

  /** Refuses (403) anyone who is not an active superadmin, before any organization is looked up. */
  const requireSuperadmin = async (actingUser: UserRef): Promise<UserRef> => {
    const actor = await loadActiveActor(actingUser);
    if (!isSuperadmin(actor)) throw new PermissionDeniedError("Only VeriPura superadmin can do this");
    return actor;
  };

  /** A malformed id is a 404, like an unknown one, not a database error. */
  const requireOrgId = (id: string): string => {
    if (!UUID.test(id)) throw new NotFoundError("Organization not found");
    return id;
  };

  app.get("/organizations/exporters", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return { organizations: await listExporters(actingUser) };
  });

  app.get<{ Querystring: { status?: string } }>("/admin/organizations", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return { organizations: await listOrganizationsForAdmin(actingUser, { status: request.query.status }) };
  });

  app.get<{ Params: { id: string } }>("/admin/organizations/:id", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getOrganizationForAdmin(actingUser, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/organizations/:id/approve", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const superadmin = await requireSuperadmin(actingUser);
    await approveOrganization(requireOrgId(request.params.id), superadmin);
    return getOrganizationForAdmin(superadmin, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/admin/organizations/:id/reject", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const superadmin = await requireSuperadmin(actingUser);
    await rejectOrganization(requireOrgId(request.params.id), superadmin);
    return getOrganizationForAdmin(superadmin, request.params.id);
  });
};
