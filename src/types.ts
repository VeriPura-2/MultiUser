import type { User } from "./db/schema.js";

/**
 * The minimal shape of "who is acting". Authentication is upstream of this layer, so a caller
 * hands us the id and organization of an already-resolved user. A full User row satisfies this.
 */
export type UserRef = Pick<User, "id" | "organization_id">;

/**
 * VeriPura superadmins belong to no organization. The check is strict `=== null` on purpose:
 * a caller that forgot to set organization_id (undefined) must not be treated as superadmin.
 */
export function isSuperadmin(user: UserRef): boolean {
  return user.organization_id === null;
}
