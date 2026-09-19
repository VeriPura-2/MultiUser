import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { STUB_CHECKLIST_DOCUMENTS } from "../src/core/client.js";
import { getDb } from "../src/db/client.js";
import {
  ORG_TYPES,
  audit_log,
  consignments,
  document_permission_rules,
  document_types,
  issues,
  org_roles,
  organizations,
  user_role_assignments,
  users,
} from "../src/db/schema.js";
import { SAMPLE_SUPERADMIN_EMAIL, SAMPLE_VESSELS, assertLocalDatabase, sampleViewLevel, seedDev } from "../src/dev/seedDev.js";
import { buildApp } from "../src/http/app.js";
import { STANDARD_ROLES } from "../src/roles.js";

const db = () => getDb();
const app = () => buildApp({ actor: { allowDevActorHeader: true } });

describe("seedDev", () => {
  it("creates one superadmin and the sample organizations, all active, with the five standard roles and a user each", async () => {
    const summary = await seedDev();
    expect(summary.skipped).toBe(false);

    const supers = await db().select().from(users).where(eq(users.email, SAMPLE_SUPERADMIN_EMAIL));
    expect(supers).toHaveLength(1);
    expect(supers[0]).toMatchObject({ organization_id: null, status: "active" });

    const orgs = await db().select().from(organizations);
    const byType = (t: string) => orgs.filter((o) => o.org_type === t).length;
    expect(orgs).toHaveLength(6);
    expect([byType("importer"), byType("exporter"), byType("logistics"), byType("lab_cert")]).toEqual([1, 3, 1, 1]);
    expect(orgs.every((o) => o.status === "active" && o.name.startsWith("Sample "))).toBe(true);

    const roles = await db().select().from(org_roles);
    const allUsers = await db().select().from(users);
    for (const org of orgs) {
      const names = roles.filter((r) => r.organization_id === org.id).map((r) => r.name).sort();
      expect(names, org.name).toEqual(STANDARD_ROLES.map((r) => r.name).sort());
      expect(allUsers.filter((u) => u.organization_id === org.id).length, org.name).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives the importer a second user who holds only the Viewer role", async () => {
    await seedDev();
    const importer = (await db().select().from(organizations).where(eq(organizations.org_type, "importer")))[0]!;
    const importerUsers = await db().select().from(users).where(eq(users.organization_id, importer.id));
    expect(importerUsers).toHaveLength(2);

    const viewer = importerUsers.find((u) => u.email.startsWith("viewer@"))!;
    expect(viewer.status).toBe("active");
    const assigned = await db()
      .select({ name: org_roles.name })
      .from(user_role_assignments)
      .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id))
      .where(eq(user_role_assignments.user_id, viewer.id));
    expect(assigned.map((a) => a.name)).toEqual(["Viewer"]);
  });

  it("uses only the stub's document types and invents no categories", async () => {
    await seedDev();
    const types = await db().select().from(document_types);
    expect(types.map((t) => t.name).sort()).toEqual(STUB_CHECKLIST_DOCUMENTS.map((d) => d.documentTypeName).sort());
    expect(types.every((t) => t.category === null)).toBe(true);
  });

  it("writes a permission rule for every org type, role name, and document type, with every grant false", async () => {
    await seedDev();
    const rules = await db().select().from(document_permission_rules);
    expect(rules).toHaveLength(ORG_TYPES.length * STANDARD_ROLES.length * STUB_CHECKLIST_DOCUMENTS.length);
    expect(rules.every((r) => !r.can_edit && !r.can_download && !r.can_approve)).toBe(true);
    expect(new Set(rules.map((r) => r.org_type))).toEqual(new Set(ORG_TYPES));
    expect(new Set(rules.map((r) => r.org_role_name))).toEqual(new Set(STANDARD_ROLES.map((r) => r.name)));
    // The sample matrix exercises all three view levels, so the UI can meet each.
    expect(new Set(rules.map((r) => r.view_level))).toEqual(new Set(["full", "status_only", "hidden"]));
  });

  it("makes consignments in different states, with checklist items", async () => {
    await seedDev();
    const all = await db().select().from(consignments);
    expect(new Set(all.map((c) => c.status))).toEqual(
      new Set(["checklist_pending", "checklist_received", "active", "completed", "cancelled"]),
    );
    expect(all).toHaveLength(5);
    // Only the one waiting on core has no checklist yet.
    const withItems = await db().execute<{ consignment_id: string }>(
      sql`select distinct consignment_id from document_checklist_items`,
    );
    expect(withItems.rows).toHaveLength(4);
  });

  it("creates at least two unresolved issues, one open and one correction_requested, plus a resolved one", async () => {
    await seedDev();
    const all = await db().select().from(issues);
    const unresolved = all.filter((i) => i.status !== "resolved");
    expect(unresolved.map((i) => i.status).sort()).toEqual(["correction_requested", "open"]);
    expect(all.filter((i) => i.status === "resolved")).toHaveLength(1);
  });

  it("goes through the real services, so approvals and issues have audit rows", async () => {
    await seedDev();
    const actions = (await db().select().from(audit_log)).map((a) => a.action);
    expect(actions.filter((a) => a === "organization.approved")).toHaveLength(6);
    expect(actions).toEqual(expect.arrayContaining(["issue.raised", "issue.correction_requested", "issue.resolved", "consignment.po_submitted"]));
  });

  it("is idempotent: a second run says so and changes nothing", async () => {
    await seedDev();
    const before = { users: (await db().select().from(users)).length, consignments: (await db().select().from(consignments)).length };
    const lines: string[] = [];
    const second = await seedDev((l) => lines.push(l));
    expect(second.skipped).toBe(true);
    expect(lines.join(" ")).toContain("already present");
    expect((await db().select().from(users)).length).toBe(before.users);
    expect((await db().select().from(consignments)).length).toBe(before.consignments);
  });

  it("produces data the API serves correctly to the sample users", async () => {
    const summary = await seedDev();
    const idOf = async (email: string) => (await db().select().from(users).where(eq(users.email, email)))[0]!.id;
    const importerAdmin = await idOf("admin@importer.sample.veripura.test");
    const alphaAdmin = await idOf("admin@alpha.sample.veripura.test");
    const get = async (id: string) =>
      (await app().inject({ method: "GET", url: "/consignments", headers: { "x-dev-user": id } })).json().consignments as unknown[];

    expect(await get(importerAdmin)).toHaveLength(5);
    expect(await get(alphaAdmin)).toHaveLength(2); // Alpha is the exporter on two of them
    expect(summary.consignments).toHaveLength(5);
  });
});

describe("seedDev safety", () => {
  it("refuses to seed when DATABASE_URL is not local, before it touches anything", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://u:p@db.example.com:5432/production";
    try {
      await expect(seedDev()).rejects.toThrow(/local sandbox/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
    // Nothing was written to the (test) database the shared client is connected to.
    expect(await db().select().from(users)).toHaveLength(0);
    expect(await db().select().from(organizations)).toHaveLength(0);
  });
});

describe("sampleViewLevel", () => {
  it("varies by org type and role, and every combination is defined", () => {
    for (const orgType of ORG_TYPES) {
      for (const role of STANDARD_ROLES) {
        for (const doc of STUB_CHECKLIST_DOCUMENTS) {
          expect(["full", "status_only", "hidden"]).toContain(sampleViewLevel(orgType, role.name, doc.documentTypeName));
        }
      }
    }
    expect(sampleViewLevel("importer", "Compliance User", "Packing List")).toBe("full");
    expect(sampleViewLevel("importer", "Viewer", "Packing List")).toBe("status_only");
    expect(sampleViewLevel("logistics", "Compliance User", "Export Health Certificate")).toBe("hidden");
  });
});

describe("assertLocalDatabase", () => {
  it("accepts a database on this machine", () => {
    expect(() => assertLocalDatabase("postgres://u:p@localhost:5433/veripura")).not.toThrow();
    expect(() => assertLocalDatabase("postgres://u:p@127.0.0.1:5432/x")).not.toThrow();
    expect(() => assertLocalDatabase("postgres://u:p@[::1]:5432/x")).not.toThrow();
  });

  it("refuses anything that is not local, including hosts that merely start with 'localhost'", () => {
    for (const url of [
      "postgres://u:p@db.example.com:5432/x",
      "postgres://u:p@10.0.0.5:5432/x",
      "postgres://u:p@localhost.evil.com:5432/x",
      "postgres://u:p@my-project.supabase.co:5432/postgres",
    ]) {
      expect(() => assertLocalDatabase(url), url).toThrow(/local sandbox/);
    }
    expect(() => assertLocalDatabase(undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertLocalDatabase("not a url")).toThrow(/valid URL/);
  });
});

describe("seedDev vessels", () => {
  it("gives the three live sample consignments the made-up vessels, and no others", async () => {
    await seedDev();
    const rows = await db().select().from(consignments);
    const withVessel = rows.filter((c) => c.vessel_mmsi !== null);
    expect(withVessel.map((c) => c.vessel_mmsi).sort()).toEqual(SAMPLE_VESSELS.map((v) => v.vesselMmsi).sort());
    expect(withVessel.every((c) => !["completed", "cancelled"].includes(c.status))).toBe(true);
    for (const c of withVessel) {
      const v = SAMPLE_VESSELS.find((x) => x.vesselMmsi === c.vessel_mmsi)!;
      expect([c.vessel_imo, c.vessel_name]).toEqual([v.vesselImo, v.vesselName]);
    }
  });
});
