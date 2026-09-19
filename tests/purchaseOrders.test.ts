import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  HttpVeriPuraCoreClient,
  StubVeriPuraCoreClient,
  createCoreClientFromEnv,
  setCoreClient,
} from "../src/core/client.js";
import { SIGNATURE_HEADER, verifySignature } from "../src/core/signature.js";
import { sendToVeriPuraCore } from "../src/core/send.js";
import { getDb } from "../src/db/client.js";
import {
  audit_log,
  consignments,
  document_types,
  purchase_orders,
  users,
  webhook_events,
} from "../src/db/schema.js";
import { PermissionDeniedError, ValidationError, VeriPuraCoreError } from "../src/errors.js";
import { buildApp } from "../src/http/app.js";
import { getFileStorage, InMemoryFileStorage, sanitizeFilename } from "../src/storage/fileStorage.js";
import {
  PO_DEFAULTS,
  RecordingCoreClient,
  checklistItemsOf,
  createActiveOrg,
  createSuperadmin,
  createTradeParties,
  createUserWithRoles,
  reloadConsignment,
  submitTestPO,
} from "./helpers.js";

const db = () => getDb();
const count = async (table: PgTable) => (await db().select().from(table)).length;

describe("submitPurchaseOrder: authorization", () => {
  it("rejects a user outside the importer org, and creates nothing", async () => {
    const parties = await createTradeParties();
    const outsider = await createActiveOrg("importer");
    const core = new RecordingCoreClient();
    setCoreClient(core);

    await expect(submitTestPO(parties, { actingUser: outsider.admin })).rejects.toThrow(PermissionDeniedError);
    // The exporter's own admin is not the importer either.
    await expect(submitTestPO(parties, { actingUser: parties.exporter.admin })).rejects.toThrow(PermissionDeniedError);

    expect(await count(consignments)).toBe(0);
    expect(await count(purchase_orders)).toBe(0);
    expect(await count(webhook_events)).toBe(0);
    // Nothing about a consignment was audited (the only audit rows are from building the orgs).
    expect(await db().select().from(audit_log).where(eq(audit_log.target_type, "consignment"))).toHaveLength(0);
    expect(core.calls).toHaveLength(0);
    expect((getFileStorage() as InMemoryFileStorage).files.size).toBe(0);
  });

  it("rejects an invited (not yet active) user of the importer org", async () => {
    const parties = await createTradeParties();
    const invited = await createUserWithRoles(parties.importer, ["Compliance User"]);
    await db().update(users).set({ status: "invited" }).where(eq(users.id, invited.id));

    await expect(submitTestPO(parties, { actingUser: invited })).rejects.toThrow(PermissionDeniedError);
    expect(await count(consignments)).toBe(0);
  });

  it("allows any active user of the importer org, not only admins", async () => {
    const parties = await createTradeParties();
    const viewer = await createUserWithRoles(parties.importer, ["Viewer"]);
    const consignment = await submitTestPO(parties, { actingUser: viewer });
    expect(consignment.created_by_user_id).toBe(viewer.id);
  });

  it("allows superadmin for any importer", async () => {
    const parties = await createTradeParties();
    const superadmin = await createSuperadmin();
    const consignment = await submitTestPO(parties, { actingUser: superadmin });
    expect(consignment.importer_org_id).toBe(parties.importer.org.id);
    expect(consignment.created_by_user_id).toBe(superadmin.id);
  });

  it("does not trust a forged organization_id on the acting user reference", async () => {
    const parties = await createTradeParties();
    const outsider = await createActiveOrg("importer");
    const forged = { id: outsider.admin.id, organization_id: parties.importer.org.id };
    await expect(submitTestPO(parties, { actingUser: forged })).rejects.toThrow(PermissionDeniedError);
  });
});

describe("submitPurchaseOrder: validation", () => {
  it("requires an active importer-type importer org and an active exporter-type exporter org", async () => {
    const parties = await createTradeParties();
    const logistics = await createActiveOrg("logistics");

    // Exporter slot filled by a logistics org.
    await expect(submitTestPO(parties, { exporterOrgId: logistics.org.id })).rejects.toThrow(ValidationError);
    // Importer slot filled by an exporter org (actor belongs to it, so authorization passes).
    await expect(
      submitTestPO(parties, { importerOrgId: parties.exporter.org.id, actingUser: parties.exporter.admin }),
    ).rejects.toThrow(ValidationError);
    // Unknown exporter.
    await expect(
      submitTestPO(parties, { exporterOrgId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(ValidationError);
    expect(await count(consignments)).toBe(0);
  });

  it("rejects the same org on both sides, an empty file, and missing fields", async () => {
    const parties = await createTradeParties();
    await expect(submitTestPO(parties, { exporterOrgId: parties.importer.org.id })).rejects.toThrow(ValidationError);
    await expect(submitTestPO(parties, { fileBuffer: Buffer.alloc(0) })).rejects.toThrow(ValidationError);
    await expect(submitTestPO(parties, { commodity: "  " })).rejects.toThrow(ValidationError);
    await expect(submitTestPO(parties, { originCountry: "" })).rejects.toThrow(ValidationError);
    expect(await count(consignments)).toBe(0);
  });
});

describe("submitPurchaseOrder with the stub core client, end to end", () => {
  it("creates the checklist and moves the consignment to checklist_received", async () => {
    const parties = await createTradeParties();
    const returned = await submitTestPO(parties, { hsCode: " 0202.30 " });

    expect(returned.status).toBe("checklist_received");
    const consignment = await reloadConsignment(returned.id);
    expect(consignment).toMatchObject({
      status: "checklist_received",
      commodity: "Frozen beef",
      hs_code: "0202.30",
      origin_country: "BR",
      destination_country: "GB",
      importer_org_id: parties.importer.org.id,
      exporter_org_id: parties.exporter.org.id,
      created_by_user_id: parties.importer.admin.id,
      external_core_id: null, // the stub never reports one
    });

    const items = await checklistItemsOf(consignment);
    const types = await db().select().from(document_types);
    const nameOf = (id: string) => types.find((t) => t.id === id)!.name;
    expect(items.map((i) => [nameOf(i.document_type_id), i.required_by, i.status]).sort()).toEqual(
      [
        ["Bill of Lading", "logistics", "awaiting_upload"],
        ["Commercial Invoice", "exporter", "awaiting_upload"],
        ["Export Health Certificate", "exporter", "awaiting_upload"],
        ["Packing List", "exporter", "awaiting_upload"],
      ].sort(),
    );
  });

  it("stores the PO file and its purchase_orders row", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties, { fileName: "../../etc/PO 1001.pdf" });

    const [po] = await db().select().from(purchase_orders).where(eq(purchase_orders.consignment_id, consignment.id));
    expect(po!.uploaded_by_user_id).toBe(parties.importer.admin.id);
    expect(po!.file_url).toMatch(/^memory:\/\/[0-9a-f-]{36}-PO_1001\.pdf$/);
    const stored = (getFileStorage() as InMemoryFileStorage).files.get(po!.file_url);
    expect(stored?.toString()).toBe(PO_DEFAULTS.fileBuffer.toString());
  });

  it("logs one outbound (sent) and one inbound (received) webhook event, with the documented payload", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties, { hsCode: "0202.30" });
    const [po] = await db().select().from(purchase_orders).where(eq(purchase_orders.consignment_id, consignment.id));

    const events = await db().select().from(webhook_events).where(eq(webhook_events.consignment_id, consignment.id));
    const outbound = events.filter((e) => e.direction === "outbound");
    const inbound = events.filter((e) => e.direction === "inbound");
    expect(outbound).toHaveLength(1);
    expect(inbound).toHaveLength(1);
    expect(outbound[0]!.status).toBe("sent");
    expect(inbound[0]!.status).toBe("received");
    expect(outbound[0]!.payload).toEqual({
      consignmentId: consignment.id,
      externalCoreId: null,
      commodity: "Frozen beef",
      hsCode: "0202.30",
      originCountry: "BR",
      destinationCountry: "GB",
      importerOrgId: parties.importer.org.id,
      exporterOrgId: parties.exporter.org.id,
      poFileUrl: po!.file_url,
    });
  });

  it("writes po_submitted, sent_to_core, and checklist_received audit rows with the right actors", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties);

    const rows = await db().select().from(audit_log).where(eq(audit_log.target_id, consignment.id));
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(byAction).sort()).toEqual([
      "consignment.checklist_received",
      "consignment.po_submitted",
      "consignment.sent_to_core",
    ]);
    for (const r of rows) expect(r.target_type).toBe("consignment");
    expect(byAction["consignment.po_submitted"]!.actor_user_id).toBe(parties.importer.admin.id);
    expect(byAction["consignment.sent_to_core"]!.actor_user_id).toBe(parties.importer.admin.id);
    expect(byAction["consignment.checklist_received"]!.actor_user_id).toBeNull(); // core is the system
    expect(byAction["consignment.checklist_received"]!.metadata).toMatchObject({ items_created: 4 });
  });
});

describe("core failure and sending", () => {
  it("keeps the PO and consignment when core is unreachable, and reports the consignment id", async () => {
    const parties = await createTradeParties();
    setCoreClient(
      new RecordingCoreClient(() => {
        throw new VeriPuraCoreError("connect ECONNREFUSED");
      }),
    );

    const error = await submitTestPO(parties).catch((e) => e);
    expect(error).toBeInstanceOf(VeriPuraCoreError);
    const saved = await reloadConsignment(error.consignmentId);
    expect(saved.status).toBe("po_submitted");
    expect(await count(purchase_orders)).toBe(1);

    const events = await db().select().from(webhook_events);
    expect(events.map((e) => [e.direction, e.status])).toEqual([["outbound", "failed"]]);
    const audits = await db().select().from(audit_log).where(eq(audit_log.target_id, saved.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["consignment.core_send_failed", "consignment.po_submitted"]);
    expect(audits.find((a) => a.action === "consignment.core_send_failed")!.metadata).toMatchObject({
      error: "connect ECONNREFUSED",
    });
  });

  it("can be retried after a failure", async () => {
    const parties = await createTradeParties();
    setCoreClient(new RecordingCoreClient(() => { throw new VeriPuraCoreError("down"); }));
    const error = await submitTestPO(parties).catch((e) => e);

    setCoreClient(new RecordingCoreClient());
    const result = await sendToVeriPuraCore({ id: error.consignmentId });
    expect(result.consignment.status).toBe("checklist_pending");
  });

  it("sending one consignment leaves another po_submitted consignment untouched", async () => {
    const parties = await createTradeParties();
    setCoreClient(new RecordingCoreClient(() => { throw new VeriPuraCoreError("down"); }));
    const stuck = (await submitTestPO(parties).catch((e) => e)).consignmentId as string;

    setCoreClient(new RecordingCoreClient()); // accepts, sends no checklist (live-like)
    const other = await submitTestPO(parties);

    expect((await reloadConsignment(other.id)).status).toBe("checklist_pending");
    expect((await reloadConsignment(stuck)).status).toBe("po_submitted");
  });

  it("refuses to send a consignment that is past the sending stage", async () => {
    const parties = await createTradeParties();
    const done = await submitTestPO(parties); // checklist_received
    await expect(sendToVeriPuraCore(done)).rejects.toThrow(ValidationError);
  });
});

describe("core clients", () => {
  it("HttpVeriPuraCoreClient POSTs the signed JSON payload and treats 2xx as accepted", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new HttpVeriPuraCoreClient({
      url: "https://core.example.test/hooks/consignments",
      secret: "shh",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    const payload = {
      consignmentId: "c1", externalCoreId: null, commodity: "Beef", hsCode: null, originCountry: "BR",
      destinationCountry: "GB", importerOrgId: "i", exporterOrgId: "e", poFileUrl: "memory://x",
    };

    const result = await client.submitConsignment(payload);
    expect(result).toEqual({}); // no synchronous checklist from the live client
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://core.example.test/hooks/consignments");
    expect(seen[0]!.init.method).toBe("POST");
    const body = seen[0]!.init.body as string;
    expect(JSON.parse(body)).toEqual(payload);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(verifySignature(Buffer.from(body), headers[SIGNATURE_HEADER], "shh")).toBe(true);
  });

  it("HttpVeriPuraCoreClient turns a non-2xx response or a network error into VeriPuraCoreError", async () => {
    const make = (impl: () => Promise<Response>) =>
      new HttpVeriPuraCoreClient({ url: "https://core.example.test", secret: "s", fetchImpl: impl as unknown as typeof fetch });
    const payload = {} as never;
    await expect(make(async () => new Response(null, { status: 500 })).submitConsignment(payload)).rejects.toThrow(
      /HTTP 500/,
    );
    await expect(make(async () => { throw new Error("socket hang up"); }).submitConsignment(payload)).rejects.toThrow(
      VeriPuraCoreError,
    );
  });

  it("a live client via the submit flow leaves the consignment checklist_pending with no items", async () => {
    const parties = await createTradeParties();
    setCoreClient(
      new HttpVeriPuraCoreClient({
        url: "https://core.example.test",
        secret: "s",
        fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const consignment = await submitTestPO(parties);
    expect(consignment.status).toBe("checklist_pending");
    expect(await checklistItemsOf(consignment)).toHaveLength(0);
  });

  it("createCoreClientFromEnv defaults to the stub and validates live mode and the delay", () => {
    expect(createCoreClientFromEnv({})).toBeInstanceOf(StubVeriPuraCoreClient);
    expect(createCoreClientFromEnv({ VERIPURA_CORE_MODE: "stub" })).toBeInstanceOf(StubVeriPuraCoreClient);
    expect(() => createCoreClientFromEnv({ VERIPURA_CORE_MODE: "live" })).toThrow(/WEBHOOK_URL/);
    expect(() => createCoreClientFromEnv({ VERIPURA_CORE_MODE: "live", VERIPURA_CORE_WEBHOOK_URL: "https://x" })).toThrow(
      /WEBHOOK_SECRET/,
    );
    expect(
      createCoreClientFromEnv({
        VERIPURA_CORE_MODE: "live",
        VERIPURA_CORE_WEBHOOK_URL: "https://x",
        VERIPURA_CORE_WEBHOOK_SECRET: "s",
      }),
    ).toBeInstanceOf(HttpVeriPuraCoreClient);
    expect(() => createCoreClientFromEnv({ VERIPURA_CORE_MODE: "bogus" })).toThrow(/stub.*live/);
    expect(() => createCoreClientFromEnv({ VERIPURA_CORE_STUB_DELAY_MS: "-5" })).toThrow(/non-negative/);
  });
});

describe("sanitizeFilename", () => {
  it.each([
    ["po-1001.pdf", "po-1001.pdf"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\PO 7.pdf", "PO_7.pdf"],
    ["..hidden", "hidden"],
    ["", "file"],
    ["///", "file"],
  ])("%j becomes %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });
});

describe("POST /purchase-orders", () => {
  const body = (parties: Awaited<ReturnType<typeof createTradeParties>>) => ({
    importerOrgId: parties.importer.org.id,
    exporterOrgId: parties.exporter.org.id,
    commodity: "Frozen beef",
    originCountry: "BR",
    destinationCountry: "GB",
    fileName: "po.pdf",
    fileBase64: Buffer.from("fake po").toString("base64"),
  });
  const post = (app: ReturnType<typeof buildApp>, payload: unknown, actorId?: string) =>
    app.inject({
      method: "POST",
      url: "/purchase-orders",
      headers: { "content-type": "application/json", ...(actorId ? { "x-acting-user-id": actorId } : {}) },
      payload: payload as object,
    });

  it("is unauthenticated (401) unless the dev actor header is explicitly enabled", async () => {
    const parties = await createTradeParties();
    const app = buildApp(); // ALLOW_DEV_ACTOR_HEADER=false in the test env
    const res = await post(app, body(parties), parties.importer.admin.id);
    expect(res.statusCode).toBe(401);
    expect(await count(consignments)).toBe(0);
  });

  it("creates a consignment (201) for an importer user when the dev header is enabled", async () => {
    const parties = await createTradeParties();
    const app = buildApp({ purchaseOrders: { allowDevActorHeader: true } });
    const res = await post(app, body(parties), parties.importer.admin.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment).toMatchObject({ status: "checklist_received", commodity: "Frozen beef" });
  });

  it("maps a user outside the importer org to 403, bad input to 400, and no header to 401", async () => {
    const parties = await createTradeParties();
    const app = buildApp({ purchaseOrders: { allowDevActorHeader: true } });
    expect((await post(app, body(parties), parties.exporter.admin.id)).statusCode).toBe(403);
    expect((await post(app, { ...body(parties), fileBase64: "not base64!" }, parties.importer.admin.id)).statusCode).toBe(400);
    expect((await post(app, { ...body(parties), commodity: "" }, parties.importer.admin.id)).statusCode).toBe(400);
    expect((await post(app, body(parties))).statusCode).toBe(401);
    expect((await post(app, body(parties), "00000000-0000-4000-8000-000000000000")).statusCode).toBe(401);
    expect(await count(consignments)).toBe(0);
  });

  it("maps an unreachable core to 502 and returns the saved consignment id", async () => {
    const parties = await createTradeParties();
    setCoreClient(new RecordingCoreClient(() => { throw new VeriPuraCoreError("down"); }));
    const app = buildApp({ purchaseOrders: { allowDevActorHeader: true } });
    const res = await post(app, body(parties), parties.importer.admin.id);
    expect(res.statusCode).toBe(502);
    const saved = await db().select().from(consignments);
    expect(res.json()).toMatchObject({ error: "core_unavailable", consignmentId: saved[0]!.id });
  });
});
