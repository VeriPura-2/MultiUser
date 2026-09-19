import type { FastifyPluginAsync } from "fastify";
import { getMe, listDevUsers } from "../services/me.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

/**
 * GET /me: who the UI is acting as. GET /dev/users: the list behind the dev-only user switcher,
 * which exists (as a 404 otherwise) only while the dev acting-user mechanism is on. It needs no
 * acting user, because the switcher must be able to list users before one is chosen.
 */
export const meRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  const allowDev = options.allowDevActorHeader ?? false;

  app.get("/me", async (request, reply) => {
    const actingUser = await resolveActingUser(request, allowDev);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getMe(actingUser);
  });

  app.get("/dev/users", async (_request, reply) => {
    if (!allowDev) return reply.code(404).send({ error: "not_found", message: "Not found" });
    return { users: await listDevUsers() };
  });
};
