import { eq } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { sendToVeriPuraCore } from "../core/send.js";
import { getDb } from "../db/client.js";
import { consignments, organizations, purchase_orders, type Consignment } from "../db/schema.js";
import { PermissionDeniedError, ValidationError } from "../errors.js";
import { uploadFile } from "../storage/fileStorage.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";
import { applyChecklist } from "./checklist.js";

export interface SubmitPurchaseOrderInput {
  importerOrgId: string;
  exporterOrgId: string;
  commodity: string;
  hsCode?: string | null;
  originCountry: string;
  destinationCountry: string;
  fileBuffer: Buffer;
  fileName: string;
  actingUser: UserRef;
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ValidationError(`${field} is required`);
  return text;
}

/**
 * Importer submits a purchase order addressed to an exporter, which creates a consignment.
 *
 * Authorization: the actor must be an active user of the importer org, or superadmin. A finer
 * per-action grant is out of scope for this stage, so any active importer-org user may submit.
 * The check runs before any organization lookup so an unauthorized caller learns nothing about
 * which orgs exist. The importer org must be an active `importer`, the exporter org an active
 * `exporter`.
 *
 * Flow: upload the PO file, then in one transaction create the consignment (po_submitted), the
 * purchase_orders row, and audit "consignment.po_submitted". Then send to VeriPura core, which
 * moves it to checklist_pending. If the client answers with a checklist (the stub does), it is
 * applied at once and the consignment ends in checklist_received.
 *
 * If core cannot be reached the PO and consignment are kept, and a VeriPuraCoreError carrying
 * the consignment id is thrown so the caller can retry sendToVeriPuraCore.
 */
export async function submitPurchaseOrder(input: SubmitPurchaseOrderInput): Promise<Consignment> {
  const actor = await loadActiveActor(input.actingUser);
  if (!isSuperadmin(actor) && actor.organization_id !== input.importerOrgId) {
    throw new PermissionDeniedError("You can only submit purchase orders for your own organization");
  }

  const commodity = requiredText(input.commodity, "commodity");
  const originCountry = requiredText(input.originCountry, "originCountry");
  const destinationCountry = requiredText(input.destinationCountry, "destinationCountry");
  const fileName = requiredText(input.fileName, "fileName");
  const hsCode = input.hsCode?.trim() || null;
  if (!Buffer.isBuffer(input.fileBuffer) || input.fileBuffer.length === 0) {
    throw new ValidationError("The purchase order file is empty");
  }
  if (input.importerOrgId === input.exporterOrgId) {
    throw new ValidationError("Importer and exporter must be different organizations");
  }

  const db = getDb();
  const [importer] = await db.select().from(organizations).where(eq(organizations.id, input.importerOrgId));
  const [exporter] = await db.select().from(organizations).where(eq(organizations.id, input.exporterOrgId));
  if (!importer || importer.org_type !== "importer" || importer.status !== "active") {
    throw new ValidationError("importerOrgId must be an active importer organization");
  }
  if (!exporter || exporter.org_type !== "exporter" || exporter.status !== "active") {
    throw new ValidationError("exporterOrgId must be an active exporter organization");
  }

  const fileUrl = await uploadFile(input.fileBuffer, fileName);

  const consignment = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(consignments)
      .values({
        importer_org_id: importer.id,
        exporter_org_id: exporter.id,
        status: "po_submitted",
        commodity,
        hs_code: hsCode,
        origin_country: originCountry,
        destination_country: destinationCountry,
        created_by_user_id: actor.id,
      })
      .returning();
    const [po] = await tx
      .insert(purchase_orders)
      .values({ consignment_id: created!.id, file_url: fileUrl, uploaded_by_user_id: actor.id })
      .returning();

    await recordAudit(
      {
        actorUser: actor,
        action: "consignment.po_submitted",
        targetType: "consignment",
        targetId: created!.id,
        metadata: {
          importer_org_id: importer.id,
          exporter_org_id: exporter.id,
          commodity,
          purchase_order_id: po!.id,
          file_name: fileName,
        },
      },
      tx,
    );
    return created!;
  });

  const sent = await sendToVeriPuraCore(consignment, actor);
  if (sent.checklist) {
    const applied = await applyChecklist(sent.checklist, null);
    return applied.consignment;
  }
  return sent.consignment;
}
