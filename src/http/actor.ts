import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import type { UserRef } from "../types.js";

export interface ActorOptions {
  /**
   * Sandbox stand-in for real authentication: trust an `X-Acting-User-Id` header and load that
   * user. Off unless explicitly enabled. Sign-in is a separate prompt; until it lands, real
   * middleware is expected to resolve the acting user upstream of this layer.
   */
  allowDevActorHeader?: boolean;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the acting user for a request, or null if the request is not authenticated. */
export async function resolveActingUser(request: FastifyRequest, allowDev: boolean): Promise<UserRef | null> {
  if (!allowDev) return null;
  const header = request.headers["x-acting-user-id"];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id || !UUID.test(id)) return null;
  const [row] = await getDb()
    .select({ id: users.id, organization_id: users.organization_id })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
}
