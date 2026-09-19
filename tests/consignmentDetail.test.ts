import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { createActiveOrg, createSuperadmin, createTradeParties, createUserWithRoles, submitTestPO } from "./helpers.js";

const app = buildApp({ actor: { allowDevActorHeader: true } });
const detail = (id: string, actorId?: string) =>
  app.inject({ method: "GET", url: `/consignments/${id}`, headers: actorId ? { "x-dev-user": actorId } : {} });

describe("GET /consignments/:consignmentId", () => {
  it("returns exactly the documented header fields, and no field the schema does not have", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties, { hsCode: "0202.30" });

    const res = await detail(consignment.id, parties.importer.admin.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      id: consignment.id,
      status: "checklist_received",
      commodity: "Frozen beef",
      hsCode: "0202.30",
      originCountry: "BR",
      destinationCountry: "GB",
      importerOrg: { id: parties.importer.org.id, name: parties.importer.org.name },
      exporterOrg: { id: parties.exporter.org.id, name: parties.exporter.org.name },
      createdAt: expect.any(String),
    });
    expect(new Date(body.createdAt).toString()).not.toBe("Invalid Date");
    // There is no quantity in the schema, so the API must not offer one.
    for (const key of ["quantity", "weight", "eta", "dueDate", "trackingId"]) expect(body).not.toHaveProperty(key);
  });

  it("returns a null hsCode when there is none", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);
    expect((await detail(consignment.id, parties.importer.admin.id)).json().hsCode).toBeNull();
  });

  it("is readable by the importer, the exporter, and superadmin", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);
    const superadmin = await createSuperadmin();
    const viewer = await createUserWithRoles(parties.exporter, ["Viewer"]);
    for (const id of [parties.importer.admin.id, parties.exporter.admin.id, superadmin.id, viewer.id]) {
      expect((await detail(consignment.id, id)).statusCode).toBe(200);
    }
  });

  it("gives a user who is not a party the same 404 as for a consignment that does not exist", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);
    const stranger = await createActiveOrg("importer");
    const logistics = await createActiveOrg("logistics");

    const real = await detail(consignment.id, stranger.admin.id);
    const missing = await detail("00000000-0000-4000-8000-000000000000", stranger.admin.id);
    expect(real.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(real.json()).toEqual(missing.json());
    expect((await detail(consignment.id, logistics.admin.id)).statusCode).toBe(404);
    expect((await detail("not-a-uuid", stranger.admin.id)).statusCode).toBe(404);
  });

  it("is 401 without an acting user and 403 for an inactive one", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);
    expect((await detail(consignment.id)).statusCode).toBe(401);

    const inactive = await createUserWithRoles(parties.importer, ["Viewer"]);
    await getDb().update(users).set({ status: "deactivated" }).where(eq(users.id, inactive.id));
    expect((await detail(consignment.id, inactive.id)).statusCode).toBe(403);
  });

  it("does not conflict with the checklist route under the same path prefix", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);
    const res = await app.inject({
      method: "GET",
      url: `/consignments/${consignment.id}/checklist`,
      headers: { "x-dev-user": parties.importer.admin.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("checklist");
  });
});
