import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setCoreClient } from "../src/core/client.js";
import { getDb } from "../src/db/client.js";
import { audit_log, consignments, purchase_orders, users } from "../src/db/schema.js";
import { VeriPuraCoreError } from "../src/errors.js";
import { buildApp } from "../src/http/app.js";
import { MAX_PO_FILE_BYTES } from "../src/http/consignments.js";
import { getFileStorage, InMemoryFileStorage } from "../src/storage/fileStorage.js";
import {
  RecordingCoreClient,
  createActiveOrg,
  createSuperadmin,
  createTradeParties,
  createUserWithRoles,
} from "./helpers.js";

const db = () => getDb();
const app = buildApp({ actor: { allowDevActorHeader: true } });

interface FormFile {
  /** The form field name. The endpoint only accepts "file". */
  field?: string;
  name: string;
  content: Buffer;
}

/** Builds a real multipart/form-data body. app.inject has no form helper of its own. */
function form(fields: Record<string, string>, file?: FormFile) {
  const boundary = `----vptest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? "file"}"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      file.content,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const PO_FILE: FormFile = { name: "po-1001.pdf", content: Buffer.from("%PDF-1.4 a real-looking purchase order") };

/** Pass `null` for no file at all (an `undefined` would fall back to the default file). */
const submit = (actorId: string | undefined, fields: Record<string, string>, file: FormFile | null = PO_FILE) => {
  const { payload, contentType } = form(fields, file ?? undefined);
  return app.inject({
    method: "POST",
    url: "/consignments",
    headers: { "content-type": contentType, ...(actorId ? { "x-dev-user": actorId } : {}) },
    payload,
  });
};

const goodFields = (exporterOrgId: string): Record<string, string> => ({
  exporterOrgId,
  commodity: "Frozen beef",
  originCountry: "BR",
  destinationCountry: "GB",
});

describe("POST /consignments (multipart)", () => {
  it("creates a consignment from the form, derives the importer from the acting user, and stores the file", async () => {
    const p = await createTradeParties();
    const res = await submit(p.importer.admin.id, { ...goodFields(p.exporter.org.id), hsCode: "0202.30" });

    expect(res.statusCode).toBe(201);
    const c = res.json().consignment;
    expect(c).toMatchObject({
      status: "checklist_received", // the stub core answers at once
      commodity: "Frozen beef",
      hsCode: "0202.30",
      originCountry: "BR",
      destinationCountry: "GB",
      importerOrg: { id: p.importer.org.id, name: p.importer.org.name },
      exporterOrg: { id: p.exporter.org.id, name: p.exporter.org.name },
    });

    const [po] = await db().select().from(purchase_orders).where(eq(purchase_orders.consignment_id, c.id));
    expect(po!.uploaded_by_user_id).toBe(p.importer.admin.id);
    expect((getFileStorage() as InMemoryFileStorage).files.get(po!.file_url)?.toString()).toBe(PO_FILE.content.toString());

    const audit = (await db().select().from(audit_log).where(eq(audit_log.target_id, c.id))).find((a) => a.action === "consignment.po_submitted")!;
    expect(audit).toMatchObject({ actor_user_id: p.importer.admin.id, target_type: "consignment" });
  });

  it("returns a consignment the UI can go straight to, and both parties can then see it", async () => {
    const p = await createTradeParties();
    const created = (await submit(p.importer.admin.id, goodFields(p.exporter.org.id))).json().consignment;

    const detail = await app.inject({ method: "GET", url: `/consignments/${created.id}`, headers: { "x-dev-user": p.importer.admin.id } });
    expect(detail.statusCode).toBe(200);
    const exporterList = (await app.inject({ method: "GET", url: "/consignments", headers: { "x-dev-user": p.exporter.admin.id } })).json().consignments;
    expect(exporterList.map((c: { id: string }) => c.id)).toEqual([created.id]);
  });

  it("allows any active user of the importer organization, not only admins", async () => {
    const p = await createTradeParties();
    const viewer = await createUserWithRoles(p.importer, ["Viewer"]);
    const res = await submit(viewer.id, goodFields(p.exporter.org.id));
    expect(res.statusCode).toBe(201);
    expect((await db().select().from(consignments))[0]!.created_by_user_id).toBe(viewer.id);
  });

  it("ignores a submitted importerOrgId for an ordinary user: they cannot submit for another importer", async () => {
    const mine = await createTradeParties();
    const other = await createActiveOrg("importer");
    const res = await submit(mine.importer.admin.id, { ...goodFields(mine.exporter.org.id), importerOrgId: other.org.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment.importerOrg.id).toBe(mine.importer.org.id);
    expect((await db().select().from(consignments)).every((c) => c.importer_org_id === mine.importer.org.id)).toBe(true);
  });

  it("refuses users of non-importer organizations (403), creating nothing", async () => {
    const p = await createTradeParties();
    const logistics = await createActiveOrg("logistics");
    for (const user of [p.exporter.admin, logistics.admin]) {
      expect((await submit(user.id, goodFields(p.exporter.org.id))).statusCode).toBe(403);
    }
    expect(await db().select().from(consignments)).toHaveLength(0);
    expect(await db().select().from(purchase_orders)).toHaveLength(0);
  });

  it("is 401 without a user, and 403 for an inactive one", async () => {
    const p = await createTradeParties();
    expect((await submit(undefined, goodFields(p.exporter.org.id))).statusCode).toBe(401);
    const inactive = await createUserWithRoles(p.importer, ["Viewer"]);
    await db().update(users).set({ status: "deactivated" }).where(eq(users.id, inactive.id));
    expect((await submit(inactive.id, goodFields(p.exporter.org.id))).statusCode).toBe(403);
  });
});

describe("POST /consignments: superadmin", () => {
  it("must name the importer: 400 without importerOrgId or with a malformed one, 201 with a valid one", async () => {
    const p = await createTradeParties();
    const superadmin = await createSuperadmin();
    expect((await submit(superadmin.id, goodFields(p.exporter.org.id))).statusCode).toBe(400);
    expect((await submit(superadmin.id, { ...goodFields(p.exporter.org.id), importerOrgId: "nope" })).statusCode).toBe(400);

    const ok = await submit(superadmin.id, { ...goodFields(p.exporter.org.id), importerOrgId: p.importer.org.id });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().consignment.importerOrg.id).toBe(p.importer.org.id);
    expect((await db().select().from(consignments))[0]!.created_by_user_id).toBe(superadmin.id);
  });
});

describe("POST /consignments: validation", () => {
  it("returns 400, never 500, for a malformed or unknown exporter id", async () => {
    const p = await createTradeParties();
    for (const bad of ["nope", "", "00000000-0000-4000-8000-000000000000"]) {
      const res = await submit(p.importer.admin.id, { ...goodFields(p.exporter.org.id), exporterOrgId: bad });
      expect(res.statusCode, `exporterOrgId "${bad}"`).toBe(400);
    }
    expect(await db().select().from(consignments)).toHaveLength(0);
  });

  it("refuses an exporter that is not an exporter organization, or is not active", async () => {
    const p = await createTradeParties();
    const logistics = await createActiveOrg("logistics");
    expect((await submit(p.importer.admin.id, goodFields(logistics.org.id))).statusCode).toBe(400);
    expect((await submit(p.importer.admin.id, goodFields(p.importer.org.id))).statusCode).toBe(400);
  });

  it.each(["commodity", "originCountry", "destinationCountry"])("requires %s", async (missing) => {
    const p = await createTradeParties();
    const fields = goodFields(p.exporter.org.id);
    delete fields[missing];
    expect((await submit(p.importer.admin.id, fields)).statusCode).toBe(400);
    expect((await submit(p.importer.admin.id, { ...fields, [missing]: "   " })).statusCode).toBe(400);
    expect(await db().select().from(consignments)).toHaveLength(0);
  });

  it("requires a non-empty file, sent in the field named file", async () => {
    const p = await createTradeParties();
    const fields = goodFields(p.exporter.org.id);
    expect((await submit(p.importer.admin.id, fields, null)).statusCode).toBe(400);
    expect((await submit(p.importer.admin.id, fields, { name: "empty.pdf", content: Buffer.alloc(0) })).statusCode).toBe(400);
    expect((await submit(p.importer.admin.id, fields, { ...PO_FILE, field: "attachment" })).statusCode).toBe(400);
    expect(await db().select().from(consignments)).toHaveLength(0);
  });

  it("refuses a request that is not multipart", async () => {
    const p = await createTradeParties();
    const res = await app.inject({
      method: "POST",
      url: "/consignments",
      headers: { "x-dev-user": p.importer.admin.id, "content-type": "application/json" },
      payload: goodFields(p.exporter.org.id),
    });
    expect(res.statusCode).toBe(400);
    expect(await db().select().from(consignments)).toHaveLength(0);
  });

  it("refuses a file over the size limit (413) and creates nothing", async () => {
    const p = await createTradeParties();
    const big: FormFile = { name: "huge.pdf", content: Buffer.alloc(MAX_PO_FILE_BYTES + 1, 1) };
    const res = await submit(p.importer.admin.id, goodFields(p.exporter.org.id), big);
    expect(res.statusCode).toBe(413);
    expect(await db().select().from(consignments)).toHaveLength(0);
  });

  it("keeps a hostile file name from escaping storage", async () => {
    const p = await createTradeParties();
    const res = await submit(p.importer.admin.id, goodFields(p.exporter.org.id), { name: "../../etc/passwd", content: Buffer.from("x") });
    expect(res.statusCode).toBe(201);
    const [po] = await db().select().from(purchase_orders);
    expect(po!.file_url).toMatch(/^memory:\/\/[0-9a-f-]{36}-passwd$/);
  });
});

describe("POST /consignments: core", () => {
  it("answers 502 with the saved consignment id when core is unreachable, and the PO is kept", async () => {
    const p = await createTradeParties();
    setCoreClient(new RecordingCoreClient(() => { throw new VeriPuraCoreError("core is down"); }));
    const res = await submit(p.importer.admin.id, goodFields(p.exporter.org.id));

    expect(res.statusCode).toBe(502);
    const [saved] = await db().select().from(consignments);
    expect(res.json()).toMatchObject({ error: "core_unavailable", consignmentId: saved!.id });
    expect(saved!.status).toBe("po_submitted");
    expect(await db().select().from(purchase_orders)).toHaveLength(1);
  });

  it("with a core that sends no checklist yet, the consignment waits in checklist_pending", async () => {
    const p = await createTradeParties();
    setCoreClient(new RecordingCoreClient());
    const res = await submit(p.importer.admin.id, goodFields(p.exporter.org.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().consignment.status).toBe("checklist_pending");
  });
});

describe("the older JSON endpoint is unaffected", () => {
  it("POST /purchase-orders still works beside the multipart endpoint", async () => {
    const p = await createTradeParties();
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      headers: { "content-type": "application/json", "x-dev-user": p.importer.admin.id },
      payload: {
        importerOrgId: p.importer.org.id,
        exporterOrgId: p.exporter.org.id,
        commodity: "Frozen beef",
        originCountry: "BR",
        destinationCountry: "GB",
        fileName: "po.pdf",
        fileBase64: Buffer.from("fake po").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
