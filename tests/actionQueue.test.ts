import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { consignments, document_checklist_items, users } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { raiseIssue } from "../src/services/issues.js";
import {
  createActiveOrg,
  createSuperadmin,
  createTradeParties,
  createUserWithRoles,
  scenario,
  setRule,
  type Scenario,
} from "./helpers.js";

const db = () => getDb();
const app = buildApp({ actor: { allowDevActorHeader: true } });

type Item = Record<string, any>;
const queue = async (actorId: string, query = "") => {
  const res = await app.inject({ method: "GET", url: `/action-queue${query}`, headers: { "x-dev-user": actorId } });
  return { status: res.statusCode, body: res.json() as { orgId: string; items: Item[] }, raw: res.body };
};
const names = (items: Item[]) => items.map((i) => i.documentTypeName);

const setItemStatus = (itemId: string, status: "awaiting_upload" | "pending" | "verified" | "flagged") =>
  db().update(document_checklist_items).set({ status }).where(eq(document_checklist_items.id, itemId));

const raise = (s: Scenario, itemId: string, problem = "Mismatch", responsibleOrgType: "exporter" | "importer" = "exporter") =>
  raiseIssue({ documentChecklistItemId: itemId, problem, responsibleOrgType, actingUser: s.importerAdmin });

describe("GET /action-queue: what is in it", () => {
  it("lists documents awaiting upload and documents with an unresolved issue, and nothing else", async () => {
    const s = await scenario();
    await setItemStatus(s.invoice.item.id, "verified");
    await setItemStatus(s.packing.item.id, "pending");
    await raise(s, s.cert.item.id);

    const { status, body } = await queue(s.importerAdmin.id);
    expect(status).toBe(200);
    expect(body.orgId).toBe(s.parties.importer.org.id);
    expect(names(body.items)).toEqual(["Export Health Certificate", "Bill of Lading"]); // flagged, then awaiting
  });

  it("gives a full item every field, and a well-formed consignment label", async () => {
    const s = await scenario();
    const issue = await raise(s, s.cert.item.id, "Exporter name differs");

    const { body } = await queue(s.importerAdmin.id);
    expect(body.items.find((i) => i.documentTypeName === "Export Health Certificate")).toEqual({
      consignmentId: s.consignment.id,
      consignmentLabel: "Frozen beef, BR to GB",
      documentTypeName: "Export Health Certificate",
      requiredBy: "exporter",
      status: "flagged",
      issueId: issue.id,
      responsibleOrgType: "exporter",
      actionableByMyOrg: false, // the importer raised it, the exporter must act
    });
    expect(body.items.find((i) => i.documentTypeName === "Bill of Lading")).toMatchObject({
      status: "awaiting_upload",
      requiredBy: "logistics",
      issueId: null,
      responsibleOrgType: null,
    });
  });

  it("never offers due dates or an overdue flag, since no deadline concept exists", async () => {
    const s = await scenario();
    const { body } = await queue(s.importerAdmin.id);
    for (const item of body.items) {
      for (const key of ["dueDate", "due", "overdue", "deadline", "eta"]) expect(item).not.toHaveProperty(key);
    }
  });

  it("shows only live consignments of the viewed org: not finished ones, not another org's", async () => {
    const parties = await createTradeParties();
    const live = await scenario(parties, { commodity: "Live" });
    const done = await scenario(parties, { commodity: "Done" });
    const dropped = await scenario(parties, { commodity: "Dropped" });
    await db().update(consignments).set({ status: "completed" }).where(eq(consignments.id, done.consignment.id));
    await db().update(consignments).set({ status: "cancelled" }).where(eq(consignments.id, dropped.consignment.id));
    await scenario(); // some other org entirely

    const { body } = await queue(parties.importer.admin.id);
    expect(new Set(body.items.map((i) => i.consignmentId))).toEqual(new Set([live.consignment.id]));
    expect(body.items).toHaveLength(4);
  });

  it("treats a flagged item with no unresolved issue as flagged with no issue, and not actionable", async () => {
    const s = await scenario();
    await setItemStatus(s.packing.item.id, "flagged"); // status set directly, no issue row
    const { body } = await queue(s.exporterAdmin.id);
    expect(body.items.find((i) => i.documentTypeName === "Packing List")).toMatchObject({
      status: "flagged",
      issueId: null,
      responsibleOrgType: null,
      actionableByMyOrg: false,
    });
  });
});

describe("GET /action-queue: actionableByMyOrg", () => {
  it("awaiting_upload is actionable by the org type that must supply the document", async () => {
    const s = await scenario();
    const exporter = (await queue(s.exporterAdmin.id)).body.items;
    const importer = (await queue(s.importerAdmin.id)).body.items;
    const flag = (items: Item[], name: string) => items.find((i) => i.documentTypeName === name)!.actionableByMyOrg;

    // Invoice, packing list, and certificate are the exporter's to supply; the bill of lading is logistics'.
    for (const name of ["Commercial Invoice", "Packing List", "Export Health Certificate"]) {
      expect(flag(exporter, name), `exporter ${name}`).toBe(true);
      expect(flag(importer, name), `importer ${name}`).toBe(false);
    }
    expect(flag(exporter, "Bill of Lading")).toBe(false);
    expect(flag(importer, "Bill of Lading")).toBe(false);
  });

  it("flagged is actionable by the org type the issue names as responsible, from both sides", async () => {
    const s = await scenario();
    await raise(s, s.cert.item.id, "For the exporter", "exporter");
    await raise(s, s.packing.item.id, "For the importer", "importer");

    const exporter = (await queue(s.exporterAdmin.id)).body.items;
    const importer = (await queue(s.importerAdmin.id)).body.items;
    const flag = (items: Item[], name: string) => items.find((i) => i.documentTypeName === name)!.actionableByMyOrg;

    expect(flag(exporter, "Export Health Certificate")).toBe(true);
    expect(flag(importer, "Export Health Certificate")).toBe(false);
    expect(flag(exporter, "Packing List")).toBe(false);
    expect(flag(importer, "Packing List")).toBe(true);
  });
});

describe("GET /action-queue: permission filtering", () => {
  it("omits hidden items, seals status_only items, and keeps full items complete", async () => {
    const s = await scenario();
    await setRule(s.cert.type, "exporter", "Compliance User", { view: "hidden" });
    await setRule(s.bol.type, "exporter", "Compliance User", { view: "status_only" });
    await setRule(s.packing.type, "exporter", "Compliance User", { view: "full" });
    const user = await createUserWithRoles(s.parties.exporter, ["Compliance User"]);
    await raise(s, s.cert.item.id, "Secret certificate problem");
    await raise(s, s.bol.item.id, "Secret bill of lading problem");

    const res = await queue(user.id);
    const byName = Object.fromEntries(res.body.items.map((i) => [i.documentTypeName, i]));

    expect(byName["Export Health Certificate"]).toBeUndefined(); // hidden
    expect(res.raw).not.toContain("Export Health Certificate");
    expect(res.raw).not.toContain("Secret certificate problem");

    expect(byName["Bill of Lading"]).toEqual({
      consignmentId: s.consignment.id,
      consignmentLabel: "Frozen beef, BR to GB",
      documentTypeName: "Bill of Lading",
      requiredBy: null,
      status: "flagged", // the viewer learns something is wrong from the status alone
      issueId: null,
      responsibleOrgType: null,
      actionableByMyOrg: false,
    });
    expect(res.raw).not.toContain("Secret bill of lading problem");

    expect(byName["Packing List"]).toMatchObject({ requiredBy: "exporter", status: "awaiting_upload", actionableByMyOrg: true });
    expect(byName["Commercial Invoice"]).toBeDefined(); // no rule: visible by default
  });

  it("a status_only awaiting_upload item is never actionable, even when its org would have to supply it", async () => {
    const s = await scenario();
    await setRule(s.invoice.type, "exporter", "Viewer", { view: "status_only" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    const item = (await queue(viewer.id)).body.items.find((i) => i.documentTypeName === "Commercial Invoice")!;
    expect(item).toMatchObject({ status: "awaiting_upload", requiredBy: null, actionableByMyOrg: false });
  });

  it("is consistent with the checklist: the same visible flagged and awaiting documents", async () => {
    const s = await scenario();
    await setRule(s.cert.type, "exporter", "Compliance User", { view: "hidden" });
    await setRule(s.bol.type, "exporter", "Compliance User", { view: "status_only" });
    const user = await createUserWithRoles(s.parties.exporter, ["Compliance User"]);
    await raise(s, s.packing.item.id, "flag one");

    const checklist = (
      await app.inject({ method: "GET", url: `/consignments/${s.consignment.id}/checklist`, headers: { "x-dev-user": user.id } })
    ).json().checklist as Item[];
    const fromChecklist = checklist.filter((i) => i.status === "flagged" || i.status === "awaiting_upload").map((i) => i.documentTypeName);
    expect(names((await queue(user.id)).body.items).sort()).toEqual(fromChecklist.sort());
  });
});

describe("GET /action-queue: ordering", () => {
  it("puts flagged before awaiting_upload, then the newest consignment first, then by document name", async () => {
    const parties = await createTradeParties();
    const older = await scenario(parties, { commodity: "Older" });
    const newer = await scenario(parties, { commodity: "Newer" });
    await db().update(consignments).set({ created_at: new Date("2026-01-01") }).where(eq(consignments.id, older.consignment.id));
    await db().update(consignments).set({ created_at: new Date("2026-02-01") }).where(eq(consignments.id, newer.consignment.id));
    await raise(older, older.cert.item.id);
    await raise(newer, newer.packing.item.id);

    const { body } = await queue(parties.importer.admin.id);
    const order = body.items.map((i) => `${i.status}:${i.consignmentLabel.split(",")[0]}:${i.documentTypeName}`);
    expect(order).toEqual([
      "flagged:Newer:Packing List",
      "flagged:Older:Export Health Certificate",
      "awaiting_upload:Newer:Bill of Lading",
      "awaiting_upload:Newer:Commercial Invoice",
      "awaiting_upload:Newer:Export Health Certificate",
      "awaiting_upload:Older:Bill of Lading",
      "awaiting_upload:Older:Commercial Invoice",
      "awaiting_upload:Older:Packing List",
    ]);
  });
});

describe("GET /action-queue: who can ask, and for whom", () => {
  it("is 401 without an acting user and 403 for an inactive one", async () => {
    const s = await scenario();
    expect((await app.inject({ method: "GET", url: "/action-queue" })).statusCode).toBe(401);
    const inactive = await createUserWithRoles(s.parties.importer, ["Viewer"]);
    await db().update(users).set({ status: "invited" }).where(eq(users.id, inactive.id));
    expect((await queue(inactive.id)).status).toBe(403);
  });

  it("is empty for an org with no consignments", async () => {
    const lonely = await createActiveOrg("importer");
    expect((await queue(lonely.admin.id)).body).toEqual({ orgId: lonely.org.id, items: [] });
  });

  it("ignores ?orgId= for an ordinary user, who always gets their own org's queue", async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const { body } = await queue(mine.importerAdmin.id, `?orgId=${theirs.parties.importer.org.id}`);
    expect(body.orgId).toBe(mine.parties.importer.org.id);
    expect(new Set(body.items.map((i) => i.consignmentId))).toEqual(new Set([mine.consignment.id]));
  });

  it("superadmin must choose an org: 400 without or with a malformed id, 404 for an unknown one", async () => {
    const superadmin = await createSuperadmin();
    expect((await queue(superadmin.id)).status).toBe(400);
    expect((await queue(superadmin.id, "?orgId=nope")).status).toBe(400);
    expect((await queue(superadmin.id, "?orgId=00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("superadmin sees the chosen org's queue at full visibility, judged from that org's side", async () => {
    const s = await scenario();
    await setRule(s.cert.type, "exporter", "Organization Admin", { view: "hidden" });
    await raise(s, s.cert.item.id, "Hidden from the exporter admin");
    const superadmin = await createSuperadmin();

    const asSuper = (await queue(superadmin.id, `?orgId=${s.parties.exporter.org.id}`)).body;
    const cert = asSuper.items.find((i) => i.documentTypeName === "Export Health Certificate")!;
    expect(asSuper.orgId).toBe(s.parties.exporter.org.id);
    expect(cert).toMatchObject({ status: "flagged", actionableByMyOrg: true, responsibleOrgType: "exporter" });

    // The exporter's own admin cannot see that document at all.
    expect(names((await queue(s.exporterAdmin.id)).body.items)).not.toContain("Export Health Certificate");
  });
});
