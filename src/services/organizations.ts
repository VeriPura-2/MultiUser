import { asc, eq } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb, type Tx } from "../db/client.js";
import {
  ORG_TYPES,
  org_roles,
  organizations,
  user_role_assignments,
  users,
  type OrgType,
  type Organization,
  type User,
} from "../db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { ORGANIZATION_ADMIN_ROLE, STANDARD_ROLES } from "../roles.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { isUniqueViolation, normalizeEmail } from "./util.js";

/**
 * Creates an organization in pending_approval plus a first user (status invited) for the
 * requester. Nobody is authenticated at this point, so the requester is recorded as the actor.
 * Audit: "organization.proposed".
 */
export async function proposeOrganization(
  name: string,
  org_type: OrgType,
  requestedByEmail: string,
): Promise<{ organization: Organization; user: User }> {
  const orgName = name?.trim();
  if (!orgName) throw new ValidationError("Organization name is required");
  if (!ORG_TYPES.includes(org_type)) throw new ValidationError(`Unknown org_type "${String(org_type)}"`);
  const email = normalizeEmail(requestedByEmail);

  try {
    return await getDb().transaction(async (tx) => {
      const [organization] = await tx
        .insert(organizations)
        .values({ name: orgName, org_type, status: "pending_approval" })
        .returning();
      const [user] = await tx
        .insert(users)
        .values({ organization_id: organization!.id, email, status: "invited" })
        .returning();

      await recordAudit(
        {
          actorUser: user!,
          action: "organization.proposed",
          targetType: "organization",
          targetId: organization!.id,
          metadata: { name: orgName, org_type, requested_by_email: email, first_user_id: user!.id },
        },
        tx,
      );
      return { organization: organization!, user: user! };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`A user with email ${email} already exists`);
    throw err;
  }
}

/**
 * Superadmin only. Moves a pending organization to active, activates its first user, creates
 * the five standard roles, and assigns Organization Admin to that first user.
 * Audit: "organization.approved".
 */
export async function approveOrganization(orgId: string, actingUser: UserRef): Promise<Organization> {
  requireSuperadmin(actingUser, "approve organizations");

  return getDb().transaction(async (tx) => {
    const org = await lockPendingOrganization(tx, orgId, "approve");

    // At proposal time exactly one user exists, the requester. Take the earliest-created user
    // so the choice is deterministic even if that ever changes.
    const [firstUser] = await tx
      .select()
      .from(users)
      .where(eq(users.organization_id, orgId))
      .orderBy(asc(users.created_at), asc(users.id))
      .limit(1);
    if (!firstUser) throw new ValidationError(`Organization ${orgId} has no first user to make admin`);

    const [approved] = await tx
      .update(organizations)
      .set({ status: "active" })
      .where(eq(organizations.id, orgId))
      .returning();
    await tx.update(users).set({ status: "active" }).where(eq(users.id, firstUser.id));

    const createdRoles = await tx
      .insert(org_roles)
      .values(STANDARD_ROLES.map((r) => ({ organization_id: orgId, name: r.name, is_org_admin: r.is_org_admin })))
      .returning();
    const adminRole = createdRoles.find((r) => r.name === ORGANIZATION_ADMIN_ROLE);
    if (!adminRole) throw new Error("Standard role set is missing Organization Admin");
    await tx.insert(user_role_assignments).values({ user_id: firstUser.id, org_role_id: adminRole.id });

    await recordAudit(
      {
        actorUser: actingUser,
        action: "organization.approved",
        targetType: "organization",
        targetId: orgId,
        metadata: {
          first_user_id: firstUser.id,
          roles_created: createdRoles.map((r) => r.name),
          admin_role_id: adminRole.id,
        },
      },
      tx,
    );
    return approved!;
  });
}

/** Superadmin only. Moves a pending organization to rejected. Audit: "organization.rejected". */
export async function rejectOrganization(orgId: string, actingUser: UserRef): Promise<Organization> {
  requireSuperadmin(actingUser, "reject organizations");

  return getDb().transaction(async (tx) => {
    await lockPendingOrganization(tx, orgId, "reject");
    const [rejected] = await tx
      .update(organizations)
      .set({ status: "rejected" })
      .where(eq(organizations.id, orgId))
      .returning();

    await recordAudit(
      {
        actorUser: actingUser,
        action: "organization.rejected",
        targetType: "organization",
        targetId: orgId,
        metadata: { previous_status: "pending_approval" },
      },
      tx,
    );
    return rejected!;
  });
}

function requireSuperadmin(actingUser: UserRef, what: string): void {
  if (!isSuperadmin(actingUser)) throw new PermissionDeniedError(`Only VeriPura superadmin can ${what}`);
}

/**
 * Loads the organization with a row lock so two concurrent decisions cannot both proceed,
 * and insists it is still pending. Approving an active org or un-rejecting a rejected one
 * is not something the lifecycle allows.
 */
async function lockPendingOrganization(tx: Tx, orgId: string, verb: string): Promise<Organization> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for("update");
  if (!org) throw new NotFoundError(`Organization ${orgId} not found`);
  if (org.status !== "pending_approval") {
    throw new ValidationError(`Cannot ${verb} organization ${orgId}: status is ${org.status}, not pending_approval`);
  }
  return org;
}
