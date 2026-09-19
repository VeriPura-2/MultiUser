import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { consignments, document_checklist_items, document_types, users, type DocumentType } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { createPermissionResolver, resolveDocumentPermissions } from "../src/permissions/engine.js";
import { raiseIssue, requestCorrection, resolveIssue } from "../src/services/issues.js";
import type { StandardRoleName } from "../src/roles.js";
import {
  checklistItemsOf,
  createActiveOrg,
  createDocumentType,
  createSuperadmin,
  createTradeParties,
  createUserWithRoles,
  setRule,
  submitTestPO,
  type TradeParties,
} from "./helpers.js";

const db = () => getDb();
const app = buildApp({ purchaseOrders: { allowDevActorHeader: true } });

const get = (url: string, actorId?: string) =>
  app.inject({ method: "GET", url, headers: actorId ? { "x-acting-user-id": actorId } : {} });

type Json = Record<string, any>;
const checklistOf = async (consignmentId: string, actorId: string) => {
  const res = await get(`/consignments/${consignmentId}/checklist`, actorId);
  expect(res.statusCode).toBe(200);
  return res.json() as { consignmentId: string; consignmentStatus: string; checklist: Json[] };
};
const listFor = async (actorId: string) => (await get("/consignments", actorId)).json().consignments as Json[];
const workloadFor = async (actorId: string, query = "") => {
  const res = await get(`/parties/workload${query}`, actorId);
  return { status: res.statusCode, body: res.json() as Json };
};

/** A consignment carrying the stub's four checklist documents, addressable by name. */
async function world(parties?: TradeParties, overrides: Parameters<typeof submitTestPO>[1] = {}) {
  const p = parties ?? (await createTradeParties());
  const consignment = await submitTestPO(p, overrides);
  const items = await checklistItemsOf(consignment);
  const types = await db().select().from(document_types);
  const doc = (name: string) => {
    const type = types.find((t) => t.name === name)!;
    return { type, item: items.find((i) => i.document_type_id === type.id)! };
  };
  return {
    parties: p,
    consignment,
    invoice: doc("Commercial Invoice"),
    packing: doc("Packing List"),
    bol: doc("Bill of Lading"),
    cert: doc("Export Health Certificate"),
    importerAdmin: p.importer.admin,
    exporterAdmin: p.exporter.admin,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const setItemStatus = (itemId: string, status: "awaiting_upload" | "pending" | "verified" | "flagged") =>
  db().update(document_checklist_items).set({ status }).where(eq(document_checklist_items.id, itemId));

const raise = (w: World, itemId: string, problem = "Mismatch", extra: Record<string, unknown> = {}) =>
  raiseIssue({
    documentChecklistItemId: itemId,
    problem,
    responsibleOrgType: "exporter",
    actingUser: w.importerAdmin,
    ...extra,
  });

/** Sets one rule for the exporter org's Compliance User role. */
const exporterRule = (type: DocumentType, view: "full" | "status_only" | "hidden", grants: { download?: boolean } = {}) =>
  setRule(type, "exporter", "Compliance User", { view, ...grants });

describe("authentication and access", () => {
  it("returns 401 for all three endpoints when there is no acting user", async () => {
    const w = await world();
    for (const url of ["/consignments", `/consignments/${w.consignment.id}/checklist`, "/parties/workload"]) {
      expect((await get(url)).statusCode).toBe(401);
    }
    // ...and when the dev header is not enabled, even with a real user id.
    const locked = buildApp();
    const res = await locked.inject({ method: "GET", url: "/consignments", headers: { "x-acting-user-id": w.importerAdmin.id } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses users who are not active (403) on all three endpoints, before looking anything up", async () => {
    const w = await world();
    const invited = await createUserWithRoles(w.parties.importer, ["Viewer"]);
    const deactivated = await createUserWithRoles(w.parties.exporter, ["Viewer"]);
    await db().update(users).set({ status: "invited" }).where(eq(users.id, invited.id));
    await db().update(users).set({ status: "deactivated" }).where(eq(users.id, deactivated.id));

    for (const user of [invited, deactivated]) {
      for (const url of ["/consignments", `/consignments/${w.consignment.id}/checklist`, "/parties/workload"]) {
        expect((await get(url, user.id)).statusCode, `${user.status} on ${url}`).toBe(403);
      }
    }
  });
});

describe("GET /consignments/:consignmentId/checklist", () => {
  it("returns the documented envelope, and full items carry every field including the resolved permissions", async () => {
    const w = await world();
    await db().update(document_types).set({ category: "Customs & logistics" }).where(eq(document_types.id, w.packing.type.id));
    await exporterRule(w.packing.type, "full", { download: true });
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);

    const body = await checklistOf(w.consignment.id, user.id);
    expect(body.consignmentId).toBe(w.consignment.id);
    expect(body.consignmentStatus).toBe("checklist_received");
    expect(body.checklist).toHaveLength(4);
    expect(body.checklist.find((i) => i.documentTypeName === "Packing List")).toEqual({
      checklistItemId: w.packing.item.id,
      documentTypeName: "Packing List",
      requiredBy: "exporter",
      status: "awaiting_upload",
      category: "Customs & logistics",
      canEdit: false,
      canDownload: true,
      canApprove: false,
      openIssue: null,
    });
  });

  it("status_only item: status but no requiredBy, category, or issue detail, even when an issue exists; a full item alongside returns everything", async () => {
    const w = await world();
    await exporterRule(w.bol.type, "status_only");
    await exporterRule(w.packing.type, "full", { download: true });
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    // Issues on both, so we can prove the status_only one stays sealed.
    await raise(w, w.bol.item.id, "Bill of lading vessel name is wrong", { expectedValue: "MV Aurora", foundValue: "MV Aurore" });
    await raise(w, w.packing.item.id, "Carton count mismatch", {
      expectedValue: "480",
      foundValue: "460",
      sourceChecklistItemId: w.invoice.item.id,
    });

    const { checklist } = await checklistOf(w.consignment.id, user.id);

    const bol = checklist.find((i) => i.documentTypeName === "Bill of Lading")!;
    expect(bol).toEqual({
      checklistItemId: w.bol.item.id,
      documentTypeName: "Bill of Lading",
      status: "flagged", // the viewer learns something is wrong only through the status
      canEdit: false,
      canDownload: false,
      canApprove: false,
    });
    for (const key of ["requiredBy", "category", "openIssue"]) expect(bol).not.toHaveProperty(key);
    expect(JSON.stringify(bol)).not.toMatch(/vessel|Aurora|Aurore/);

    const packing = checklist.find((i) => i.documentTypeName === "Packing List")!;
    expect(packing).toMatchObject({
      requiredBy: "exporter",
      status: "flagged",
      canDownload: true,
      openIssue: {
        problem: "Carton count mismatch",
        expectedValue: "480",
        foundValue: "460",
        responsibleOrgType: "exporter",
        status: "open",
        sourceDocumentTypeName: "Commercial Invoice",
      },
    });
  });

  it("a hidden item is absent from the checklist array entirely, and nowhere in the response", async () => {
    const w = await world();
    await exporterRule(w.cert.type, "hidden");
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    await raise(w, w.cert.item.id, "Certificate signed by the wrong vet");

    const res = await get(`/consignments/${w.consignment.id}/checklist`, user.id);
    const body = res.json();
    expect(body.checklist.map((i: Json) => i.documentTypeName).sort()).toEqual(["Bill of Lading", "Commercial Invoice", "Packing List"]);
    expect(res.body).not.toMatch(/Export Health Certificate|wrong vet|checklistItemId":"${w.cert.item.id}/);
    expect(res.body).not.toContain(w.cert.item.id);
  });

  it("superadmin sees every item at full visibility with full issue detail, whatever the rules say", async () => {
    const w = await world();
    for (const role of ["Organization Admin", "Compliance Manager", "Compliance User", "Reviewer", "Viewer"] as StandardRoleName[]) {
      for (const orgType of ["importer", "exporter"] as const) {
        await setRule(w.bol.type, orgType, role, { view: "hidden" });
        await setRule(w.cert.type, orgType, role, { view: "status_only" });
      }
    }
    await raise(w, w.bol.item.id, "Hidden-to-everyone item has an issue", { sourceChecklistItemId: w.invoice.item.id });
    const superadmin = await createSuperadmin();

    const { checklist } = await checklistOf(w.consignment.id, superadmin.id);
    expect(checklist).toHaveLength(4);
    for (const item of checklist) {
      expect(item).toMatchObject({ canEdit: true, canDownload: true, canApprove: true });
      expect(item).toHaveProperty("requiredBy");
      expect(item).toHaveProperty("openIssue");
    }
    expect(checklist.find((i) => i.documentTypeName === "Bill of Lading")!.openIssue).toMatchObject({
      problem: "Hidden-to-everyone item has an issue",
      sourceDocumentTypeName: "Commercial Invoice",
    });
  });

  it("a user from an unrelated third org gets 404, the same as for a consignment that does not exist", async () => {
    const w = await world();
    const stranger = await createActiveOrg("importer");
    const logistics = await createActiveOrg("logistics"); // even a real participant that is not a party

    const real = await get(`/consignments/${w.consignment.id}/checklist`, stranger.admin.id);
    const missing = await get("/consignments/00000000-0000-4000-8000-000000000000/checklist", stranger.admin.id);
    expect(real.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(real.json()).toEqual(missing.json()); // no way to tell the two apart
    expect((await get(`/consignments/${w.consignment.id}/checklist`, logistics.admin.id)).statusCode).toBe(404);
    expect((await get("/consignments/not-a-uuid/checklist", stranger.admin.id)).statusCode).toBe(404);
  });

  it("both parties, and only they, can read it: importer and exporter users each get 200", async () => {
    const w = await world();
    expect((await get(`/consignments/${w.consignment.id}/checklist`, w.importerAdmin.id)).statusCode).toBe(200);
    expect((await get(`/consignments/${w.consignment.id}/checklist`, w.exporterAdmin.id)).statusCode).toBe(200);
  });

  it("a resolved issue is not shown as openIssue; a correction_requested one is, with its status", async () => {
    const w = await world();
    const superadmin = await createSuperadmin();
    const resolved = await raise(w, w.packing.item.id, "Old problem");
    await resolveIssue({ issueId: resolved.id, actingUser: w.importerAdmin });
    const pending = await raise(w, w.cert.item.id, "Needs a fix");
    await requestCorrection({ issueId: pending.id, message: "please fix", actingUser: w.importerAdmin });

    const { checklist } = await checklistOf(w.consignment.id, superadmin.id);
    const packing = checklist.find((i) => i.documentTypeName === "Packing List")!;
    expect(packing.openIssue).toBeNull();
    expect(packing.status).toBe("pending"); // back for re-verification, not verified
    expect(checklist.find((i) => i.documentTypeName === "Export Health Certificate")!.openIssue).toMatchObject({
      problem: "Needs a fix",
      status: "correction_requested",
    });
  });

  it("with several unresolved issues on one item it shows the longest-standing one", async () => {
    const w = await world();
    const superadmin = await createSuperadmin();
    await raise(w, w.packing.item.id, "First problem");
    await raise(w, w.packing.item.id, "Second problem");

    const { checklist } = await checklistOf(w.consignment.id, superadmin.id);
    expect(checklist.find((i) => i.documentTypeName === "Packing List")!.openIssue!.problem).toBe("First problem");
  });

  describe("naming the source document of an issue", () => {
    it("omits it when the issue has no source document", async () => {
      const w = await world();
      const superadmin = await createSuperadmin();
      await raise(w, w.packing.item.id, "No source");
      const { checklist } = await checklistOf(w.consignment.id, superadmin.id);
      expect(checklist.find((i) => i.documentTypeName === "Packing List")!.openIssue).not.toHaveProperty("sourceDocumentTypeName");
    });

    it("omits it when the source document is hidden from the viewer, so its existence is not revealed", async () => {
      const w = await world();
      await exporterRule(w.packing.type, "full");
      await exporterRule(w.invoice.type, "hidden");
      const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
      await raise(w, w.packing.item.id, "Quantity differs", { sourceChecklistItemId: w.invoice.item.id });

      const res = await get(`/consignments/${w.consignment.id}/checklist`, user.id);
      const packing = res.json().checklist.find((i: Json) => i.documentTypeName === "Packing List");
      expect(packing.openIssue).toMatchObject({ problem: "Quantity differs" });
      expect(packing.openIssue).not.toHaveProperty("sourceDocumentTypeName");
      expect(res.body).not.toContain("Commercial Invoice");
    });

    it("names it when the source is only status_only, since the viewer already sees that item's name", async () => {
      const w = await world();
      await exporterRule(w.packing.type, "full");
      await exporterRule(w.invoice.type, "status_only");
      const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
      await raise(w, w.packing.item.id, "Quantity differs", { sourceChecklistItemId: w.invoice.item.id });

      const { checklist } = await checklistOf(w.consignment.id, user.id);
      expect(checklist.find((i) => i.documentTypeName === "Packing List")!.openIssue.sourceDocumentTypeName).toBe("Commercial Invoice");
    });
  });

  it("uses the merged permission when a user holds two roles (full+approve beats hidden)", async () => {
    const w = await world();
    await setRule(w.bol.type, "exporter", "Compliance Manager", { view: "full", approve: true });
    await setRule(w.bol.type, "exporter", "Viewer", { view: "hidden" });
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance Manager", "Viewer"]);

    const { checklist } = await checklistOf(w.consignment.id, user.id);
    expect(checklist.find((i) => i.documentTypeName === "Bill of Lading")).toMatchObject({ canApprove: true, canEdit: false });
  });

  it("with no rules configured, everything is visible in full but nothing is editable, downloadable, or approvable", async () => {
    const w = await world();
    const user = await createUserWithRoles(w.parties.importer, ["Reviewer"]);
    const { checklist } = await checklistOf(w.consignment.id, user.id);
    expect(checklist).toHaveLength(4);
    for (const item of checklist) expect(item).toMatchObject({ canEdit: false, canDownload: false, canApprove: false });
  });

  it("lists items in a stable order", async () => {
    const w = await world();
    const superadmin = await createSuperadmin();
    const first = (await checklistOf(w.consignment.id, superadmin.id)).checklist.map((i) => i.checklistItemId);
    const second = (await checklistOf(w.consignment.id, superadmin.id)).checklist.map((i) => i.checklistItemId);
    expect(first).toEqual(second);
  });
});

describe("GET /consignments", () => {
  it("returns only consignments where the viewer's org is a party, each with the counterpart's name", async () => {
    const parties = await createTradeParties();
    const other = await createTradeParties();
    const mine = await world(parties, { commodity: "Frozen beef" });
    await world(other, { commodity: "Frozen pork" }); // someone else's

    const asImporter = await listFor(parties.importer.admin.id);
    expect(asImporter.map((c) => c.id)).toEqual([mine.consignment.id]);
    expect(asImporter[0]).toMatchObject({
      commodity: "Frozen beef",
      status: "checklist_received",
      counterpartOrgName: parties.exporter.org.name,
      importerOrgName: parties.importer.org.name,
      exporterOrgName: parties.exporter.org.name,
    });

    const asExporter = await listFor(parties.exporter.admin.id);
    expect(asExporter.map((c) => c.id)).toEqual([mine.consignment.id]);
    expect(asExporter[0]!.counterpartOrgName).toBe(parties.importer.org.name);
  });

  it("returns every consignment to superadmin, with no counterpart side", async () => {
    const a = await world();
    const b = await world();
    const superadmin = await createSuperadmin();
    const list = await listFor(superadmin.id);
    expect(list.map((c) => c.id).sort()).toEqual([a.consignment.id, b.consignment.id].sort());
    expect(list.every((c) => c.counterpartOrgName === null)).toBe(true);
  });

  it("returns an empty list for an org with no consignments", async () => {
    const lonely = await createActiveOrg("importer");
    expect(await listFor(lonely.admin.id)).toEqual([]);
  });

  it("lists newest first", async () => {
    const parties = await createTradeParties();
    const first = await world(parties, { commodity: "First" });
    const second = await world(parties, { commodity: "Second" });
    // created_at ties within a millisecond are possible, so pin them.
    await db().update(consignments).set({ created_at: new Date("2026-01-01") }).where(eq(consignments.id, first.consignment.id));
    await db().update(consignments).set({ created_at: new Date("2026-02-01") }).where(eq(consignments.id, second.consignment.id));
    expect((await listFor(parties.importer.admin.id)).map((c) => c.commodity)).toEqual(["Second", "First"]);
  });

  it("completeness is verified over visible items, and its total equals the length of the checklist endpoint's array", async () => {
    const w = await world();
    await exporterRule(w.cert.type, "hidden");
    await exporterRule(w.bol.type, "status_only");
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    await setItemStatus(w.invoice.item.id, "verified");
    await setItemStatus(w.bol.item.id, "verified"); // status_only still counts: the viewer can see it
    await setItemStatus(w.cert.item.id, "verified"); // hidden: must not count

    const [summary] = await listFor(user.id);
    const { checklist } = await checklistOf(w.consignment.id, user.id);
    expect(summary!.checklistCompleteness).toEqual({ verified: 2, total: 3 });
    expect(summary!.checklistCompleteness.total).toBe(checklist.length);
    expect(checklist.filter((i) => i.status === "verified")).toHaveLength(summary!.checklistCompleteness.verified);

    // A viewer without the hidden rule sees the whole picture.
    const importerSummary = (await listFor(w.parties.importer.admin.id))[0]!;
    expect(importerSummary.checklistCompleteness).toEqual({ verified: 3, total: 4 });
  });

  it("openIssueCount counts only full-view items: hidden and status_only issues do not count", async () => {
    const w = await world();
    await exporterRule(w.cert.type, "hidden");
    await exporterRule(w.bol.type, "status_only");
    await exporterRule(w.packing.type, "full");
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    await raise(w, w.cert.item.id, "hidden item issue");
    await raise(w, w.bol.item.id, "status_only item issue");
    await raise(w, w.packing.item.id, "full item issue");
    await raise(w, w.invoice.item.id, "no rule, full by default");

    expect((await listFor(user.id))[0]!.openIssueCount).toBe(2);
    expect((await listFor(w.importerAdmin.id))[0]!.openIssueCount).toBe(4); // importer has no restrictions
  });

  it("a resolved issue does not count toward openIssueCount; a correction_requested one does; an item counts once", async () => {
    const w = await world();
    const resolved = await raise(w, w.packing.item.id, "was a problem");
    await resolveIssue({ issueId: resolved.id, actingUser: w.importerAdmin });
    const asked = await raise(w, w.cert.item.id, "needs a fix");
    await requestCorrection({ issueId: asked.id, message: "please", actingUser: w.importerAdmin });
    await raise(w, w.bol.item.id, "one");
    await raise(w, w.bol.item.id, "two"); // two issues, one item

    expect((await listFor(w.importerAdmin.id))[0]!.openIssueCount).toBe(2);
  });

  it("gives superadmin unfiltered figures regardless of rules", async () => {
    const w = await world();
    await setRule(w.cert.type, "exporter", "Compliance User", { view: "hidden" });
    await raise(w, w.cert.item.id, "issue");
    await setItemStatus(w.cert.item.id, "verified");
    const superadmin = await createSuperadmin();
    const [summary] = await listFor(superadmin.id);
    expect(summary!.checklistCompleteness).toEqual({ verified: 1, total: 4 });
    expect(summary!.openIssueCount).toBe(1);
  });
});

describe("GET /parties/workload", () => {
  it("an importer with consignments against two exporters gets two rows, each scoped to its own counterparty", async () => {
    const importer = await createActiveOrg("importer", "Importer Co");
    const exporterA = await createActiveOrg("exporter", "Alpha Exports");
    const exporterB = await createActiveOrg("exporter", "Bravo Exports");
    const withA1 = await world({ importer, exporter: exporterA });
    const withA2 = await world({ importer, exporter: exporterA });
    const withB = await world({ importer, exporter: exporterB });
    await raise(withA1, withA1.packing.item.id, "A issue");
    await raise(withB, withB.packing.item.id, "B issue one");
    await raise(withB, withB.cert.item.id, "B issue two");
    await setItemStatus(withA2.invoice.item.id, "verified"); // no longer awaiting upload
    await setItemStatus(withA1.bol.item.id, "pending");

    const { status, body } = await workloadFor(importer.admin.id);
    expect(status).toBe(200);
    expect(body.orgId).toBe(importer.org.id);
    expect(body.counterparties).toEqual([
      {
        counterpartyOrgId: exporterA.org.id,
        counterpartyOrgName: "Alpha Exports",
        activeConsignmentCount: 2,
        // 8 items across A's two consignments; awaiting_upload minus: A1.packing flagged, A1.bol pending, A2.invoice verified
        documentsAwaitingUploadCount: 5,
        openIssueCount: 1,
      },
      {
        counterpartyOrgId: exporterB.org.id,
        counterpartyOrgName: "Bravo Exports",
        activeConsignmentCount: 1,
        // 4 items, two flagged
        documentsAwaitingUploadCount: 2,
        openIssueCount: 2,
      },
    ]);
  });

  it("an exporter sees the importer as its counterparty", async () => {
    const w = await world();
    const { body } = await workloadFor(w.exporterAdmin.id);
    expect(body.counterparties).toHaveLength(1);
    expect(body.counterparties[0]).toMatchObject({
      counterpartyOrgId: w.parties.importer.org.id,
      counterpartyOrgName: w.parties.importer.org.name,
      activeConsignmentCount: 1,
      documentsAwaitingUploadCount: 4,
    });
  });

  it("status_only and hidden items contribute to neither count, matching GET /consignments", async () => {
    const w = await world();
    await exporterRule(w.cert.type, "hidden");
    await exporterRule(w.bol.type, "status_only");
    await exporterRule(w.packing.type, "full");
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    await raise(w, w.cert.item.id, "hidden item issue");
    await raise(w, w.bol.item.id, "status_only item issue");
    await raise(w, w.packing.item.id, "full item issue");

    const { body } = await workloadFor(user.id);
    const row = body.counterparties[0];
    expect(row.openIssueCount).toBe(1);
    // Awaiting upload, full items only: invoice (no rule, full). bol is flagged. cert hidden. packing flagged.
    expect(row.documentsAwaitingUploadCount).toBe(1);

    // Same rule as the list endpoint, so the two never disagree.
    const listTotal = (await listFor(user.id)).reduce((n, c) => n + c.openIssueCount, 0);
    expect(row.openIssueCount).toBe(listTotal);
  });

  it("hidden and status_only awaiting-upload documents are not counted even without any issue", async () => {
    const w = await world();
    await exporterRule(w.cert.type, "hidden");
    await exporterRule(w.bol.type, "status_only");
    const user = await createUserWithRoles(w.parties.exporter, ["Compliance User"]);
    const { body } = await workloadFor(user.id);
    expect(body.counterparties[0].documentsAwaitingUploadCount).toBe(2); // invoice and packing only
    expect((await workloadFor(w.importerAdmin.id)).body.counterparties[0].documentsAwaitingUploadCount).toBe(4);
  });

  it("a resolved issue does not count", async () => {
    const w = await world();
    const issue = await raise(w, w.packing.item.id, "gone");
    await resolveIssue({ issueId: issue.id, actingUser: w.importerAdmin });
    expect((await workloadFor(w.importerAdmin.id)).body.counterparties[0].openIssueCount).toBe(0);
  });

  it("counts cover active consignments only; a finished one still yields a row, with zeros", async () => {
    const importer = await createActiveOrg("importer");
    const exporter = await createActiveOrg("exporter");
    const doneExporter = await createActiveOrg("exporter", "Zulu Exports");
    const live = await world({ importer, exporter });
    const done = await world({ importer, exporter: doneExporter });
    const cancelledToo = await world({ importer, exporter });
    await raise(done, done.packing.item.id, "left over on a cancelled consignment");
    await db().update(consignments).set({ status: "completed" }).where(eq(consignments.id, done.consignment.id));
    await db().update(consignments).set({ status: "cancelled" }).where(eq(consignments.id, cancelledToo.consignment.id));
    void live;

    const { body } = await workloadFor(importer.admin.id);
    const byName = Object.fromEntries(body.counterparties.map((r: Json) => [r.counterpartyOrgName, r]));
    expect(byName[exporter.org.name]).toMatchObject({ activeConsignmentCount: 1, documentsAwaitingUploadCount: 4, openIssueCount: 0 });
    expect(byName["Zulu Exports"]).toMatchObject({ activeConsignmentCount: 0, documentsAwaitingUploadCount: 0, openIssueCount: 0 });
  });

  it("is available to any active org user, not only admins, and empty for an org with no consignments", async () => {
    const w = await world();
    const viewer = await createUserWithRoles(w.parties.importer, ["Viewer"]);
    expect((await workloadFor(viewer.id)).status).toBe(200);
    const lonely = await createActiveOrg("importer");
    expect((await workloadFor(lonely.admin.id)).body).toEqual({ orgId: lonely.org.id, counterparties: [] });
  });

  it("ignores ?orgId= for non-superadmin users: they always get their own org, never another's", async () => {
    const mine = await world();
    const theirs = await world();
    const { body } = await workloadFor(mine.importerAdmin.id, `?orgId=${theirs.parties.importer.org.id}`);
    expect(body.orgId).toBe(mine.parties.importer.org.id);
    expect(body.counterparties.map((r: Json) => r.counterpartyOrgId)).toEqual([mine.parties.exporter.org.id]);
  });

  it("superadmin must choose an org: 400 without it, 400 if malformed, 404 if unknown; with it, unfiltered totals for that org", async () => {
    const w = await world();
    await setRule(w.cert.type, "importer", "Organization Admin", { view: "hidden" });
    await raise(w, w.cert.item.id, "issue on a document the importer admin cannot see");
    const superadmin = await createSuperadmin();

    expect((await workloadFor(superadmin.id)).status).toBe(400);
    expect((await workloadFor(superadmin.id, "?orgId=nope")).status).toBe(400);
    expect((await workloadFor(superadmin.id, "?orgId=00000000-0000-4000-8000-000000000000")).status).toBe(404);

    const viewed = await workloadFor(superadmin.id, `?orgId=${w.parties.importer.org.id}`);
    expect(viewed.status).toBe(200);
    expect(viewed.body.counterparties[0]).toMatchObject({ documentsAwaitingUploadCount: 3, openIssueCount: 1 });
    // The importer's own admin, for whom that document is hidden, sees a smaller picture.
    const own = (await workloadFor(w.importerAdmin.id)).body.counterparties[0];
    expect(own.openIssueCount).toBe(0);
  });

  it("never reveals another org's counterparties to an ordinary user", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await get("/parties/workload", mine.importerAdmin.id);
    expect(res.body).not.toContain(theirs.parties.exporter.org.id);
    expect(res.body).not.toContain(theirs.parties.importer.org.id);
  });
});

describe("the three views agree with each other", () => {
  it("for one viewer, list totals, checklist contents, and workload rows are consistent", async () => {
    const parties = await createTradeParties();
    const a = await world(parties);
    const b = await world(parties);
    await exporterRule(a.cert.type, "hidden");
    await exporterRule(a.bol.type, "status_only");
    const user = await createUserWithRoles(parties.exporter, ["Compliance User"]);
    for (const w of [a, b]) {
      await raise(w, w.packing.item.id, "p");
      await raise(w, w.cert.item.id, "c");
      await raise(w, w.bol.item.id, "b");
    }

    const list = await listFor(user.id);
    let fullIssueItems = 0;
    for (const c of list) {
      const { checklist } = await checklistOf(c.id, user.id);
      const fromChecklist = checklist.filter((i) => i.openIssue).length;
      expect(c.openIssueCount).toBe(fromChecklist);
      expect(c.checklistCompleteness.total).toBe(checklist.length);
      fullIssueItems += fromChecklist;
    }
    expect((await workloadFor(user.id)).body.counterparties[0].openIssueCount).toBe(fullIssueItems);
  });
});

describe("createPermissionResolver", () => {
  it("resolves many document types from one load, identically to resolveDocumentPermissions", async () => {
    const parties = await createTradeParties();
    const docs = await Promise.all(["A", "B", "C", "D", "E"].map((n) => createDocumentType(`Doc ${n}`)));
    const [A, B, C, D] = docs as [DocumentType, DocumentType, DocumentType, DocumentType, DocumentType];
    await setRule(A, "exporter", "Compliance Manager", { view: "full", edit: true, approve: true });
    await setRule(A, "exporter", "Viewer", { view: "hidden" });
    await setRule(B, "exporter", "Viewer", { view: "status_only" });
    await setRule(C, "exporter", "Compliance Manager", { view: "hidden" });
    await setRule(C, "exporter", "Viewer", { view: "full", download: true });
    await setRule(D, "importer", "Viewer", { view: "hidden" }); // other org type: must not apply
    const multi = await createUserWithRoles(parties.exporter, ["Compliance Manager", "Viewer"]);
    const roleless = await createUserWithRoles(parties.exporter, []);
    const superadmin = await createSuperadmin();

    const expected = new Map<string, unknown>([
      ["Doc A", { viewLevel: "full", canEdit: true, canDownload: false, canApprove: true }],
      ["Doc B", { viewLevel: "status_only", canEdit: false, canDownload: false, canApprove: false }],
      ["Doc C", { viewLevel: "full", canEdit: false, canDownload: true, canApprove: false }],
      ["Doc D", { viewLevel: "full", canEdit: false, canDownload: false, canApprove: false }],
      ["Doc E", { viewLevel: "full", canEdit: false, canDownload: false, canApprove: false }],
    ]);

    for (const filter of [undefined, docs.map((d) => d.id)]) {
      const resolve = await createPermissionResolver(multi, db(), filter);
      for (const doc of docs) {
        expect(resolve(doc.id), doc.name).toEqual(expected.get(doc.name));
        expect(await resolveDocumentPermissions(multi, doc)).toEqual(expected.get(doc.name));
      }
    }
    const rolelessResolve = await createPermissionResolver(roleless, db());
    const superResolve = await createPermissionResolver(superadmin, db());
    for (const doc of docs) {
      expect(rolelessResolve(doc.id).canEdit).toBe(false);
      expect(superResolve(doc.id)).toEqual({ viewLevel: "full", canEdit: true, canDownload: true, canApprove: true });
    }
  });

  it("an empty documentTypeIds filter loads no rules and resolves to defaults", async () => {
    const parties = await createTradeParties();
    const doc = await createDocumentType();
    await setRule(doc, "exporter", "Viewer", { view: "hidden" });
    const user = await createUserWithRoles(parties.exporter, ["Viewer"]);
    const resolve = await createPermissionResolver(user, db(), []);
    expect(resolve(doc.id).viewLevel).toBe("full");
  });
});
