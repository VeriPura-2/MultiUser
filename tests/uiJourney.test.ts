import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { seedDev } from "../src/dev/seedDev.js";
import { buildApp } from "../src/http/app.js";
import { proposeOrganization } from "../src/services/organizations.js";
import { multipartForm } from "./helpers.js";

/**
 * Walks the API the way the UI will, against the seeded sample data, so a seam between the eight
 * UI-1 pieces (dev actor, /me, seed, detail, action queue, issues, admin, PO form) shows up here
 * even if every piece passes its own tests.
 */

const app = buildApp({ actor: { allowDevActorHeader: true } });
type Json = Record<string, any>;

const idOf = async (email: string) => (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
const asUser = (id: string) => ({
  get: async (url: string) => app.inject({ method: "GET", url, headers: { "x-dev-user": id } }),
  // A bare POST with a JSON content type and no body, as a plain fetch from the UI would send.
  post: async (url: string, body?: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: { "x-dev-user": id, "content-type": "application/json" },
      payload: body === undefined ? undefined : (body as object),
    }),
});

describe("the UI journey over the seeded sample data", () => {
  it("lets the dev switcher list users, and each user find out who they are", async () => {
    await seedDev();
    const list = (await app.inject({ method: "GET", url: "/dev/users" })).json().users as Json[];
    expect(list.map((u) => u.email)).toEqual(
      expect.arrayContaining([
        "superadmin@sample.veripura.test",
        "admin@importer.sample.veripura.test",
        "viewer@importer.sample.veripura.test",
        "admin@alpha.sample.veripura.test",
        "admin@logistics.sample.veripura.test",
      ]),
    );

    const me = (await asUser(await idOf("viewer@importer.sample.veripura.test")).get("/me")).json();
    expect(me).toMatchObject({
      name: "Victor Viewer",
      roleNames: ["Viewer"],
      organization: { name: "Sample Importer Ltd", orgType: "importer" },
      isSuperadmin: false,
    });
    expect((await asUser(await idOf("superadmin@sample.veripura.test")).get("/me")).json()).toMatchObject({ isSuperadmin: true, organization: null });
  });

  it("gives an importer admin the dashboard: five consignments, an action queue, and issues that open", async () => {
    await seedDev();
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));

    const list = (await importer.get("/consignments")).json().consignments as Json[];
    expect(list).toHaveLength(5);
    expect(new Set(list.map((c) => c.status))).toEqual(new Set(["checklist_pending", "checklist_received", "active", "completed", "cancelled"]));

    const queue = (await importer.get("/action-queue")).json().items as Json[];
    // Flagged first, and both seeded unresolved issues are there and can be opened.
    const flagged = queue.filter((i) => i.status === "flagged");
    expect(flagged).toHaveLength(2);
    expect(queue.slice(0, 2).every((i) => i.status === "flagged")).toBe(true);
    for (const item of flagged) {
      const issue = await importer.get(`/issues/${item.issueId}`);
      expect(issue.statusCode).toBe(200);
      expect(issue.json().checklistItem.documentTypeName).toBe(item.documentTypeName);
    }
    // Nothing from the completed or cancelled consignments is in the queue.
    const finished = list.filter((c) => c.status === "completed" || c.status === "cancelled").map((c) => c.id);
    expect(queue.some((i) => finished.includes(i.consignmentId))).toBe(false);
  });

  it("works an issue through open, correction requested, resolved, and the queue follows", async () => {
    await seedDev();
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));
    const before = (await importer.get("/action-queue")).json().items as Json[];
    const open = before.find((i) => i.status === "flagged" && i.responsibleOrgType === "exporter")!;
    const detail = (await importer.get(`/issues/${open.issueId}`)).json();
    expect(detail.availableActions).toEqual({ requestCorrection: true, resolve: true });

    const asked = (await importer.post(`/issues/${open.issueId}/request-correction`, { message: "Please reissue." })).json();
    expect(asked.status).toBe("correction_requested");
    expect(asked.activity.at(-1)).toMatchObject({ action: "issue.correction_requested", message: "Please reissue." });

    const resolved = (await importer.post(`/issues/${open.issueId}/resolve`)).json(); // a body-less POST
    expect(resolved).toMatchObject({ status: "resolved", availableActions: { requestCorrection: false, resolve: false } });

    const after = (await importer.get("/action-queue")).json().items as Json[];
    expect(after.filter((i) => i.status === "flagged")).toHaveLength(1);
    expect(after.some((i) => i.issueId === open.issueId)).toBe(false);
  });

  it("shows the exporter its side: what it must upload, and no exporter directory", async () => {
    await seedDev();
    const alpha = asUser(await idOf("admin@alpha.sample.veripura.test"));
    const queue = (await alpha.get("/action-queue")).json().items as Json[];
    const awaiting = queue.filter((i) => i.status === "awaiting_upload");
    expect(awaiting.length).toBeGreaterThan(0);
    // Exporter Alpha sees the exporter-supplied documents as its own to do, and the bill of lading as someone else's.
    expect(awaiting.filter((i) => i.requiredBy === "exporter").every((i) => i.actionableByMyOrg)).toBe(true);
    expect(awaiting.filter((i) => i.requiredBy === "logistics").every((i) => !i.actionableByMyOrg)).toBe(true);
    expect((await alpha.get("/organizations/exporters")).statusCode).toBe(403);
    expect((await alpha.get("/admin/organizations")).statusCode).toBe(403);
  });

  it("seals everything for the importer's Viewer: status only, no issue text, and issues are a 404", async () => {
    await seedDev();
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));
    const viewer = asUser(await idOf("viewer@importer.sample.veripura.test"));
    const consignments = (await importer.get("/consignments")).json().consignments as Json[];
    const received = consignments.find((c) => c.status === "checklist_received")!;

    const checklist = (await viewer.get(`/consignments/${received.id}/checklist`)).json().checklist as Json[];
    expect(checklist).toHaveLength(4);
    for (const item of checklist) {
      expect(Object.keys(item).sort()).toEqual(["canApprove", "canDownload", "canEdit", "checklistItemId", "documentTypeName", "status"]);
    }

    const queue = await viewer.get("/action-queue");
    const items = queue.json().items as Json[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).toMatchObject({ requiredBy: null, issueId: null, responsibleOrgType: null, actionableByMyOrg: false });
    expect(queue.body).not.toContain("carton count");

    const someIssueId = ((await importer.get("/action-queue")).json().items as Json[]).find((i) => i.issueId)!.issueId;
    expect((await viewer.get(`/issues/${someIssueId}`)).statusCode).toBe(404);
    expect((await viewer.post(`/issues/${someIssueId}/resolve`)).statusCode).toBe(404);
  });

  it("keeps the logistics organization, which is not a party to any consignment, out of them all", async () => {
    await seedDev();
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));
    const logistics = asUser(await idOf("admin@logistics.sample.veripura.test"));
    const consignmentId = ((await importer.get("/consignments")).json().consignments as Json[])[0]!.id;

    expect(((await logistics.get("/consignments")).json().consignments as Json[])).toEqual([]);
    for (const path of [`/consignments/${consignmentId}`, `/consignments/${consignmentId}/checklist`]) {
      expect((await logistics.get(path)).statusCode, path).toBe(404);
    }
  });

  it("submits a purchase order from the form, and the new consignment appears everywhere it should", async () => {
    await seedDev();
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));
    const bravo = asUser(await idOf("admin@bravo.sample.veripura.test"));
    const exporters = (await importer.get("/organizations/exporters")).json().organizations as Json[];
    expect(exporters.map((o) => o.name)).toEqual(["Sample Exporter Alpha", "Sample Exporter Bravo", "Sample Exporter Charlie"]);

    const { payload, contentType } = multipartForm(
      { exporterOrgId: exporters.find((o) => o.name === "Sample Exporter Bravo")!.id, commodity: "Chilled lamb", originCountry: "BR", destinationCountry: "GB" },
      { name: "po-2001.pdf", content: Buffer.from("%PDF-1.4 sample") },
    );
    const created = await app.inject({
      method: "POST",
      url: "/consignments",
      headers: { "x-dev-user": (await idOf("admin@importer.sample.veripura.test")), "content-type": contentType },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().consignment.id;

    expect((await importer.get(`/consignments/${id}`)).json()).toMatchObject({ commodity: "Chilled lamb", status: "checklist_received" });
    expect(((await importer.get("/consignments")).json().consignments as Json[])).toHaveLength(6);
    expect(((await bravo.get("/consignments")).json().consignments as Json[]).map((c) => c.id)).toContain(id);
    // The new consignment's documents are in the exporter's queue.
    expect(((await bravo.get("/action-queue")).json().items as Json[]).some((i) => i.consignmentId === id)).toBe(true);
  });

  it("lets the superadmin approve a new organization, which then appears for importers to choose", async () => {
    await seedDev();
    const superadmin = asUser(await idOf("superadmin@sample.veripura.test"));
    const importer = asUser(await idOf("admin@importer.sample.veripura.test"));
    const { organization } = await proposeOrganization("Delta Exports", "exporter", "applicant@delta.example.test");

    const pending = (await superadmin.get("/admin/organizations?status=pending_approval")).json().organizations as Json[];
    expect(pending.map((o) => o.name)).toEqual(["Delta Exports"]);
    const detail = (await superadmin.get(`/admin/organizations/${organization.id}`)).json();
    // The seeded matrix means the exporter defaults are configured, and the five standard roles are shown.
    expect(detail.roles).toHaveLength(5);
    expect(detail.roles[0].permissions.every((p: Json) => p.configured)).toBe(true);

    expect((await superadmin.post(`/admin/organizations/${organization.id}/approve`)).json().status).toBe("active");
    const exporters = (await importer.get("/organizations/exporters")).json().organizations as Json[];
    expect(exporters.map((o) => o.name)).toContain("Delta Exports");
    expect(((await superadmin.get("/admin/organizations?status=pending_approval")).json().organizations as Json[])).toEqual([]);
  });
});
