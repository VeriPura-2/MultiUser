import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { createSuperadmin, createTradeParties, scenario, submitTestPO } from "./helpers.js";

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
