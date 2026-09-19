import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { raiseIssue } from "../src/services/issues.js";
import { createSuperadmin, createTradeParties, scenario, setRule, submitTestPO, createUserWithRoles } from "./helpers.js";

/**
 * Fields that exist only because the web app's screens need them. Each is additive: it is data the
 * backend already held, returned in one more place, and no existing field changed.
 */

const app = buildApp({ actor: { allowDevActorHeader: true } });
const get = (url: string, actorId: string) => app.inject({ method: "GET", url, headers: { "x-dev-user": actorId } });

describe("GET /consignments: origin and destination (dashboard route column)", () => {
  it("returns originCountry and destinationCountry for each consignment", async () => {
    const parties = await createTradeParties();
    await submitTestPO(parties, { originCountry: "BR", destinationCountry: "GB", commodity: "Frozen beef" });
    await submitTestPO(parties, { originCountry: "AR", destinationCountry: "GB", commodity: "Frozen lamb" });

    const list = (await get("/consignments", parties.importer.admin.id)).json().consignments as Array<Record<string, unknown>>;
    const byCommodity = Object.fromEntries(list.map((c) => [c.commodity as string, c]));
    expect(byCommodity["Frozen beef"]).toMatchObject({ originCountry: "BR", destinationCountry: "GB" });
    expect(byCommodity["Frozen lamb"]).toMatchObject({ originCountry: "AR", destinationCountry: "GB" });
  });

  it("returns them to the exporter and to superadmin too, and adds nothing else new to the summary", async () => {
    const s = await scenario();
    const superadmin = await createSuperadmin();
    for (const id of [s.exporterAdmin.id, superadmin.id]) {
      const [c] = (await get("/consignments", id)).json().consignments as Array<Record<string, unknown>>;
      expect(c).toMatchObject({ originCountry: "BR", destinationCountry: "GB" });
      expect(Object.keys(c!).sort()).toEqual(
        [
          "checklistCompleteness", "commodity", "counterpartOrgName", "destinationCountry", "exporterOrgName",
          "id", "importerOrgName", "openIssueCount", "originCountry", "status",
        ].sort(),
      );
    }
  });
});

describe("GET /consignments/:id/checklist: issueId on an open issue (roadmap link)", () => {
  const raise = (s: Awaited<ReturnType<typeof scenario>>, itemId: string) =>
    raiseIssue({
      documentChecklistItemId: itemId,
      problem: "Carton count mismatch",
      expectedValue: "480",
      foundValue: "460",
      responsibleOrgType: "exporter",
      actingUser: s.importerAdmin,
    });

  it("names the issue, and the id opens that issue", async () => {
    const s = await scenario();
    const issue = await raise(s, s.packing.item.id);
    const other = await raise(s, s.cert.item.id);

    const { checklist } = (await get(`/consignments/${s.consignment.id}/checklist`, s.importerAdmin.id)).json();
    const packing = checklist.find((i: any) => i.checklistItemId === s.packing.item.id);
    const cert = checklist.find((i: any) => i.checklistItemId === s.cert.item.id);
    expect(packing.openIssue.issueId).toBe(issue.id);
    expect(cert.openIssue.issueId).toBe(other.id);

    const opened = await get(`/issues/${packing.openIssue.issueId}`, s.importerAdmin.id);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ id: issue.id, problem: "Carton count mismatch" });
  });

  it("gives an item with no open issue no issue at all, and a status_only viewer nothing about issues", async () => {
    const s = await scenario();
    await raise(s, s.packing.item.id);
    await setRule(s.packing.type, "exporter", "Viewer", { view: "status_only" });
    const viewer = await createUserWithRoles(s.parties.exporter, ["Viewer"]);

    const admin = (await get(`/consignments/${s.consignment.id}/checklist`, s.importerAdmin.id)).json().checklist;
    expect(admin.find((i: any) => i.checklistItemId === s.invoice.item.id).openIssue).toBeNull();

    const sealed = (await get(`/consignments/${s.consignment.id}/checklist`, viewer.id)).json().checklist;
    const item = sealed.find((i: any) => i.checklistItemId === s.packing.item.id);
    expect(item).not.toHaveProperty("openIssue");
    expect(JSON.stringify(item)).not.toContain("issueId");
  });
});
