import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb } from "../db/client.js";
import { consignments, purchase_orders, webhook_events, type Consignment } from "../db/schema.js";
import { NotFoundError, ValidationError, VeriPuraCoreError } from "../errors.js";
import type { UserRef } from "../types.js";
import { getCoreClient } from "./client.js";
import type { CoreChecklistPayload, CoreConsignmentPayload } from "./types.js";

/**
 * Sends a consignment (with its PO file location) to VeriPura core.
 *
 * The network call happens outside any database transaction so a slow core never holds locks.
 * On success: an outbound webhook_events row (sent), status po_submitted -> checklist_pending,
 * and audit "consignment.sent_to_core". On failure: an outbound webhook_events row (failed),
 * the consignment stays where it was, audit "consignment.core_send_failed", and a
 * VeriPuraCoreError carrying the consignment id is thrown so the caller can retry.
 *
 * Returns the refreshed consignment and, only when the client answered with one (the stub),
 * the checklist for the caller to apply.
 */
export async function sendToVeriPuraCore(
  consignment: Pick<Consignment, "id">,
  actingUser: UserRef | null = null,
): Promise<{ consignment: Consignment; checklist?: CoreChecklistPayload }> {
  const db = getDb();

  const [current] = await db.select().from(consignments).where(eq(consignments.id, consignment.id));
  if (!current) throw new NotFoundError(`Consignment ${consignment.id} not found`);
  if (current.status !== "po_submitted" && current.status !== "checklist_pending") {
    throw new ValidationError(`Cannot send consignment ${current.id} to core: status is ${current.status}`);
  }
  const [po] = await db
    .select()
    .from(purchase_orders)
    .where(eq(purchase_orders.consignment_id, current.id))
    .orderBy(desc(purchase_orders.uploaded_at))
    .limit(1);
  if (!po) throw new ValidationError(`Consignment ${current.id} has no purchase order to send`);

  const payload: CoreConsignmentPayload = {
    consignmentId: current.id,
    externalCoreId: current.external_core_id,
    commodity: current.commodity,
    hsCode: current.hs_code,
    originCountry: current.origin_country,
    destinationCountry: current.destination_country,
    importerOrgId: current.importer_org_id,
    exporterOrgId: current.exporter_org_id,
    poFileUrl: po.file_url,
  };

  let result;
  try {
    result = await getCoreClient().submitConsignment(payload);
  } catch (err) {
    const message = (err as Error).message;
    await db.transaction(async (tx) => {
      await tx.insert(webhook_events).values({
        consignment_id: current.id,
        direction: "outbound",
        payload: payload as unknown as Record<string, unknown>,
        status: "failed",
      });
      await recordAudit(
        {
          actorUser: actingUser,
          action: "consignment.core_send_failed",
          targetType: "consignment",
          targetId: current.id,
          metadata: { error: message },
        },
        tx,
      );
    });
    throw new VeriPuraCoreError(message, current.id);
  }

  const updated = await db.transaction(async (tx) => {
    await tx.insert(webhook_events).values({
      consignment_id: current.id,
      direction: "outbound",
      payload: payload as unknown as Record<string, unknown>,
      status: "sent",
    });
    // Only advance from po_submitted. A resend from checklist_pending changes nothing, and a
    // fast callback that already moved the consignment past pending must not be pulled back.
    const [row] = await tx
      .update(consignments)
      .set({ status: "checklist_pending" })
      .where(and(eq(consignments.id, current.id), eq(consignments.status, "po_submitted")))
      .returning();
    await recordAudit(
      {
        actorUser: actingUser,
        action: "consignment.sent_to_core",
        targetType: "consignment",
        targetId: current.id,
        metadata: { previous_status: current.status },
      },
      tx,
    );
    if (row) return row;
    const [unchanged] = await tx.select().from(consignments).where(eq(consignments.id, current.id));
    return unchanged!;
  });

  return { consignment: updated, checklist: result.checklist };
}
