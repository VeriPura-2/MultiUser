import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { audit_log, org_roles, organizations, user_role_assignments, users } from "../src/db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../src/errors.js";
import { STANDARD_ROLES } from "../src/roles.js";
import {
  approveOrganization,
  proposeOrganization,
  rejectOrganization,
} from "../src/services/organizations.js";
import { deactivateUser, inviteUser } from "../src/services/users.js";
import { createActiveOrg, createSuperadmin, createUserWithRoles } from "./helpers.js";

const db = () => getDb();

async function auditRowsFor(targetId: string) {
  return db().select().from(audit_log).where(eq(audit_log.target_id, targetId));
}

async function countAudit(): Promise<number> {
  return (await db().select().from(audit_log)).length;
}

describe("proposeOrganization", () => {
  it("creates a pending_approval org and an invited first user, and records organization.proposed", async () => {
    const { organization, user } = await proposeOrganization("Acme Imports", "importer", "  Buyer@Example.test ");

    expect(organization).toMatchObject({
      name: "Acme Imports",
      org_type: "importer",
      status: "pending_approval",
      billing_status: "trial",
      stripe_customer_id: null,
      stripe_subscription_id: null,
    });
    expect(user).toMatchObject({ organization_id: organization.id, email: "buyer@example.test", status: "invited" });

    const rows = await auditRowsFor(organization.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "organization.proposed",
      target_type: "organization",
      target_id: organization.id,
      actor_user_id: user.id,
    });
  });

  it("does not create roles before approval", async () => {
    const { organization } = await proposeOrganization("Acme", "exporter", "a@example.test");
    expect(await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id))).toHaveLength(0);
  });

  it("accepts the wider org types the pilot does not use yet", async () => {
    await proposeOrganization("Lab", "lab_cert", "lab@example.test");
    await proposeOrganization("Registry", "data_source", "reg@example.test");
  });

  it("rejects a duplicate email (case-insensitive) and leaves no partial org or audit row", async () => {
    await proposeOrganization("First", "importer", "same@example.test");
    const orgsBefore = (await db().select().from(organizations)).length;
    const auditBefore = await countAudit();

    await expect(proposeOrganization("Second", "exporter", "SAME@example.test")).rejects.toThrow(ValidationError);

    expect(await db().select().from(organizations)).toHaveLength(orgsBefore);
    expect(await countAudit()).toBe(auditBefore);
  });

  it("rejects an empty name, an unknown org type, and a malformed email", async () => {
    await expect(proposeOrganization("  ", "importer", "a@example.test")).rejects.toThrow(ValidationError);
    await expect(proposeOrganization("X", "farmer" as never, "a@example.test")).rejects.toThrow(ValidationError);
    await expect(proposeOrganization("X", "importer", "not-an-email")).rejects.toThrow(ValidationError);
  });
});

describe("approveOrganization", () => {
  it("activates the org and first user, creates all five standard roles, and assigns Organization Admin", async () => {
    const superadmin = await createSuperadmin();
    const { organization, user } = await proposeOrganization("Acme", "exporter", "boss@example.test");

    const approved = await approveOrganization(organization.id, superadmin);
    expect(approved.status).toBe("active");

    const [firstUser] = await db().select().from(users).where(eq(users.id, user.id));
    expect(firstUser!.status).toBe("active");

    const roles = await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id));
    expect(roles.map((r) => r.name).sort()).toEqual(STANDARD_ROLES.map((r) => r.name).sort());
    expect(roles).toHaveLength(5);
    for (const r of roles) {
      expect(r.is_org_admin).toBe(r.name === "Organization Admin");
    }

    const assignments = await db().select().from(user_role_assignments).where(eq(user_role_assignments.user_id, user.id));
    expect(assignments).toHaveLength(1);
    const adminRole = roles.find((r) => r.name === "Organization Admin")!;
    expect(assignments[0]!.org_role_id).toBe(adminRole.id);
  });

  it("records organization.approved with the acting superadmin", async () => {
    const superadmin = await createSuperadmin();
    const { organization, user } = await proposeOrganization("Acme", "importer", "boss@example.test");
    await approveOrganization(organization.id, superadmin);

    const rows = (await auditRowsFor(organization.id)).filter((r) => r.action === "organization.approved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: superadmin.id, target_type: "organization" });
    expect(rows[0]!.metadata).toMatchObject({ first_user_id: user.id });
  });

  it("is superadmin only: an Organization Admin of another org is refused and nothing changes", async () => {
    const other = await createActiveOrg("importer");
    const { organization } = await proposeOrganization("Acme", "exporter", "boss@example.test");
    const auditBefore = await countAudit();

    await expect(approveOrganization(organization.id, other.admin)).rejects.toThrow(PermissionDeniedError);

    const [org] = await db().select().from(organizations).where(eq(organizations.id, organization.id));
    expect(org!.status).toBe("pending_approval");
    expect(await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id))).toHaveLength(0);
    expect(await countAudit()).toBe(auditBefore);
  });

  it("refuses to approve twice, and refuses an unknown org", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await proposeOrganization("Acme", "exporter", "boss@example.test");
    await approveOrganization(organization.id, superadmin);

    await expect(approveOrganization(organization.id, superadmin)).rejects.toThrow(ValidationError);
    expect(await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id))).toHaveLength(5);
    await expect(approveOrganization("00000000-0000-0000-0000-000000000000", superadmin)).rejects.toThrow(NotFoundError);
  });
});

describe("rejectOrganization", () => {
  it("sets status rejected and records organization.rejected", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await proposeOrganization("Nope", "logistics", "x@example.test");

    const rejected = await rejectOrganization(organization.id, superadmin);
    expect(rejected.status).toBe("rejected");

    const rows = (await auditRowsFor(organization.id)).filter((r) => r.action === "organization.rejected");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: superadmin.id, target_type: "organization" });
  });

  it("is superadmin only", async () => {
    const other = await createActiveOrg("importer");
    const { organization } = await proposeOrganization("Nope", "logistics", "x@example.test");
    await expect(rejectOrganization(organization.id, other.admin)).rejects.toThrow(PermissionDeniedError);
    const [org] = await db().select().from(organizations).where(eq(organizations.id, organization.id));
    expect(org!.status).toBe("pending_approval");
  });

  it("a rejected org cannot then be approved", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await proposeOrganization("Nope", "logistics", "x@example.test");
    await rejectOrganization(organization.id, superadmin);
    await expect(approveOrganization(organization.id, superadmin)).rejects.toThrow(ValidationError);
  });
});

describe("inviteUser", () => {
  it("lets an Organization Admin invite into their own org, with roles assigned and user.invited recorded", async () => {
    const t = await createActiveOrg("exporter");
    const invited = await inviteUser(
      t.org.id,
      "New.Person@Example.test",
      [t.roles["Compliance User"].id, t.roles["Reviewer"].id],
      t.admin,
    );

    expect(invited).toMatchObject({ organization_id: t.org.id, email: "new.person@example.test", status: "invited" });
    const assigned = await db().select().from(user_role_assignments).where(eq(user_role_assignments.user_id, invited.id));
    expect(assigned.map((a) => a.org_role_id).sort()).toEqual([t.roles["Compliance User"].id, t.roles["Reviewer"].id].sort());

    const rows = await auditRowsFor(invited.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user.invited",
      target_type: "user",
      target_id: invited.id,
      actor_user_id: t.admin.id,
    });
  });

  it("refuses an Organization Admin inviting into another org, and writes nothing", async () => {
    const mine = await createActiveOrg("importer");
    const theirs = await createActiveOrg("exporter");
    const usersBefore = (await db().select().from(users)).length;
    const auditBefore = await countAudit();

    await expect(
      inviteUser(theirs.org.id, "spy@example.test", [theirs.roles["Viewer"].id], mine.admin),
    ).rejects.toThrow(PermissionDeniedError);

    expect(await db().select().from(users)).toHaveLength(usersBefore);
    expect(await countAudit()).toBe(auditBefore);
  });

  it("refuses a user without an org-admin role, even in their own org", async () => {
    const t = await createActiveOrg("exporter");
    const manager = await createUserWithRoles(t, ["Compliance Manager"]);
    await expect(inviteUser(t.org.id, "x@example.test", [t.roles["Viewer"].id], manager)).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("lets superadmin invite into any org", async () => {
    const superadmin = await createSuperadmin();
    const t = await createActiveOrg("logistics");
    const invited = await inviteUser(t.org.id, "fwd@example.test", [t.roles["Viewer"].id], superadmin);
    expect(invited.organization_id).toBe(t.org.id);
    const rows = await auditRowsFor(invited.id);
    expect(rows[0]).toMatchObject({ action: "user.invited", actor_user_id: superadmin.id });
  });

  it("refuses role ids from another org, and writes no user and no audit row", async () => {
    const mine = await createActiveOrg("importer");
    const theirs = await createActiveOrg("exporter");
    const usersBefore = (await db().select().from(users)).length;
    const auditBefore = await countAudit();

    await expect(
      inviteUser(mine.org.id, "x@example.test", [theirs.roles["Organization Admin"].id], mine.admin),
    ).rejects.toThrow(ValidationError);

    expect(await db().select().from(users)).toHaveLength(usersBefore);
    expect(await countAudit()).toBe(auditBefore);
  });

  it("requires at least one role", async () => {
    const t = await createActiveOrg("importer");
    await expect(inviteUser(t.org.id, "x@example.test", [], t.admin)).rejects.toThrow(ValidationError);
  });

  it("refuses a duplicate email in any letter case, and inviting into a pending org", async () => {
    const t = await createActiveOrg("importer");
    await inviteUser(t.org.id, "dup@example.test", [t.roles["Viewer"].id], t.admin);
    await expect(inviteUser(t.org.id, "DUP@example.test", [t.roles["Viewer"].id], t.admin)).rejects.toThrow(
      ValidationError,
    );

    const superadmin = await createSuperadmin();
    const { organization } = await proposeOrganization("Pending", "exporter", "p@example.test");
    await expect(inviteUser(organization.id, "q@example.test", [t.roles["Viewer"].id], superadmin)).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("deactivateUser", () => {
  it("lets an Organization Admin deactivate a user in their own org and records user.deactivated", async () => {
    const t = await createActiveOrg("exporter");
    const target = await createUserWithRoles(t, ["Viewer"]);

    const result = await deactivateUser(target.id, t.admin);
    expect(result.status).toBe("deactivated");

    const rows = (await auditRowsFor(target.id)).filter((r) => r.action === "user.deactivated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "user", target_id: target.id, actor_user_id: t.admin.id });
    expect(rows[0]!.metadata).toMatchObject({ previous_status: "active", organization_id: t.org.id });
  });

  it("cannot reach a user in another org: NotFoundError, user unchanged, nothing audited", async () => {
    const mine = await createActiveOrg("importer");
    const theirs = await createActiveOrg("exporter");
    const target = await createUserWithRoles(theirs, ["Viewer"]);
    const auditBefore = await countAudit();

    await expect(deactivateUser(target.id, mine.admin)).rejects.toThrow(NotFoundError);

    const [after] = await db().select().from(users).where(eq(users.id, target.id));
    expect(after!.status).toBe("active");
    expect(await countAudit()).toBe(auditBefore);
  });

  it("refuses a user without an org-admin role", async () => {
    const t = await createActiveOrg("exporter");
    const manager = await createUserWithRoles(t, ["Compliance Manager"]);
    const target = await createUserWithRoles(t, ["Viewer"]);
    await expect(deactivateUser(target.id, manager)).rejects.toThrow(PermissionDeniedError);
  });

  it("lets superadmin deactivate a user in any org, and an org admin cannot touch a superadmin", async () => {
    const superadmin = await createSuperadmin();
    const otherSuperadmin = await createSuperadmin();
    const t = await createActiveOrg("importer");
    const target = await createUserWithRoles(t, ["Viewer"]);

    expect((await deactivateUser(target.id, superadmin)).status).toBe("deactivated");
    await expect(deactivateUser(otherSuperadmin.id, t.admin)).rejects.toThrow(NotFoundError);
  });

  it("refuses to deactivate someone already deactivated, without a duplicate audit row", async () => {
    const t = await createActiveOrg("exporter");
    const target = await createUserWithRoles(t, ["Viewer"]);
    await deactivateUser(target.id, t.admin);

    await expect(deactivateUser(target.id, t.admin)).rejects.toThrow(ValidationError);
    expect((await auditRowsFor(target.id)).filter((r) => r.action === "user.deactivated")).toHaveLength(1);
  });
});

describe("every lifecycle function produces its audit row", () => {
  it("proposed, approved, rejected, invited, deactivated: right action, target type, target id, and actor", async () => {
    const superadmin = await createSuperadmin();

    const proposed = await proposeOrganization("Audited Importer", "importer", "audit1@example.test");
    const toReject = await proposeOrganization("Audited Reject", "exporter", "audit2@example.test");
    await approveOrganization(proposed.organization.id, superadmin);
    await rejectOrganization(toReject.organization.id, superadmin);

    const roles = await db()
      .select()
      .from(org_roles)
      .where(and(eq(org_roles.organization_id, proposed.organization.id), eq(org_roles.name, "Viewer")));
    const invited = await inviteUser(proposed.organization.id, "audit3@example.test", [roles[0]!.id], superadmin);
    await deactivateUser(invited.id, superadmin);

    const expectations = [
      { action: "organization.proposed", targetType: "organization", targetId: proposed.organization.id, actor: proposed.user.id },
      { action: "organization.proposed", targetType: "organization", targetId: toReject.organization.id, actor: toReject.user.id },
      { action: "organization.approved", targetType: "organization", targetId: proposed.organization.id, actor: superadmin.id },
      { action: "organization.rejected", targetType: "organization", targetId: toReject.organization.id, actor: superadmin.id },
      { action: "user.invited", targetType: "user", targetId: invited.id, actor: superadmin.id },
      { action: "user.deactivated", targetType: "user", targetId: invited.id, actor: superadmin.id },
    ];

    const all = await db().select().from(audit_log);
    expect(all).toHaveLength(expectations.length);
    for (const e of expectations) {
      const matches = all.filter((r) => r.action === e.action && r.target_id === e.targetId);
      expect(matches, `${e.action} on ${e.targetId}`).toHaveLength(1);
      expect(matches[0]).toMatchObject({ target_type: e.targetType, actor_user_id: e.actor });
    }
  });
});
