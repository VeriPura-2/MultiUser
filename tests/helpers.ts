import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import {
  document_permission_rules,
  document_types,
  org_roles,
  user_role_assignments,
  users,
  type DocumentType,
  type Organization,
  type OrgRole,
  type OrgType,
  type User,
  type ViewLevel,
} from "../src/db/schema.js";
import type { StandardRoleName } from "../src/roles.js";
import { approveOrganization, proposeOrganization } from "../src/services/organizations.js";

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createSuperadmin(): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ organization_id: null, email: `super-${unique()}@veripura.test`, status: "active" })
    .returning();
  return user!;
}

export interface TestOrg {
  org: Organization;
  /** The requester, activated by approval and holding Organization Admin. */
  admin: User;
  roles: Record<StandardRoleName, OrgRole>;
}

/** Proposes and approves an organization through the real lifecycle functions. */
export async function createActiveOrg(orgType: OrgType, name = `Org ${unique()}`): Promise<TestOrg> {
  const superadmin = await createSuperadmin();
  const { organization } = await proposeOrganization(name, orgType, `admin-${unique()}@example.test`);
  const org = await approveOrganization(organization.id, superadmin);
  const rows = await getDb().select().from(org_roles).where(eq(org_roles.organization_id, org.id));
  const roles = Object.fromEntries(rows.map((r) => [r.name, r])) as Record<StandardRoleName, OrgRole>;
  const [admin] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.organization_id, org.id)));
  return { org, admin: admin!, roles };
}

/** Inserts an active user with the given roles directly, without going through inviteUser. */
export async function createUserWithRoles(t: TestOrg, roleNames: StandardRoleName[]): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ organization_id: t.org.id, email: `user-${unique()}@example.test`, status: "active" })
    .returning();
  if (roleNames.length > 0) {
    await getDb()
      .insert(user_role_assignments)
      .values(roleNames.map((n) => ({ user_id: user!.id, org_role_id: t.roles[n].id })));
  }
  return user!;
}

export async function createDocumentType(name = `Doc ${unique()}`): Promise<DocumentType> {
  const [dt] = await getDb().insert(document_types).values({ name, category: "Test" }).returning();
  return dt!;
}

export async function setRule(
  documentType: DocumentType,
  orgType: OrgType,
  roleName: StandardRoleName,
  grant: { view: ViewLevel; edit?: boolean; download?: boolean; approve?: boolean },
): Promise<void> {
  await getDb()
    .insert(document_permission_rules)
    .values({
      document_type_id: documentType.id,
      org_type: orgType,
      org_role_name: roleName,
      view_level: grant.view,
      can_edit: grant.edit ?? false,
      can_download: grant.download ?? false,
      can_approve: grant.approve ?? false,
    });
}
