import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { audit_log, consignments, vessel_positions } from "../src/db/schema.js";
import { UnprocessableEntityError } from "../src/errors.js";
import { buildApp } from "../src/http/app.js";
import {
  IMO_CHECK_DIGIT_MESSAGE,
  IMO_LENGTH_MESSAGE,
  MAX_VESSEL_NAME_LENGTH,
  MMSI_LENGTH_MESSAGE,
  VESSEL_NAME_LENGTH_MESSAGE,
  hasValidImoCheckDigit,
  imoProblem,
  mmsiProblem,
  parseVesselFields,
  vesselFieldsForCreate,
} from "../src/tracking/identifiers.js";
import { createActiveOrg, createSuperadmin, createTradeParties, createUserWithRoles, multipartForm, scenario, submitTestPO } from "./helpers.js";

const app = buildApp({ actor: { allowDevActorHeader: true } });
const VALID_IMO = "9074729"; // 9*7 + 0*6 + 7*5 + 4*4 + 7*3 + 2*2 = 139, last digit 9
const OTHER_VALID_IMO = "9319466"; // 63 + 18 + 5 + 36 + 12 + 12 = 146, last digit 6
const VALID_MMSI = "235012345";

const call = (method: "GET" | "PATCH", url: string, actorId?: string, body?: unknown) =>
  app.inject({
    method,
    url,
    headers: { ...(actorId ? { "x-dev-user": actorId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body === undefined ? undefined : (body as object),
  });
const patch = (consignmentId: string, actorId: string | undefined, body: unknown) => call("PATCH", `/consignments/${consignmentId}/vessel`, actorId, body);
const auditRows = (consignmentId: string) => getDb().select().from(audit_log).where(eq(audit_log.target_id, consignmentId));
const row = async (id: string) => (await getDb().select().from(consignments).where(eq(consignments.id, id)))[0]!;

describe("IMO check digit", () => {
  it("accepts numbers whose weighted digit sum ends in the seventh digit", () => {
    for (const imo of [VALID_IMO, OTHER_VALID_IMO, "9811000"]) {
      expect(hasValidImoCheckDigit(imo), imo).toBe(true);
      expect(imoProblem(imo), imo).toBeNull();
    }
  });

  it("rejects a wrong check digit, for every possible wrong digit", () => {
    const sixDigits = "907472";
    for (let d = 0; d < 10; d++) {
      const imo = `${sixDigits}${d}`;
      expect(imoProblem(imo), imo).toBe(d === 9 ? null : IMO_CHECK_DIGIT_MESSAGE);
    }
  });

  it("uses the weights 7 down to 2 on the first six digits", () => {
    // Only the first digit differs: a different weight on it would change which check digit is right.
    expect(hasValidImoCheckDigit("1000000")).toBe(false); // 1*7 = 7, so the seventh digit must be 7
    expect(hasValidImoCheckDigit("1000007")).toBe(true);
    expect(hasValidImoCheckDigit("0100006")).toBe(true); // 1*6
    expect(hasValidImoCheckDigit("0010005")).toBe(true); // 1*5
    expect(hasValidImoCheckDigit("0001004")).toBe(true); // 1*4
    expect(hasValidImoCheckDigit("0000103")).toBe(true); // 1*3
    expect(hasValidImoCheckDigit("0000012")).toBe(true); // 1*2
  });

  it("only the last digit of the sum counts", () => {
    // 9*7 + 9*6 + 9*5 + 9*4 + 9*3 + 9*2 = 243, last digit 3
    expect(hasValidImoCheckDigit("9999993")).toBe(true);
    expect(hasValidImoCheckDigit("9999994")).toBe(false);
  });

  it("wrong length or non-digits are a length problem, whatever the digits", () => {
    for (const bad of ["", "907472", "90747290", "abcdefg", "9074 729", "9074-729", "907472x", " 9074729"]) {
      expect(imoProblem(bad), JSON.stringify(bad)).toBe(IMO_LENGTH_MESSAGE);
    }
  });
});

describe("MMSI", () => {
  it("must be exactly nine digits", () => {
    expect(mmsiProblem(VALID_MMSI)).toBeNull();
    expect(mmsiProblem("012345678")).toBeNull(); // a leading zero is legal and must survive
    for (const bad of ["", "23501234", "2350123456", "23501234a", "235 012 345"]) {
      expect(mmsiProblem(bad), JSON.stringify(bad)).toBe(MMSI_LENGTH_MESSAGE);
    }
  });
});

describe("parseVesselFields", () => {
  it("returns only the fields that were named, trimmed", () => {
    expect(parseVesselFields({ vesselImo: ` ${VALID_IMO} ` })).toEqual({ vesselImo: VALID_IMO });
    expect(parseVesselFields({ vesselName: "  Sample Voyager " })).toEqual({ vesselName: "Sample Voyager" });
    expect(parseVesselFields({})).toEqual({});
  });

  it("treats null and blank text as clearing the field, and lets an absent field alone", () => {
    expect(parseVesselFields({ vesselImo: null, vesselMmsi: "   ", vesselName: "" })).toEqual({ vesselImo: null, vesselMmsi: null, vesselName: null });
    expect("vesselMmsi" in parseVesselFields({ vesselImo: null })).toBe(false);
  });

  it("either or both identifiers may be set", () => {
    expect(parseVesselFields({ vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI })).toEqual({ vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI });
  });

  it("lists every problem in one 422 message", () => {
    let error: unknown;
    try {
      parseVesselFields({ vesselImo: "123", vesselMmsi: "4", vesselName: "x".repeat(MAX_VESSEL_NAME_LENGTH + 1) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnprocessableEntityError);
    expect((error as Error).message).toBe(`${IMO_LENGTH_MESSAGE} ${MMSI_LENGTH_MESSAGE} ${VESSEL_NAME_LENGTH_MESSAGE}`);
  });

  it("refuses numbers and other non-text, since a number loses a leading zero", () => {
    expect(() => parseVesselFields({ vesselMmsi: 12345678 })).toThrow(/MMSI must be sent as text/);
    expect(() => parseVesselFields({ vesselImo: 9074729 })).toThrow(/IMO number must be sent as text/);
    expect(() => parseVesselFields({ vesselName: {} })).toThrow(/Vessel name must be sent as text/);
  });

  it("allows a name of exactly the maximum length and refuses one character more", () => {
    expect(parseVesselFields({ vesselName: "x".repeat(MAX_VESSEL_NAME_LENGTH) }).vesselName).toHaveLength(MAX_VESSEL_NAME_LENGTH);
    expect(() => parseVesselFields({ vesselName: "x".repeat(MAX_VESSEL_NAME_LENGTH + 1) })).toThrow(VESSEL_NAME_LENGTH_MESSAGE);
  });

  it("vesselFieldsForCreate fills what was not given with null", () => {
    expect(vesselFieldsForCreate({})).toEqual({ vesselImo: null, vesselMmsi: null, vesselName: null });
    expect(vesselFieldsForCreate({ vesselMmsi: VALID_MMSI })).toEqual({ vesselImo: null, vesselMmsi: VALID_MMSI, vesselName: null });
  });
});

describe("POST /consignments with vessel fields", () => {
  const submit = (actorId: string, fields: Record<string, string>) => {
    const { payload, contentType } = multipartForm(fields, { name: "po.pdf", content: Buffer.from("%PDF-1.4 po") });
    return app.inject({ method: "POST", url: "/consignments", headers: { "content-type": contentType, "x-dev-user": actorId }, payload });
  };
  const base = (exporterOrgId: string) => ({ exporterOrgId, commodity: "Frozen beef", originCountry: "BR", destinationCountry: "GB" });

  it("stores all three fields and returns them", async () => {
    const p = await createTradeParties();
    const res = await submit(p.importer.admin.id, { ...base(p.exporter.org.id), vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment).toMatchObject({ vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
    const stored = await row(res.json().consignment.id);
    expect([stored.vessel_imo, stored.vessel_mmsi, stored.vessel_name]).toEqual([VALID_IMO, VALID_MMSI, "Sample Voyager"]);
    // The purchase order's audit row records them, so the first value is on record too.
    const [created] = (await auditRows(stored.id)).filter((a) => a.action === "consignment.po_submitted");
    expect(created!.metadata).toMatchObject({ vessel_imo: VALID_IMO, vessel_mmsi: VALID_MMSI, vessel_name: "Sample Voyager" });
  });

  it("works with none of them, leaving all three null and the audit row as it was", async () => {
    const p = await createTradeParties();
    const res = await submit(p.importer.admin.id, base(p.exporter.org.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment).toMatchObject({ vesselImo: null, vesselMmsi: null, vesselName: null });
    const [created] = (await auditRows(res.json().consignment.id)).filter((a) => a.action === "consignment.po_submitted");
    expect(Object.keys(created!.metadata)).not.toContain("vessel_imo");
  });

  it("treats blank vessel fields as none", async () => {
    const p = await createTradeParties();
    const res = await submit(p.importer.admin.id, { ...base(p.exporter.org.id), vesselImo: "", vesselMmsi: "  ", vesselName: "" });
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment).toMatchObject({ vesselImo: null, vesselMmsi: null, vesselName: null });
  });

  it("answers 422 with a clear message for a malformed value, and creates nothing", async () => {
    const p = await createTradeParties();
    for (const [field, value, message] of [
      ["vesselImo", "9074728", IMO_CHECK_DIGIT_MESSAGE],
      ["vesselImo", "12345", IMO_LENGTH_MESSAGE],
      ["vesselMmsi", "12345678", MMSI_LENGTH_MESSAGE],
    ] as const) {
      const res = await submit(p.importer.admin.id, { ...base(p.exporter.org.id), [field]: value });
      expect(res.statusCode, `${field}=${value}`).toBe(422);
      expect(res.json()).toMatchObject({ error: "unprocessable", message });
    }
    expect(await getDb().select().from(consignments)).toHaveLength(0);
  });
});

describe("PATCH /consignments/:id/vessel", () => {
  it("sets the fields, returns the detail, and writes an audit row with the old and new values", async () => {
    const s = await scenario();
    const res = await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.consignment.id, vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });

    const [entry] = (await auditRows(s.consignment.id)).filter((a) => a.action === "consignment.vessel_updated");
    expect(entry).toMatchObject({ actor_user_id: s.importerAdmin.id, target_type: "consignment" });
    expect(entry!.metadata).toEqual({
      old: { vessel_imo: null, vessel_mmsi: null, vessel_name: null },
      new: { vessel_imo: VALID_IMO, vessel_mmsi: VALID_MMSI, vessel_name: "Sample Voyager" },
    });
  });

  it("changes only the fields named, and the audit row shows the value before", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO, vesselName: "First Name" });
    const res = await patch(s.consignment.id, s.importerAdmin.id, { vesselName: "Second Name" });
    expect(res.json()).toMatchObject({ vesselImo: VALID_IMO, vesselMmsi: null, vesselName: "Second Name" });
    const entries = (await auditRows(s.consignment.id)).filter((a) => a.action === "consignment.vessel_updated");
    expect(entries).toHaveLength(2);
    const second = entries.find((e) => (e.metadata as { new: { vessel_name: string } }).new.vessel_name === "Second Name")!;
    expect(second.metadata).toEqual({
      old: { vessel_imo: VALID_IMO, vessel_mmsi: null, vessel_name: "First Name" },
      new: { vessel_imo: VALID_IMO, vessel_mmsi: null, vessel_name: "Second Name" },
    });
  });

  it("clears a field with null or blank text", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI });
    const res = await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: null, vesselMmsi: "  " });
    expect(res.json()).toMatchObject({ vesselImo: null, vesselMmsi: null });
    const stored = await row(s.consignment.id);
    expect([stored.vessel_imo, stored.vessel_mmsi]).toEqual([null, null]);
  });

  it("writes no audit row when nothing changes", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO });
    const before = (await auditRows(s.consignment.id)).length;
    const same = await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO });
    expect(same.statusCode).toBe(200);
    const clearAlreadyEmpty = await patch(s.consignment.id, s.importerAdmin.id, { vesselMmsi: null });
    expect(clearAlreadyEmpty.statusCode).toBe(200);
    expect((await auditRows(s.consignment.id)).length).toBe(before);
  });

  it("is a 422, changing nothing and writing no audit row, for a bad value or an empty body", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO });
    const before = (await auditRows(s.consignment.id)).length;
    const bad = await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: "9074728", vesselName: "Should Not Be Saved" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toBe(IMO_CHECK_DIGIT_MESSAGE);
    const empty = await patch(s.consignment.id, s.importerAdmin.id, {});
    expect(empty.statusCode).toBe(422);
    const stored = await row(s.consignment.id);
    expect([stored.vessel_imo, stored.vessel_name]).toEqual([VALID_IMO, null]);
    expect((await auditRows(s.consignment.id)).length).toBe(before);
  });

  it("is a 400 for a body that is not a JSON object", async () => {
    const s = await scenario();
    expect((await patch(s.consignment.id, s.importerAdmin.id, [])).statusCode).toBe(400);
  });

  it("lets a superadmin do it, and any user of either party: the importing organization or the exporting one", async () => {
    const s = await scenario();
    const superadmin = await createSuperadmin();
    expect((await patch(s.consignment.id, superadmin.id, { vesselName: "By Superadmin" })).statusCode).toBe(200);
    const importerColleague = await createUserWithRoles(s.parties.importer, ["Viewer"]);
    expect((await patch(s.consignment.id, importerColleague.id, { vesselName: "By Importer Colleague" })).statusCode).toBe(200);
    const exporterColleague = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    expect((await patch(s.consignment.id, exporterColleague.id, { vesselName: "By Exporter Colleague" })).statusCode).toBe(200);
    const actors = (await auditRows(s.consignment.id)).filter((a) => a.action === "consignment.vessel_updated").map((a) => a.actor_user_id);
    expect(actors).toEqual([superadmin.id, importerColleague.id, exporterColleague.id]);
  });

  it("lets the exporter set, change and clear it, and the audit row names the exporter's user", async () => {
    const s = await scenario();
    const set = await patch(s.consignment.id, s.exporterAdmin.id, { vesselImo: VALID_IMO, vesselName: "Booked Vessel" });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ vesselImo: VALID_IMO, vesselName: "Booked Vessel" });
    expect((await patch(s.consignment.id, s.exporterAdmin.id, { vesselName: "Changed Vessel" })).json()).toMatchObject({ vesselName: "Changed Vessel" });
    expect((await patch(s.consignment.id, s.exporterAdmin.id, { vesselImo: null })).json()).toMatchObject({ vesselImo: null });
    const entries = (await auditRows(s.consignment.id)).filter((a) => a.action === "consignment.vessel_updated");
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.actor_user_id === s.exporterAdmin.id)).toBe(true);
    expect(entries[0]!.metadata).toEqual({
      old: { vessel_imo: null, vessel_mmsi: null, vessel_name: null },
      new: { vessel_imo: VALID_IMO, vessel_mmsi: null, vessel_name: "Booked Vessel" },
    });
  });

  it("the importer sees what the exporter set, and the exporter sees what the importer set", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.exporterAdmin.id, { vesselName: "Exporter's Entry" });
    expect((await call("GET", `/consignments/${s.consignment.id}`, s.importerAdmin.id)).json()).toMatchObject({ vesselName: "Exporter's Entry" });
    await patch(s.consignment.id, s.importerAdmin.id, { vesselMmsi: VALID_MMSI });
    expect((await call("GET", `/consignments/${s.consignment.id}`, s.exporterAdmin.id)).json()).toMatchObject({ vesselMmsi: VALID_MMSI });
  });

  it("is the same 404 for a freight forwarder, who is not linked to any consignment yet, and changes nothing", async () => {
    const s = await scenario();
    const forwarder = await createActiveOrg("logistics");
    const asForwarder = await patch(s.consignment.id, forwarder.admin.id, { vesselImo: VALID_IMO });
    const missing = await patch("00000000-0000-4000-8000-000000000000", forwarder.admin.id, { vesselImo: VALID_IMO });
    expect(asForwarder.statusCode).toBe(404);
    expect(asForwarder.json()).toEqual(missing.json());
    expect((await row(s.consignment.id)).vessel_imo).toBeNull();
    expect((await auditRows(s.consignment.id)).filter((a) => a.action === "consignment.vessel_updated")).toHaveLength(0);
    // The forwarder cannot see the consignment either, which is why it cannot set its vessel.
    expect((await call("GET", `/consignments/${s.consignment.id}`, forwarder.admin.id)).statusCode).toBe(404);
  });

  it("is the same 404 for a stranger as for a consignment that does not exist, and for a malformed id", async () => {
    const s = await scenario();
    const stranger = await createActiveOrg("importer");
    const real = await patch(s.consignment.id, stranger.admin.id, { vesselImo: VALID_IMO });
    const missing = await patch("00000000-0000-4000-8000-000000000000", stranger.admin.id, { vesselImo: VALID_IMO });
    const malformed = await patch("not-a-uuid", stranger.admin.id, { vesselImo: VALID_IMO });
    for (const res of [real, missing, malformed]) expect(res.statusCode).toBe(404);
    expect(real.json()).toEqual(missing.json());
    expect((await row(s.consignment.id)).vessel_imo).toBeNull();
  });

  it("is a 401 with no acting user", async () => {
    const s = await scenario();
    expect((await patch(s.consignment.id, undefined, { vesselImo: VALID_IMO })).statusCode).toBe(401);
  });

  it("checks permission before it looks at the body, so a stranger learns nothing from a 422", async () => {
    const s = await scenario();
    const stranger = await createActiveOrg("importer");
    expect((await patch(s.consignment.id, stranger.admin.id, { vesselImo: "nonsense" })).statusCode).toBe(404);
    // A party is allowed to try, so it is told what is wrong with the value.
    expect((await patch(s.consignment.id, s.exporterAdmin.id, { vesselImo: "nonsense" })).statusCode).toBe(422);
  });
});

describe("GET /consignments and /consignments/:id return the vessel fields", () => {
  it("returns null for all three when unset, on both the list and the detail", async () => {
    const s = await scenario();
    const detail = (await call("GET", `/consignments/${s.consignment.id}`, s.importerAdmin.id)).json();
    expect(detail).toMatchObject({ vesselImo: null, vesselMmsi: null, vesselName: null });
    const list = (await call("GET", "/consignments", s.importerAdmin.id)).json().consignments;
    expect(list[0]).toMatchObject({ vesselImo: null, vesselMmsi: null, vesselName: null });
  });

  it("returns what was set to both parties, and to a superadmin", async () => {
    const s = await scenario();
    await patch(s.consignment.id, s.importerAdmin.id, { vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
    const superadmin = await createSuperadmin();
    for (const id of [s.importerAdmin.id, s.exporterAdmin.id, superadmin.id]) {
      const detail = (await call("GET", `/consignments/${s.consignment.id}`, id)).json();
      expect(detail).toMatchObject({ vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
      const item = (await call("GET", "/consignments", id)).json().consignments[0];
      expect(item).toMatchObject({ vesselImo: VALID_IMO, vesselMmsi: VALID_MMSI, vesselName: "Sample Voyager" });
    }
  });
});

describe("the schema", () => {
  it("leaves existing consignments valid: a consignment made without vessel fields has them null", async () => {
    const parties = await createTradeParties();
    const c = await submitTestPO(parties);
    const stored = await row(c.id);
    expect([stored.vessel_imo, stored.vessel_mmsi, stored.vessel_name]).toEqual([null, null, null]);
  });

  it("refuses a malformed identifier at the database too, as a second line of defence", async () => {
    const s = await scenario();
    await expect(getDb().update(consignments).set({ vessel_imo: "123" }).where(eq(consignments.id, s.consignment.id))).rejects.toThrow();
    await expect(getDb().update(consignments).set({ vessel_mmsi: "12345678x" }).where(eq(consignments.id, s.consignment.id))).rejects.toThrow();
  });

  it("stores a position, refuses one with no identifier or out of range, and refuses the same vessel and time twice", async () => {
    const t = new Date("2026-09-19T10:00:00Z");
    const ok = { lat: 10, lng: 20, position_time: t, source: "test" };
    await getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: VALID_MMSI });
    await expect(getDb().insert(vessel_positions).values({ ...ok })).rejects.toThrow(); // no identifier
    await expect(getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: "111111111", lat: 91 })).rejects.toThrow();
    await expect(getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: "111111111", lng: -181 })).rejects.toThrow();
    await expect(getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: VALID_MMSI })).rejects.toThrow(); // duplicate
    // A different time, or a different vessel, is fine, and an IMO-only vessel is deduplicated on its IMO.
    await getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: VALID_MMSI, position_time: new Date(t.getTime() + 60_000) });
    await getDb().insert(vessel_positions).values({ ...ok, vessel_mmsi: "111111111" });
    await getDb().insert(vessel_positions).values({ ...ok, vessel_imo: VALID_IMO });
    await expect(getDb().insert(vessel_positions).values({ ...ok, vessel_imo: VALID_IMO })).rejects.toThrow();
  });
});
