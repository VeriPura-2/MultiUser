import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { org_roles, organizations, user_role_assignments, users, type OrgType, type UserStatus } from "../db/schema.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";

export interface OrganizationSummary {
  id: string;
  name: string;
  orgType: OrgType;
}

export interface MeResponse {
  userId: string;
  /** Null when the user was created by invitation and has not set a name. */
  name: string | null;
  email: string;
  organization: OrganizationSummary | null;
  roleNames: string[];
  isSuperadmin: boolean;
}

/**
 * The signed-in user as the UI needs to show them. Superadmin has no organization and no roles;
 * their authority comes from having no organization. An inactive user is refused (403).
 */
export async function getMe(actingUser: UserRef): Promise<MeResponse> {
  const actor = await loadActiveActor(actingUser);
  const db = getDb();

  let organization: OrganizationSummary | null = null;
  let roleNames: string[] = [];
  if (actor.organization_id) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, actor.organization_id));
    if (org) organization = { id: org.id, name: org.name, orgType: org.org_type };

    // Only roles of the user's own organization count, the same rule the permission engine uses.
    const roles = await db
      .select({ name: org_roles.name })
      .from(user_role_assignments)
      .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id))
      .where(and(eq(user_role_assignments.user_id, actor.id), eq(org_roles.organization_id, actor.organization_id)))
      .orderBy(asc(org_roles.name));
    roleNames = roles.map((r) => r.name);
  }

  return {
    userId: actor.id,
    name: actor.name,
    email: actor.email,
    organization,
    roleNames,
    isSuperadmin: isSuperadmin(actor),
  };
}

export interface DevUserSummary extends MeResponse {
  status: UserStatus;
}

/**
 * Every user, for the dev-only user switcher. Only ever reachable when the dev actor mechanism
 * is on (see http/me.ts); it is not part of the product.
 */
export async function listDevUsers(): Promise<DevUserSummary[]> {
  const db = getDb();
  const [allUsers, orgs, roleRows] = await Promise.all([
    db.select().from(users).orderBy(asc(users.created_at), asc(users.email)),
    db.select().from(organizations),
    db
      .select({ userId: user_role_assignments.user_id, name: org_roles.name })
      .from(user_role_assignments)
      .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id)),
  ]);

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) rolesByUser.set(r.userId, [...(rolesByUser.get(r.userId) ?? []), r.name]);

  return allUsers.map((u) => {
    const org = u.organization_id ? orgById.get(u.organization_id) : undefined;
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      status: u.status,
      organization: org ? { id: org.id, name: org.name, orgType: org.org_type } : null,
      roleNames: (rolesByUser.get(u.id) ?? []).sort(),
      isSuperadmin: isSuperadmin(u),
    };
  });
}
