import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { audit_log, org_roles, organizations, users } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { STANDARD_ROLES } from "../src/roles.js";
import { proposeOrganization, rejectOrganization } from "../src/services/organizations.js";
import { createActiveOrg, createDocumentType, createSuperadmin, createUserWithRoles, setRule } from "./helpers.js";

const db = () => getDb();
const app = buildApp({ actor: { allowDevActorHeader: true } });

type Json = Record<string, any>;
const call = (method: "GET" | "POST", url: string, actorId?: string) =>
  app.inject({ method, url, headers: actorId ? { "x-dev-user": actorId } : {} });

/** A pending organization with a named applicant. */
async function pending(name = "Pending Exports", orgType: "exporter" | "importer" | "logistics" = "exporter", email = "applicant@example.test") {
  const { organization, user } = await proposeOrganization(name, orgType, email);
  await db().update(users).set({ name: "Ada Applicant" }).where(eq(users.id, user.id));
  return { organization, user };
}

describe("GET /organizations/exporters", () => {
  it("returns only active exporter organizations as { id, name }, sorted by name", async () => {
    const importer = await createActiveOrg("importer");
    const zed = await createActiveOrg("exporter", "Zed Exports");
    const alpha = await createActiveOrg("exporter", "Alpha Exports");
    await createActiveOrg("logistics", "Some Logistics");
    await createActiveOrg("importer", "Another Importer");
    // Exporters that must not appear: pending, suspended, rejected.
    await pending("Pending Exports");
    const suspended = await createActiveOrg("exporter", "Suspended Exports");
    await db().update(organizations).set({ status: "suspended" }).where(eq(organizations.id, suspended.org.id));
    const superadmin = await createSuperadmin();
    const rejected = await proposeOrganization("Rejected Exports", "exporter", "rej@example.test");
    await rejectOrganization(rejected.organization.id, superadmin);

    const res = await call("GET", "/organizations/exporters", importer.admin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      organizations: [
        { id: alpha.org.id, name: "Alpha Exports" },
        { id: zed.org.id, name: "Zed Exports" },
      ],
    });
  });

  it("is available to any active importer-org user, not only admins, and to superadmin", async () => {
    const importer = await createActiveOrg("importer");
    const exporter = await createActiveOrg("exporter", "Alpha Exports");
    const viewer = await createUserWithRoles(importer, ["Viewer"]);
    const superadmin = await createSuperadmin();
    for (const id of [importer.admin.id, viewer.id, superadmin.id]) {
      const res = await call("GET", "/organizations/exporters", id);
      expect(res.statusCode).toBe(200);
      expect(res.json().organizations.map((o: Json) => o.id)).toEqual([exporter.org.id]);
    }
  });

  it("is refused (403) to exporter, logistics, and lab organizations, and 401 without a user", async () => {
    const exporter = await createActiveOrg("exporter");
    const logistics = await createActiveOrg("logistics");
    const lab = await createActiveOrg("lab_cert");
    for (const t of [exporter, logistics, lab]) {
      expect((await call("GET", "/organizations/exporters", t.admin.id)).statusCode).toBe(403);
    }
    expect((await call("GET", "/organizations/exporters")).statusCode).toBe(401);
  });

  it("is 403 for an inactive importer-org user", async () => {
    const importer = await createActiveOrg("importer");
    const user = await createUserWithRoles(importer, ["Viewer"]);
    await db().update(users).set({ status: "deactivated" }).where(eq(users.id, user.id));
    expect((await call("GET", "/organizations/exporters", user.id)).statusCode).toBe(403);
  });
});

describe("superadmin endpoints are refused to everyone else", () => {
  it("returns 403 on every /admin route for an organization admin, and 401 with no user", async () => {
    const t = await createActiveOrg("importer");
    const { organization } = await pending();
    const routes: Array<["GET" | "POST", string]> = [
      ["GET", "/admin/organizations"],
      ["GET", `/admin/organizations/${organization.id}`],
      ["POST", `/admin/organizations/${organization.id}/approve`],
      ["POST", `/admin/organizations/${organization.id}/reject`],
    ];
    for (const [method, url] of routes) {
      expect((await call(method, url, t.admin.id)).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(method, url)).statusCode, `${method} ${url} unauthenticated`).toBe(401);
    }
    // Nothing changed.
    expect((await db().select().from(organizations).where(eq(organizations.id, organization.id)))[0]!.status).toBe("pending_approval");
    expect(await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id))).toHaveLength(0);
  });
});

describe("GET /admin/organizations", () => {
  it("lists pending organizations with the applicant's name and email, and no country", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await pending("Pending Exports", "exporter", "ada@example.test");
    const res = await call("GET", "/admin/organizations?status=pending_approval", superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().organizations).toEqual([
      {
        id: organization.id,
        name: "Pending Exports",
        orgType: "exporter",
        status: "pending_approval",
        createdAt: expect.any(String),
        applicant: { name: "Ada Applicant", email: "ada@example.test" },
      },
    ]);
    // The schema has no applicant country, so none is offered.
    expect(res.json().organizations[0].applicant).not.toHaveProperty("country");
  });

  it("filters by status, returns everything without a filter, and refuses an unknown status", async () => {
    const superadmin = await createSuperadmin();
    const waiting = await pending("Waiting");
    const active = await createActiveOrg("importer", "Live Importer");

    const only = (await call("GET", "/admin/organizations?status=pending_approval", superadmin.id)).json().organizations;
    expect(only.map((o: Json) => o.id)).toEqual([waiting.organization.id]);
    const activeOnly = (await call("GET", "/admin/organizations?status=active", superadmin.id)).json().organizations;
    expect(activeOnly.map((o: Json) => o.id)).toEqual([active.org.id]);
    const all = (await call("GET", "/admin/organizations", superadmin.id)).json().organizations;
    expect(all.map((o: Json) => o.id).sort()).toEqual([waiting.organization.id, active.org.id].sort());
    expect((await call("GET", "/admin/organizations?status=bogus", superadmin.id)).statusCode).toBe(400);
  });

  it("lists oldest first so the approval queue is first come, first served", async () => {
    const superadmin = await createSuperadmin();
    const first = await pending("First", "exporter", "first@example.test");
    const second = await pending("Second", "exporter", "second@example.test");
    await db().update(organizations).set({ created_at: new Date("2026-01-01") }).where(eq(organizations.id, first.organization.id));
    await db().update(organizations).set({ created_at: new Date("2026-02-01") }).where(eq(organizations.id, second.organization.id));
    const list = (await call("GET", "/admin/organizations?status=pending_approval", superadmin.id)).json().organizations;
    expect(list.map((o: Json) => o.name)).toEqual(["First", "Second"]);
  });
});

describe("GET /admin/organizations/:id", () => {
  it("shows the five standard roles, with their default permissions exactly as configured", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await pending("Pending Exports", "exporter");
    const invoice = await createDocumentType("Commercial Invoice");
    const cert = await createDocumentType("Export Health Certificate");
    await setRule(invoice, "exporter", "Compliance User", { view: "full", edit: true, approve: true });
    await setRule(cert, "exporter", "Viewer", { view: "status_only" });

    const res = await call("GET", `/admin/organizations/${organization.id}`, superadmin.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: organization.id, name: "Pending Exports", orgType: "exporter", status: "pending_approval" });
    expect(body.roles.map((r: Json) => [r.name, r.isOrgAdmin])).toEqual(STANDARD_ROLES.map((r) => [r.name, r.is_org_admin]));

    const role = (name: string) => body.roles.find((r: Json) => r.name === name);
    const perm = (roleName: string, doc: string) => role(roleName).permissions.find((p: Json) => p.documentTypeName === doc);

    expect(perm("Compliance User", "Commercial Invoice")).toMatchObject({
      configured: true,
      viewLevel: "full",
      canEdit: true,
      canDownload: false,
      canApprove: true,
    });
    expect(perm("Viewer", "Export Health Certificate")).toMatchObject({ configured: true, viewLevel: "status_only", canEdit: false });
  });

  it("reports 'not configured' where no rule exists, and never invents a permission", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await pending();
    const invoice = await createDocumentType("Commercial Invoice");
    await createDocumentType("Packing List");
    await setRule(invoice, "exporter", "Compliance User", { view: "full" });

    const body = (await call("GET", `/admin/organizations/${organization.id}`, superadmin.id)).json();
    const all = body.roles.flatMap((r: Json) => r.permissions.map((p: Json) => ({ role: r.name, ...p })));
    // Ten rows (five roles, two documents). Exactly one is configured.
    expect(all).toHaveLength(10);
    expect(all.filter((p: Json) => p.configured)).toHaveLength(1);
    for (const p of all.filter((p: Json) => !p.configured)) {
      expect(p).toMatchObject({ viewLevel: null, canEdit: false, canDownload: false, canApprove: false });
    }
  });

  it("uses only rules for this organization's type, not another type's", async () => {
    const superadmin = await createSuperadmin();
    const exporterOrg = await pending("An Exporter", "exporter", "e@example.test");
    const importerOrg = await pending("An Importer", "importer", "i@example.test");
    const doc = await createDocumentType("Commercial Invoice");
    await setRule(doc, "importer", "Compliance User", { view: "hidden" });

    const forExporter = (await call("GET", `/admin/organizations/${exporterOrg.organization.id}`, superadmin.id)).json();
    const forImporter = (await call("GET", `/admin/organizations/${importerOrg.organization.id}`, superadmin.id)).json();
    const cu = (b: Json) => b.roles.find((r: Json) => r.name === "Compliance User").permissions[0];
    expect(cu(forExporter).configured).toBe(false);
    expect(cu(forImporter)).toMatchObject({ configured: true, viewLevel: "hidden" });
  });

  it("with no document types at all, lists the roles with empty permissions", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await pending();
    const body = (await call("GET", `/admin/organizations/${organization.id}`, superadmin.id)).json();
    expect(body.roles).toHaveLength(5);
    expect(body.roles.every((r: Json) => r.permissions.length === 0)).toBe(true);
  });

  it("is a 404 for an unknown or malformed id", async () => {
    const superadmin = await createSuperadmin();
    expect((await call("GET", "/admin/organizations/00000000-0000-4000-8000-000000000000", superadmin.id)).statusCode).toBe(404);
    expect((await call("GET", "/admin/organizations/nope", superadmin.id)).statusCode).toBe(404);
  });
});

describe("POST /admin/organizations/:id/approve and /reject", () => {
  it("approves: the org becomes active, the five roles exist, the first user is an active Organization Admin, and it is audited", async () => {
    const superadmin = await createSuperadmin();
    const { organization, user } = await pending();

    const res = await call("POST", `/admin/organizations/${organization.id}/approve`, superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: organization.id, status: "active" });

    const roles = await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id));
    expect(roles.map((r) => r.name).sort()).toEqual(STANDARD_ROLES.map((r) => r.name).sort());
    expect((await db().select().from(users).where(eq(users.id, user.id)))[0]!.status).toBe("active");

    const row = (await db().select().from(audit_log).where(eq(audit_log.target_id, organization.id))).find((a) => a.action === "organization.approved")!;
    expect(row).toMatchObject({ actor_user_id: superadmin.id, target_type: "organization" });
  });

  it("rejects: the org becomes rejected, no roles are created, and it is audited", async () => {
    const superadmin = await createSuperadmin();
    const { organization } = await pending();

    const res = await call("POST", `/admin/organizations/${organization.id}/reject`, superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rejected" });
    expect(await db().select().from(org_roles).where(eq(org_roles.organization_id, organization.id))).toHaveLength(0);
    const row = (await db().select().from(audit_log).where(eq(audit_log.target_id, organization.id))).find((a) => a.action === "organization.rejected")!;
    expect(row).toMatchObject({ actor_user_id: superadmin.id });
  });

  it("refuses to decide twice or to reverse a decision (400), with no second audit row", async () => {
    const superadmin = await createSuperadmin();
    const a = await pending("A", "exporter", "a@example.test");
    const b = await pending("B", "exporter", "b@example.test");

    expect((await call("POST", `/admin/organizations/${a.organization.id}/approve`, superadmin.id)).statusCode).toBe(200);
    expect((await call("POST", `/admin/organizations/${a.organization.id}/approve`, superadmin.id)).statusCode).toBe(400);
    expect((await call("POST", `/admin/organizations/${a.organization.id}/reject`, superadmin.id)).statusCode).toBe(400);
    expect((await call("POST", `/admin/organizations/${b.organization.id}/reject`, superadmin.id)).statusCode).toBe(200);
    expect((await call("POST", `/admin/organizations/${b.organization.id}/approve`, superadmin.id)).statusCode).toBe(400);

    const audits = await db().select().from(audit_log);
    expect(audits.filter((r) => r.action === "organization.approved" && r.target_id === a.organization.id)).toHaveLength(1);
  });

  it("approve and reject work with a JSON content type and no body", async () => {
    const superadmin = await createSuperadmin();
    const a = await pending("A", "exporter", "a@example.test");
    const b = await pending("B", "exporter", "b@example.test");
    const bare = (url: string) =>
      app.inject({ method: "POST", url, headers: { "x-dev-user": superadmin.id, "content-type": "application/json" } });
    expect((await bare(`/admin/organizations/${a.organization.id}/approve`)).statusCode).toBe(200);
    expect((await bare(`/admin/organizations/${b.organization.id}/reject`)).statusCode).toBe(200);
  });

  it("is a 404 for an unknown organization", async () => {
    const superadmin = await createSuperadmin();
    expect((await call("POST", "/admin/organizations/00000000-0000-4000-8000-000000000000/approve", superadmin.id)).statusCode).toBe(404);
    expect((await call("POST", "/admin/organizations/nope/reject", superadmin.id)).statusCode).toBe(404);
  });

  it("after approval the organization appears in the exporter directory", async () => {
    const superadmin = await createSuperadmin();
    const importer = await createActiveOrg("importer");
    const { organization } = await pending("New Exporter", "exporter", "new@example.test");
    expect((await call("GET", "/organizations/exporters", importer.admin.id)).json().organizations).toEqual([]);

    await call("POST", `/admin/organizations/${organization.id}/approve`, superadmin.id);
    expect((await call("GET", "/organizations/exporters", importer.admin.id)).json().organizations).toEqual([
      { id: organization.id, name: "New Exporter" },
    ]);
  });
});
