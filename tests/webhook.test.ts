import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setCoreClient } from "../src/core/client.js";
import { signBody, verifySignature } from "../src/core/signature.js";
import { parseChecklistPayload } from "../src/core/validate.js";
import { getDb } from "../src/db/client.js";
import {
  audit_log,
  consignments,
  document_checklist_items,
  document_types,
  webhook_events,
} from "../src/db/schema.js";
import { ValidationError } from "../src/errors.js";
import { buildApp } from "../src/http/app.js";
import {
  RecordingCoreClient,
  TEST_WEBHOOK_SECRET,
  checklistItemsOf,
  createTradeParties,
  postChecklist,
  reloadConsignment,
  submitTestPO,
} from "./helpers.js";

const db = () => getDb();

/** A consignment sitting at checklist_pending, as it would be while waiting for real core. */
async function pendingConsignment() {
  const parties = await createTradeParties();
  setCoreClient(new RecordingCoreClient()); // accepts, returns no checklist (live-like)
  const consignment = await submitTestPO(parties);
  expect(consignment.status).toBe("checklist_pending");
  return { parties, consignment };
}

const twoDocs = (consignmentId: string, extra: Record<string, unknown> = {}) => ({
  consignmentId,
  ...extra,
  requiredDocuments: [
    { documentTypeName: "Commercial Invoice", requiredBy: "exporter" },
    { documentTypeName: "Bill of Lading", requiredBy: "logistics" },
  ],
});

async function eventsFor(consignmentId: string) {
  return db().select().from(webhook_events).where(eq(webhook_events.consignment_id, consignmentId));
}

describe("POST /webhooks/veripura-core/checklist: signature verification", () => {
  it("rejects an invalid signature with 401 and changes nothing", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    const body = twoDocs(consignment.id, { externalCoreId: "CORE-1" });
    const eventsBefore = (await db().select().from(webhook_events)).length;
    const auditBefore = (await db().select().from(audit_log)).length;

    const attempts = [
      await postChecklist(app, body, { signature: "0".repeat(64) }), // well-formed but wrong
      await postChecklist(app, body, { signature: signBody("a different body", TEST_WEBHOOK_SECRET) }),
      await postChecklist(app, body, { secret: "wrong-secret" }),
      await postChecklist(app, body, { signature: null }), // header missing
      await postChecklist(app, body, { signature: "not-hex" }),
      await postChecklist(app, body, { signature: "" }),
    ];
    for (const res of attempts) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_signature" });
    }

    expect(await checklistItemsOf(consignment)).toHaveLength(0);
    const after = await reloadConsignment(consignment.id);
    expect(after.status).toBe("checklist_pending");
    expect(after.external_core_id).toBeNull();
    // Unauthenticated calls leave no trace at all: no event rows, no audit rows.
    expect(await db().select().from(webhook_events)).toHaveLength(eventsBefore);
    expect(await db().select().from(audit_log)).toHaveLength(auditBefore);
  });

  it("rejects a valid signature computed over a different (tampered) body", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    const signedBody = JSON.stringify(twoDocs(consignment.id));
    const tampered = JSON.stringify({ ...twoDocs(consignment.id), externalCoreId: "ATTACKER" });

    const res = await postChecklist(app, tampered, { signature: signBody(signedBody, TEST_WEBHOOK_SECRET) });
    expect(res.statusCode).toBe(401);
    expect((await reloadConsignment(consignment.id)).external_core_id).toBeNull();
  });

  it("accepts a valid signature, with or without the sha256= prefix", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    const raw = JSON.stringify(twoDocs(consignment.id));
    const res = await postChecklist(app, raw, { signature: `sha256=${signBody(raw, TEST_WEBHOOK_SECRET)}` });
    expect(res.statusCode).toBe(200);
  });

  it("refuses everything (503) rather than skipping the check when no secret is configured", async () => {
    const { consignment } = await pendingConsignment();
    const previous = process.env.VERIPURA_CORE_WEBHOOK_SECRET;
    process.env.VERIPURA_CORE_WEBHOOK_SECRET = "";
    try {
      const app = buildApp();
      const raw = JSON.stringify(twoDocs(consignment.id));
      const res = await postChecklist(app, raw, { signature: signBody(raw, "") });
      expect(res.statusCode).toBe(503);
      expect(await checklistItemsOf(consignment)).toHaveLength(0);
    } finally {
      process.env.VERIPURA_CORE_WEBHOOK_SECRET = previous;
    }
  });

  it("verifySignature edge cases", () => {
    const body = Buffer.from('{"a":1}');
    const good = signBody(body, "k");
    expect(verifySignature(body, good, "k")).toBe(true);
    expect(verifySignature(body, good.toUpperCase(), "k")).toBe(true);
    expect(verifySignature(body, `sha256=${good}`, "k")).toBe(true);
    expect(verifySignature(body, good, "other")).toBe(false);
    expect(verifySignature(body, good, "")).toBe(false); // an empty secret verifies nothing
    expect(verifySignature(body, undefined, "k")).toBe(false);
    expect(verifySignature(body, good.slice(0, 62), "k")).toBe(false);
    expect(verifySignature(body, `${good}00`, "k")).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), good, "k")).toBe(false);
  });
});

describe("POST /webhooks/veripura-core/checklist: applying a checklist", () => {
  it("creates awaiting_upload checklist items, moves the consignment to checklist_received, and logs it", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();

    const res = await postChecklist(app, twoDocs(consignment.id));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      consignmentId: consignment.id,
      status: "checklist_received",
      itemsCreated: 2,
      duplicate: false,
    });

    const items = await checklistItemsOf(consignment);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "awaiting_upload")).toBe(true);
    expect(items.map((i) => i.required_by).sort()).toEqual(["exporter", "logistics"]);
    expect((await reloadConsignment(consignment.id)).status).toBe("checklist_received");

    const inbound = (await eventsFor(consignment.id)).filter((e) => e.direction === "inbound");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.status).toBe("received");

    const audits = (await db().select().from(audit_log).where(eq(audit_log.target_id, consignment.id))).filter(
      (a) => a.action === "consignment.checklist_received",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: null, target_type: "consignment" });
  });

  it("replaying the same payload twice does not duplicate checklist items", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    const body = twoDocs(consignment.id);

    const first = await postChecklist(app, body);
    const second = await postChecklist(app, body);
    const third = await postChecklist(app, body);

    expect(first.json()).toMatchObject({ itemsCreated: 2, duplicate: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ itemsCreated: 0, duplicate: true });
    expect(third.json()).toMatchObject({ itemsCreated: 0, duplicate: true });

    expect(await checklistItemsOf(consignment)).toHaveLength(2);
    expect(await db().select().from(document_types)).toHaveLength(2);
    // Every call is logged as a webhook event, but the audit trail only records the real change.
    expect((await eventsFor(consignment.id)).filter((e) => e.direction === "inbound")).toHaveLength(3);
    const audits = await db().select().from(audit_log).where(eq(audit_log.action, "consignment.checklist_received"));
    expect(audits).toHaveLength(1);
  });

  it("stays idempotent when the same payload arrives concurrently", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    const body = twoDocs(consignment.id, { externalCoreId: "CORE-77" });

    const results = await Promise.all(Array.from({ length: 6 }, () => postChecklist(app, body)));

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.reduce((n, r) => n + r.json().itemsCreated, 0)).toBe(2);
    expect(await checklistItemsOf(consignment)).toHaveLength(2);
    expect((await reloadConsignment(consignment.id)).external_core_id).toBe("CORE-77");
  });

  it("a replay that adds a new document adds only that item", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id));

    const res = await postChecklist(app, {
      consignmentId: consignment.id,
      requiredDocuments: [
        { documentTypeName: "Commercial Invoice", requiredBy: "exporter" },
        { documentTypeName: "Certificate of Origin", requiredBy: "exporter" },
      ],
    });
    expect(res.json()).toMatchObject({ itemsCreated: 1, duplicate: false });
    expect(await checklistItemsOf(consignment)).toHaveLength(3);
  });

  it("matches document types by name ignoring case instead of creating a second one", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await db().insert(document_types).values({ name: "Bill of Lading", category: "Customs & logistics" });

    await postChecklist(app, {
      consignmentId: consignment.id,
      requiredDocuments: [{ documentTypeName: "  bill of LADING ", requiredBy: "logistics" }],
    });

    const types = await db().select().from(document_types);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ name: "Bill of Lading", category: "Customs & logistics" });
    expect(await checklistItemsOf(consignment)).toHaveLength(1);
  });

  it("collapses duplicate entries inside a single payload", async () => {
    const { consignment } = await pendingConsignment();
    const res = await postChecklist(buildApp(), {
      consignmentId: consignment.id,
      requiredDocuments: [
        { documentTypeName: "Packing List", requiredBy: "exporter" },
        { documentTypeName: "packing list", requiredBy: "exporter" },
      ],
    });
    expect(res.json().itemsCreated).toBe(1);
  });

  it("does not pull an active consignment back to checklist_received", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id));
    await db().update(consignments).set({ status: "active" }).where(eq(consignments.id, consignment.id));

    const res = await postChecklist(app, {
      consignmentId: consignment.id,
      requiredDocuments: [{ documentTypeName: "Packing List", requiredBy: "exporter" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "active", itemsCreated: 1 });
  });
});

describe("POST /webhooks/veripura-core/checklist: externalCoreId", () => {
  it("populates external_core_id when it is still null", async () => {
    const { consignment } = await pendingConsignment();
    expect(consignment.external_core_id).toBeNull();

    const res = await postChecklist(buildApp(), twoDocs(consignment.id, { externalCoreId: "CORE-1001" }));
    expect(res.statusCode).toBe(200);
    expect((await reloadConsignment(consignment.id)).external_core_id).toBe("CORE-1001");
  });

  it("does not overwrite an existing value: a second payload with a different id is ignored", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "CORE-FIRST" }));

    const res = await postChecklist(app, {
      consignmentId: consignment.id,
      externalCoreId: "CORE-SECOND",
      requiredDocuments: [{ documentTypeName: "Packing List", requiredBy: "exporter" }],
    });
    expect(res.statusCode).toBe(200);
    expect((await reloadConsignment(consignment.id)).external_core_id).toBe("CORE-FIRST");

    const audits = await db().select().from(audit_log).where(eq(audit_log.action, "consignment.checklist_received"));
    const second = audits.find((a) => (a.metadata as { external_core_id_ignored?: string }).external_core_id_ignored);
    expect(second!.metadata).toMatchObject({ external_core_id_ignored: "CORE-SECOND" });
  });

  it("first write wins even when the second payload adds nothing else", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "CORE-A" }));
    const res = await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "CORE-B" }));

    expect(res.json()).toMatchObject({ duplicate: true, itemsCreated: 0 });
    expect((await reloadConsignment(consignment.id)).external_core_id).toBe("CORE-A");
  });

  it("re-sending the same externalCoreId is harmless", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "CORE-A" }));
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "CORE-A" }));
    expect((await reloadConsignment(consignment.id)).external_core_id).toBe("CORE-A");
  });

  it("treats a blank or null externalCoreId as absent", async () => {
    const { consignment } = await pendingConsignment();
    const app = buildApp();
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: "   " }));
    await postChecklist(app, twoDocs(consignment.id, { externalCoreId: null }));
    expect((await reloadConsignment(consignment.id)).external_core_id).toBeNull();
  });
});

describe("POST /webhooks/veripura-core/checklist: bad input after a valid signature", () => {
  it.each([
    ["invalid JSON", "{not json", /valid JSON/],
    ["a JSON array", "[]", /JSON object/],
    ["a non-UUID consignmentId", JSON.stringify({ consignmentId: "abc", requiredDocuments: [] }), /UUID/],
  ])("400 for %s", async (_label, raw, message) => {
    const res = await postChecklist(buildApp(), raw as string);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(message);
  });

  it.each([
    ["empty requiredDocuments", (id: string) => ({ consignmentId: id, requiredDocuments: [] }), /non-empty/],
    ["missing requiredDocuments", (id: string) => ({ consignmentId: id }), /non-empty/],
    [
      "an unknown requiredBy",
      (id: string) => ({ consignmentId: id, requiredDocuments: [{ documentTypeName: "X", requiredBy: "farmer" }] }),
      /requiredBy/,
    ],
    [
      "a blank documentTypeName",
      (id: string) => ({ consignmentId: id, requiredDocuments: [{ documentTypeName: "  ", requiredBy: "exporter" }] }),
      /documentTypeName/,
    ],
    [
      "a non-string externalCoreId",
      (id: string) => ({ consignmentId: id, externalCoreId: 42, requiredDocuments: [{ documentTypeName: "X", requiredBy: "exporter" }] }),
      /externalCoreId/,
    ],
  ])("400 for %s, and nothing is created", async (_label, build, message) => {
    const { consignment } = await pendingConsignment();
    const res = await postChecklist(buildApp(), build(consignment.id));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(message);
    expect(await checklistItemsOf(consignment)).toHaveLength(0);
    expect((await reloadConsignment(consignment.id)).status).toBe("checklist_pending");
  });

  it("404 for an unknown consignment, logged as a failed inbound event with no consignment", async () => {
    const res = await postChecklist(buildApp(), twoDocs("00000000-0000-4000-8000-000000000000"));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "consignment_not_found" });
    const events = await db().select().from(webhook_events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "inbound", status: "failed", consignment_id: null });
    expect(await db().select().from(document_types)).toHaveLength(0);
  });

  it("409 for a cancelled consignment, logged as failed against that consignment", async () => {
    const { consignment } = await pendingConsignment();
    await db().update(consignments).set({ status: "cancelled" }).where(eq(consignments.id, consignment.id));

    const res = await postChecklist(buildApp(), twoDocs(consignment.id));
    expect(res.statusCode).toBe(409);
    expect(await checklistItemsOf(consignment)).toHaveLength(0);
    const failed = (await eventsFor(consignment.id)).filter((e) => e.status === "failed");
    expect(failed).toHaveLength(1);
  });

  it("415 for a non-JSON content type", async () => {
    const res = await buildApp().inject({
      method: "POST",
      url: "/webhooks/veripura-core/checklist",
      headers: { "content-type": "text/plain" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("parseChecklistPayload", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("trims, normalizes, and de-duplicates", () => {
    expect(
      parseChecklistPayload({
        consignmentId: id,
        externalCoreId: "  CORE-9 ",
        requiredDocuments: [
          { documentTypeName: " Packing List ", requiredBy: "exporter" },
          { documentTypeName: "PACKING LIST", requiredBy: "exporter" },
          { documentTypeName: "Packing List", requiredBy: "importer" },
        ],
      }),
    ).toEqual({
      consignmentId: id,
      externalCoreId: "CORE-9",
      requiredDocuments: [
        { documentTypeName: "Packing List", requiredBy: "exporter" },
        { documentTypeName: "Packing List", requiredBy: "importer" },
      ],
    });
  });

  it("rejects oversized payloads and non-objects", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ documentTypeName: `Doc ${i}`, requiredBy: "exporter" }));
    expect(() => parseChecklistPayload({ consignmentId: id, requiredDocuments: many })).toThrow(ValidationError);
    expect(() => parseChecklistPayload(null)).toThrow(ValidationError);
    expect(() => parseChecklistPayload("x")).toThrow(ValidationError);
  });
});

describe("checklist items and the stub path share one code path", () => {
  it("the stub's synchronous checklist and a webhook replay of it do not double up", async () => {
    const parties = await createTradeParties();
    const consignment = await submitTestPO(parties); // stub applies its checklist immediately
    const before = await checklistItemsOf(consignment);
    expect(before).toHaveLength(4);

    const res = await postChecklist(buildApp(), {
      consignmentId: consignment.id,
      requiredDocuments: [
        { documentTypeName: "commercial invoice", requiredBy: "exporter" },
        { documentTypeName: "Bill of Lading", requiredBy: "logistics" },
      ],
    });
    expect(res.json()).toMatchObject({ itemsCreated: 0, duplicate: true });
    expect(await db().select().from(document_checklist_items)).toHaveLength(4);
  });
});
