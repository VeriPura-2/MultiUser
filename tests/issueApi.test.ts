import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordAudit } from "../src/audit/recordAudit.js";
import { getDb } from "../src/db/client.js";
import { audit_log, document_checklist_items, issues, users } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { raiseIssue, requestCorrection, resolveIssue } from "../src/services/issues.js";
import {
  createActiveOrg,
  createSuperadmin,
  createUserWithRoles,
  scenario,
  setRule,
  type Scenario,
} from "./helpers.js";

const db = () => getDb();
const app = buildApp({ actor: { allowDevActorHeader: true } });

type Json = Record<string, any>;
const call = (method: "GET" | "POST", url: string, actorId?: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { ...(actorId ? { "x-dev-user": actorId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body === undefined ? undefined : (body as object),
  });
const issueOf = async (s: Scenario, itemId: string, extra: Record<string, unknown> = {}) =>
  raiseIssue({
    documentChecklistItemId: itemId,
    problem: "Exporter name does not match the invoice",
    expectedValue: "Acme Trading GmbH",
    foundValue: "Acme Trading S.A.",
    responsibleOrgType: "exporter",
    actingUser: s.importerAdmin,
    ...extra,
  });
const auditFor = (issueId: string) => db().select().from(audit_log).where(eq(audit_log.target_id, issueId));
const itemStatus = async (id: string) =>
  (await db().select().from(document_checklist_items).where(eq(document_checklist_items.id, id)))[0]!.status;

describe("GET /issues/:issueId", () => {
  it("returns the documented fields for both parties and for superadmin", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id, { sourceChecklistItemId: s.invoice.item.id });
    const superadmin = await createSuperadmin();

    for (const actor of [s.importerAdmin, s.exporterAdmin, superadmin]) {
      const res = await call("GET", `/issues/${issue.id}`, actor.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: issue.id,
        consignmentId: s.consignment.id,
        status: "open",
        problem: "Exporter name does not match the invoice",
        expectedValue: "Acme Trading GmbH",
        foundValue: "Acme Trading S.A.",
        responsibleOrgType: "exporter",
        responsibleOrgName: s.parties.exporter.org.name,
        checklistItem: { id: s.cert.item.id, documentTypeName: "Export Health Certificate", category: null, requiredBy: "exporter" },
        sourceDocumentTypeName: "Commercial Invoice",
        resolvedAt: null,
        availableActions: { requestCorrection: true, resolve: true },
      });
    }
  });

  it("names the responsible organization by type, and gives null when it is neither party", async () => {
    const s = await scenario();
    const toImporter = await issueOf(s, s.packing.item.id, { responsibleOrgType: "importer" });
    const toLogistics = await issueOf(s, s.bol.item.id, { responsibleOrgType: "logistics" });
    expect((await call("GET", `/issues/${toImporter.id}`, s.importerAdmin.id)).json().responsibleOrgName).toBe(s.parties.importer.org.name);
    expect((await call("GET", `/issues/${toLogistics.id}`, s.importerAdmin.id)).json().responsibleOrgName).toBeNull();
  });

  it("returns a null source name when there is no source, and when the source is hidden from the viewer", async () => {
    const s = await scenario();
    await setRule(s.invoice.type, "exporter", "Compliance User", { view: "hidden" });
    await setRule(s.packing.type, "exporter", "Compliance User", { view: "full" });
    await setRule(s.cert.type, "exporter", "Compliance User", { view: "full" });
    await setRule(s.bol.type, "exporter", "Compliance User", { view: "status_only" });
    const user = await createUserWithRoles(s.parties.exporter, ["Compliance User"]);

    const noSource = await issueOf(s, s.packing.item.id);
    const hiddenSource = await issueOf(s, s.cert.item.id, { sourceChecklistItemId: s.invoice.item.id });
    const visibleSource = await issueOf(s, s.cert.item.id, { sourceChecklistItemId: s.bol.item.id }); // status_only: nameable

    expect((await call("GET", `/issues/${noSource.id}`, user.id)).json().sourceDocumentTypeName).toBeNull();
    const hidden = await call("GET", `/issues/${hiddenSource.id}`, user.id);
    expect(hidden.json().sourceDocumentTypeName).toBeNull();
    expect(hidden.body).not.toContain("Commercial Invoice");
    expect((await call("GET", `/issues/${visibleSource.id}`, user.id)).json().sourceDocumentTypeName).toBe("Bill of Lading");
  });

  it("is a 404 when the parent item is status_only or hidden for that user, identical to a missing issue", async () => {
    const s = await scenario();
    await setRule(s.bol.type, "exporter", "Viewer", { view: "status_only" });
    await setRule(s.cert.type, "exporter", "Viewer", { view: "hidden" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    const onStatusOnly = await issueOf(s, s.bol.item.id, { problem: "Secret bol problem" });
    const onHidden = await issueOf(s, s.cert.item.id, { problem: "Secret cert problem" });

    const missing = await call("GET", "/issues/00000000-0000-4000-8000-000000000000", viewer.id);
    for (const issue of [onStatusOnly, onHidden]) {
      const res = await call("GET", `/issues/${issue.id}`, viewer.id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(missing.json());
      expect(res.body).not.toMatch(/Secret/);
    }
    // A colleague with full view of the same documents can still read them.
    expect((await call("GET", `/issues/${onStatusOnly.id}`, s.exporterAdmin.id)).statusCode).toBe(200);
  });

  it("is a 404 for a user who is not a party, for a malformed id, and 401 without a user", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    const stranger = await createActiveOrg("importer");
    expect((await call("GET", `/issues/${issue.id}`, stranger.admin.id)).statusCode).toBe(404);
    expect((await call("GET", "/issues/not-a-uuid", s.importerAdmin.id)).statusCode).toBe(404);
    expect((await call("GET", `/issues/${issue.id}`)).statusCode).toBe(401);
  });

  it("is 403 for an inactive user", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    const inactive = await createUserWithRoles(s.parties.importer, ["Viewer"]);
    await db().update(users).set({ status: "deactivated" }).where(eq(users.id, inactive.id));
    expect((await call("GET", `/issues/${issue.id}`, inactive.id)).statusCode).toBe(403);
  });

  it("builds the activity list from the audit trail, oldest first, with readable actors and the correction message", async () => {
    const s = await scenario();
    await db().update(users).set({ name: "Ivy Importer" }).where(eq(users.id, s.importerAdmin.id));
    const issue = await issueOf(s, s.cert.item.id);
    await requestCorrection({ issueId: issue.id, message: "Please reissue with the invoice name", actingUser: s.importerAdmin });
    await recordAudit({ actorUser: null, action: "issue.system_note", targetType: "issue", targetId: issue.id });
    await resolveIssue({ issueId: issue.id, actingUser: s.exporterAdmin }); // exporter admin has no name

    const asImporter = (await call("GET", `/issues/${issue.id}`, s.importerAdmin.id)).json();
    expect(asImporter.activity.map((a: Json) => a.action)).toEqual([
      "issue.raised",
      "issue.correction_requested",
      "issue.system_note",
      "issue.resolved",
    ]);
    expect(asImporter.activity.map((a: Json) => a.actor)).toEqual([
      "Ivy Importer",
      "Ivy Importer",
      "System",
      `A user at ${s.parties.exporter.org.name}`, // the other party's unnamed user: no email is shared
    ]);
    expect(asImporter.activity[1].message).toBe("Please reissue with the invoice name");
    expect(asImporter.activity[0]).not.toHaveProperty("message");
    expect(asImporter.activity.every((a: Json) => typeof a.createdAt === "string")).toBe(true);
    expect(JSON.stringify(asImporter)).not.toContain(s.exporterAdmin.email);

    // A colleague in the same org may see their own unnamed teammate's email.
    const asExporter = (await call("GET", `/issues/${issue.id}`, s.exporterAdmin.id)).json();
    expect(asExporter.activity[3].actor).toBe(s.exporterAdmin.email);
    expect(asExporter.activity[0].actor).toBe("Ivy Importer"); // named users show by name to both parties
  });

  it("shows a superadmin actor as VeriPura when they have no name", async () => {
    const s = await scenario();
    const superadmin = await createSuperadmin();
    const issue = await raiseIssue({ documentChecklistItemId: s.cert.item.id, problem: "raised by superadmin", responsibleOrgType: "exporter", actingUser: superadmin });
    expect((await call("GET", `/issues/${issue.id}`, s.importerAdmin.id)).json().activity[0].actor).toBe("VeriPura");
  });

  it("offers no actions once resolved", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    await resolveIssue({ issueId: issue.id, actingUser: s.importerAdmin });
    const body = (await call("GET", `/issues/${issue.id}`, s.importerAdmin.id)).json();
    expect(body.status).toBe("resolved");
    expect(body.resolvedAt).toEqual(expect.any(String));
    expect(body.availableActions).toEqual({ requestCorrection: false, resolve: false });
  });
});

describe("POST /issues/:issueId/request-correction", () => {
  it("moves the issue to correction_requested, records the message, and returns the refreshed issue", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);

    const res = await call("POST", `/issues/${issue.id}/request-correction`, s.importerAdmin.id, { message: "Please fix it" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: issue.id, status: "correction_requested" });
    expect(res.json().activity.at(-1)).toMatchObject({ action: "issue.correction_requested", message: "Please fix it" });

    const row = (await auditFor(issue.id)).find((a) => a.action === "issue.correction_requested")!;
    expect(row).toMatchObject({ actor_user_id: s.importerAdmin.id, target_type: "issue" });
    expect(row.metadata).toMatchObject({ message: "Please fix it", previous_status: "open" });
  });

  it("rejects a missing or blank message (400), an unauthenticated call (401), and a resolved issue (400)", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    const url = `/issues/${issue.id}/request-correction`;
    expect((await call("POST", url, s.importerAdmin.id, {})).statusCode).toBe(400);
    expect((await call("POST", url, s.importerAdmin.id, { message: "   " })).statusCode).toBe(400);
    expect((await call("POST", url, undefined, { message: "x" })).statusCode).toBe(401);
    await resolveIssue({ issueId: issue.id, actingUser: s.importerAdmin });
    expect((await call("POST", url, s.importerAdmin.id, { message: "too late" })).statusCode).toBe(400);
  });

  it("is a 404, changes nothing, and writes no audit row for a status_only viewer or a stranger", async () => {
    const s = await scenario();
    await setRule(s.cert.type, "exporter", "Viewer", { view: "status_only" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    const stranger = await createActiveOrg("exporter");
    const issue = await issueOf(s, s.cert.item.id);
    const auditBefore = (await auditFor(issue.id)).length;

    for (const actor of [viewer, stranger.admin]) {
      expect((await call("POST", `/issues/${issue.id}/request-correction`, actor.id, { message: "sneaky" })).statusCode).toBe(404);
    }
    expect((await db().select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("open");
    expect(await auditFor(issue.id)).toHaveLength(auditBefore);
  });
});

describe("POST /issues/:issueId/resolve", () => {
  it("resolves, returns the item to pending, and writes issue.resolved with the acting user", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    expect(await itemStatus(s.cert.item.id)).toBe("flagged");

    const res = await call("POST", `/issues/${issue.id}/resolve`, s.exporterAdmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "resolved", availableActions: { requestCorrection: false, resolve: false } });
    expect(await itemStatus(s.cert.item.id)).toBe("pending");

    const row = (await auditFor(issue.id)).find((a) => a.action === "issue.resolved")!;
    expect(row).toMatchObject({ actor_user_id: s.exporterAdmin.id, target_type: "issue" });
  });

  it("refuses a second resolve (400) without a second audit row, and is 401 unauthenticated", async () => {
    const s = await scenario();
    const issue = await issueOf(s, s.cert.item.id);
    expect((await call("POST", `/issues/${issue.id}/resolve`)).statusCode).toBe(401);
    expect((await call("POST", `/issues/${issue.id}/resolve`, s.importerAdmin.id)).statusCode).toBe(200);
    expect((await call("POST", `/issues/${issue.id}/resolve`, s.importerAdmin.id)).statusCode).toBe(400);
    expect((await auditFor(issue.id)).filter((a) => a.action === "issue.resolved")).toHaveLength(1);
  });

  it("is a 404 with no change for a hidden-document viewer or a stranger", async () => {
    const s = await scenario();
    await setRule(s.cert.type, "exporter", "Viewer", { view: "hidden" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    const stranger = await createActiveOrg("importer");
    const issue = await issueOf(s, s.cert.item.id);

    for (const actor of [viewer, stranger.admin]) {
      expect((await call("POST", `/issues/${issue.id}/resolve`, actor.id)).statusCode).toBe(404);
    }
    expect((await db().select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("open");
    expect(await itemStatus(s.cert.item.id)).toBe("flagged");
  });
});

describe("POST /consignments/:consignmentId/checklist/:itemId/issues", () => {
  const url = (s: Scenario, itemId: string) => `/consignments/${s.consignment.id}/checklist/${itemId}/issues`;
  const body = { problem: "Quantity does not match", expectedValue: "480", foundValue: "460", responsibleOrgType: "exporter" };

  it("raises an issue (201), flags the item, writes issue.raised, and returns the issue", async () => {
    const s = await scenario();
    const res = await call("POST", url(s, s.packing.item.id), s.importerAdmin.id, { ...body, sourceChecklistItemId: s.invoice.item.id });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({
      status: "open",
      problem: "Quantity does not match",
      expectedValue: "480",
      foundValue: "460",
      responsibleOrgType: "exporter",
      sourceDocumentTypeName: "Commercial Invoice",
      checklistItem: { id: s.packing.item.id, documentTypeName: "Packing List" },
    });
    expect(await itemStatus(s.packing.item.id)).toBe("flagged");

    const row = (await auditFor(created.id)).find((a) => a.action === "issue.raised")!;
    expect(row).toMatchObject({ actor_user_id: s.importerAdmin.id, target_type: "issue" });
    expect(row.metadata).toMatchObject({ consignment_id: s.consignment.id, document_checklist_item_id: s.packing.item.id });
  });

  it("validates the body: problem required, responsibleOrgType must be a real type, non-object bodies refused", async () => {
    const s = await scenario();
    const u = url(s, s.packing.item.id);
    expect((await call("POST", u, s.importerAdmin.id, { ...body, problem: "" })).statusCode).toBe(400);
    expect((await call("POST", u, s.importerAdmin.id, { ...body, responsibleOrgType: "farmer" })).statusCode).toBe(400);
    expect((await call("POST", u, s.importerAdmin.id, { problem: "x" })).statusCode).toBe(400);
    expect((await call("POST", u, s.importerAdmin.id, { ...body, expectedValue: 5 })).statusCode).toBe(400);
    expect((await call("POST", u, s.importerAdmin.id, ["nope"])).statusCode).toBe(400);
    expect(await db().select().from(issues)).toHaveLength(0);
  });

  it("is 401 without a user, and a 404 for an item that is not on that consignment or a malformed id", async () => {
    const s = await scenario();
    const other = await scenario();
    expect((await call("POST", url(s, s.packing.item.id), undefined, body)).statusCode).toBe(401);
    expect((await call("POST", url(s, other.packing.item.id), s.importerAdmin.id, body)).statusCode).toBe(404);
    expect((await call("POST", `/consignments/${s.consignment.id}/checklist/nope/issues`, s.importerAdmin.id, body)).statusCode).toBe(404);
    expect((await call("POST", `/consignments/nope/checklist/${s.packing.item.id}/issues`, s.importerAdmin.id, body)).statusCode).toBe(404);
  });

  it("is a 404 and creates nothing for a stranger, and for a viewer whose role sees the item as status_only or hidden", async () => {
    const s = await scenario();
    await setRule(s.bol.type, "exporter", "Viewer", { view: "status_only" });
    await setRule(s.cert.type, "exporter", "Viewer", { view: "hidden" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    const stranger = await createActiveOrg("importer");

    expect((await call("POST", url(s, s.bol.item.id), viewer.id, body)).statusCode).toBe(404);
    expect((await call("POST", url(s, s.cert.item.id), viewer.id, body)).statusCode).toBe(404);
    expect((await call("POST", url(s, s.packing.item.id), stranger.admin.id, body)).statusCode).toBe(404);
    expect(await db().select().from(issues)).toHaveLength(0);
    expect(await itemStatus(s.bol.item.id)).toBe("awaiting_upload");
  });

  it("refuses a source document from another consignment (400) without creating anything", async () => {
    const s = await scenario();
    const other = await scenario();
    const res = await call("POST", url(s, s.packing.item.id), s.importerAdmin.id, { ...body, sourceChecklistItemId: other.invoice.item.id });
    expect(res.statusCode).toBe(400);
    expect(await db().select().from(issues)).toHaveLength(0);
  });
});

describe("the issue endpoints and the checklist agree", () => {
  it("an issue raised through the API shows up as openIssue in the checklist and in the action queue", async () => {
    const s = await scenario();
    const created = (
      await call("POST", `/consignments/${s.consignment.id}/checklist/${s.cert.item.id}/issues`, s.importerAdmin.id, {
        problem: "End to end",
        responsibleOrgType: "exporter",
      })
    ).json();

    const checklist = (await call("GET", `/consignments/${s.consignment.id}/checklist`, s.exporterAdmin.id)).json().checklist as Json[];
    expect(checklist.find((i) => i.documentTypeName === "Export Health Certificate")!.openIssue).toMatchObject({ problem: "End to end" });
    const queue = (await call("GET", "/action-queue", s.exporterAdmin.id)).json().items as Json[];
    expect(queue.find((i) => i.issueId === created.id)).toMatchObject({ status: "flagged", actionableByMyOrg: true });
  });
});
