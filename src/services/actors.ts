import { eq } from "drizzle-orm";
import type { DbExecutor } from "../db/client.js";
import { getDb } from "../db/client.js";
import { users, type User } from "../db/schema.js";
import { PermissionDeniedError } from "../errors.js";
import { isSuperadmin, type UserRef } from "../types.js";

/**
 * Loads the acting user's real row and insists they are active. Uses the stored
 * organization_id, not the one on the reference the caller passed, so a stale or forged
 * reference cannot widen access. Superadmin is exempt from the status check, matching stage 1
 * where superadmin authority is decided by organization_id alone.
 */
export async function loadActiveActor(actingUser: UserRef, db: DbExecutor = getDb()): Promise<User> {
  const [row] = await db.select().from(users).where(eq(users.id, actingUser.id));
  if (!row) throw new PermissionDeniedError("Acting user does not exist");
  if (!isSuperadmin(row) && row.status !== "active") {
    throw new PermissionDeniedError("Acting user is not active");
  }
  return row;
}
