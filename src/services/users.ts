import { eq, inArray } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb } from "../db/client.js";
import { org_roles, organizations, user_role_assignments, users, type User } from "../db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { canManageOrgUsers } from "../permissions/engine.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { isUniqueViolation, normalizeEmail } from "./util.js";

/**
 * Creates an invited user in `orgId` and assigns the given roles.
 *
 * Requires canManageOrgUsers(actingUser) AND that the actor belongs to `orgId`; superadmin may
 * invite into any org. The org must be active (a pending org has no roles yet), at least one
 * role is required, and every role must belong to `orgId`. Audit: "user.invited".
 */
export async function inviteUser(
  orgId: string,
  email: string,
  roleIds: string[],
  actingUser: UserRef,
): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  const uniqueRoleIds = [...new Set(roleIds)];
  if (uniqueRoleIds.length === 0) {
    // A roleless user would resolve to the opt-in defaults on every document type, including
    // ones every real role has hidden. Never create one.
    throw new ValidationError("At least one role is required to invite a user");
  }

  try {
    return await getDb().transaction(async (tx) => {
      const allowed =
        (await canManageOrgUsers(actingUser, tx)) && (isSuperadmin(actingUser) || actingUser.organization_id === orgId);
      if (!allowed) throw new PermissionDeniedError("You cannot invite users into this organization");

      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw new NotFoundError(`Organization ${orgId} not found`);
      if (org.status !== "active") {
        throw new ValidationError(`Cannot invite users into organization ${orgId}: status is ${org.status}`);
      }

      const roles = await tx
        .select()
        .from(org_roles)
        .where(inArray(org_roles.id, uniqueRoleIds));
      const foreign = uniqueRoleIds.filter((id) => !roles.some((r) => r.id === id && r.organization_id === orgId));
      if (foreign.length > 0) {
        throw new ValidationError(`Roles not found in organization ${orgId}: ${foreign.join(", ")}`);
      }

      const [user] = await tx
        .insert(users)
        .values({ organization_id: orgId, email: normalizedEmail, status: "invited" })
        .returning();
      await tx
        .insert(user_role_assignments)
        .values(uniqueRoleIds.map((org_role_id) => ({ user_id: user!.id, org_role_id })));

      await recordAudit(
        {
          actorUser: actingUser,
          action: "user.invited",
          targetType: "user",
          targetId: user!.id,
          metadata: {
            organization_id: orgId,
            email: normalizedEmail,
            role_ids: uniqueRoleIds,
            role_names: roles.map((r) => r.name),
          },
        },
        tx,
      );
      return user!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`A user with email ${normalizedEmail} already exists`);
    throw err;
  }
}

/**
 * Sets a user to deactivated. Same authority as inviteUser, scoped to the target user's org.
 *
 * A non-superadmin asking about a user outside their own org gets NotFoundError, not a
 * permission error, so org admins cannot probe which user ids exist elsewhere.
 * Audit: "user.deactivated".
 */
export async function deactivateUser(userId: string, actingUser: UserRef): Promise<User> {
  return getDb().transaction(async (tx) => {
    if (!(await canManageOrgUsers(actingUser, tx))) {
      throw new PermissionDeniedError("You cannot manage users");
    }

    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    const inScope =
      target && (isSuperadmin(actingUser) || (target.organization_id !== null && target.organization_id === actingUser.organization_id));
    if (!target || !inScope) throw new NotFoundError(`User ${userId} not found`);

    if (target.status === "deactivated") {
      throw new ValidationError(`User ${userId} is already deactivated`);
    }

    const [updated] = await tx
      .update(users)
      .set({ status: "deactivated" })
      .where(eq(users.id, userId))
      .returning();

    await recordAudit(
      {
        actorUser: actingUser,
        action: "user.deactivated",
        targetType: "user",
        targetId: userId,
        metadata: { organization_id: target.organization_id, previous_status: target.status },
      },
      tx,
    );
    return updated!;
  });
}
