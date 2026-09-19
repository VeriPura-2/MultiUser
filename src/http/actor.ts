import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import type { UserRef } from "../types.js";

export interface ActorOptions {
  /**
   * Sandbox stand-in for real authentication: trust a header naming a user id and load that user.
   * Off unless explicitly enabled. Real sign-in is a separate prompt; until it lands, real
   * middleware is expected to resolve the acting user upstream of this layer.
   */
  allowDevActorHeader?: boolean;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The dev header the UI sends. */
export const DEV_USER_HEADER = "x-dev-user";
/** The original dev header from earlier stages. Still accepted so existing callers keep working. */
export const LEGACY_DEV_USER_HEADER = "x-acting-user-id";

/**
 * Whether the dev-only acting-user mechanism is switched on. `AUTH_MODE=dev` is the switch. The
 * older `ALLOW_DEV_ACTOR_HEADER=true` is a deprecated alias for the same thing.
 */
export function devActorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_MODE === "dev" || env.ALLOW_DEV_ACTOR_HEADER === "true";
}

/**
 * The dev actor trusts a header naming any user, which is only acceptable on a developer's
 * machine. Refuse to start rather than run that way in production.
 */
export function assertDevModeSafe(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (enabled && env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start: the dev-only acting user (AUTH_MODE=dev, or the deprecated ALLOW_DEV_ACTOR_HEADER=true) " +
        "trusts a header naming any user and must never run with NODE_ENV=production.",
    );
  }
}

/** Resolves the acting user for a request, or null if the request is not authenticated. */
export async function resolveActingUser(request: FastifyRequest, allowDev: boolean): Promise<UserRef | null> {
  if (!allowDev) return null;
  const header = request.headers[DEV_USER_HEADER] ?? request.headers[LEGACY_DEV_USER_HEADER];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id || !UUID.test(id)) return null;
  const [row] = await getDb()
    .select({ id: users.id, organization_id: users.organization_id })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
}
