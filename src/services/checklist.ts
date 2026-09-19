import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb, type Tx } from "../db/client.js";
import {
  consignments,
  document_checklist_items,
  document_types,
  webhook_events,
  type Consignment,
  type DocumentType,
} from "../db/schema.js";
import type { CoreChecklistPayload } from "../core/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { UserRef } from "../types.js";

const ACCEPTS_CHECKLIST = new Set<Consignment["status"]>([
  "po_submitted",
  "checklist_pending",
  "checklist_received",
  "active",
]);

export interface ApplyChecklistResult {
  consignment: Consignment;
  itemsCreated: number;
  /** True when the payload changed nothing, that is, a replay of one already applied. */
  duplicate: boolean;
}

/**
 * Applies a checklist from VeriPura core to a consignment. This is the single code path for
 * both the inbound webhook endpoint and the stub client's synchronous response.
 *
 * Idempotent: items are unique per (consignment, document type, requiredBy), so replaying a
 * payload creates nothing new and returns duplicate: true. externalCoreId is first-write-wins:
 * it is stored only if the consignment has none, and a later different value is ignored (and
 * noted in the audit metadata). Status moves to checklist_received only from po_submitted or
 * checklist_pending, never backwards from active.
 *
 * Every call logs an inbound webhook_events row. Audit "consignment.checklist_received" is
 * written only when something actually changed, so a replay does not pad the trail.
 */
export async function applyChecklist(
  payload: CoreChecklistPayload,
  actingUser: UserRef | null = null,
): Promise<ApplyChecklistResult> {
  return getDb().transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(consignments)
      .where(eq(consignments.id, payload.consignmentId))
      .for("update");
    if (!locked) throw new NotFoundError(`Consignment ${payload.consignmentId} not found`);
    if (!ACCEPTS_CHECKLIST.has(locked.status)) {
      throw new ValidationError(`Consignment ${locked.id} is ${locked.status} and no longer accepts a checklist`);
    }

    await tx.insert(webhook_events).values({
      consignment_id: locked.id,
      direction: "inbound",
      payload: payload as unknown as Record<string, unknown>,
      status: "received",
    });

    // externalCoreId: first write wins.
    let externalCoreIdSet = false;
    let externalCoreIdIgnored: string | undefined;
    if (payload.externalCoreId) {
      if (locked.external_core_id === null) {
        await tx
          .update(consignments)
          .set({ external_core_id: payload.externalCoreId })
          .where(eq(consignments.id, locked.id));
        externalCoreIdSet = true;
      } else if (locked.external_core_id !== payload.externalCoreId) {
        externalCoreIdIgnored = payload.externalCoreId;
      }
    }

    let itemsCreated = 0;
    for (const doc of payload.requiredDocuments) {
      const documentType = await findOrCreateDocumentType(tx, doc.documentTypeName);
      const inserted = await tx
        .insert(document_checklist_items)
        .values({
          consignment_id: locked.id,
          document_type_id: documentType.id,
          required_by: doc.requiredBy,
          status: "awaiting_upload",
        })
        .onConflictDoNothing()
        .returning({ id: document_checklist_items.id });
      itemsCreated += inserted.length;
    }

    const advancing = locked.status === "po_submitted" || locked.status === "checklist_pending";
    if (advancing) {
      await tx.update(consignments).set({ status: "checklist_received" }).where(eq(consignments.id, locked.id));
    }

    const changed = itemsCreated > 0 || advancing || externalCoreIdSet;
    if (changed) {
      await recordAudit(
        {
          actorUser: actingUser,
          action: "consignment.checklist_received",
          targetType: "consignment",
          targetId: locked.id,
          metadata: {
            items_created: itemsCreated,
            documents_in_payload: payload.requiredDocuments.length,
            status_before: locked.status,
            status_after: advancing ? "checklist_received" : locked.status,
            external_core_id_set: externalCoreIdSet ? payload.externalCoreId : null,
            external_core_id_ignored: externalCoreIdIgnored ?? null,
          },
        },
        tx,
      );
    }

    const [consignment] = await tx.select().from(consignments).where(eq(consignments.id, locked.id));
    return { consignment: consignment!, itemsCreated, duplicate: !changed };
  });
}

/**
 * Records an inbound call that failed after its signature verified, so it can be replayed or
 * debugged. consignment_id is set only when the consignment is known.
 */
export async function logFailedInboundWebhook(
  payload: Record<string, unknown>,
  consignmentId: string | null = null,
): Promise<void> {
  await getDb().insert(webhook_events).values({
    consignment_id: consignmentId,
    direction: "inbound",
    payload,
    status: "failed",
  });
}

/** Case-insensitive lookup by name, creating the document type if it does not exist. */
async function findOrCreateDocumentType(tx: Tx, name: string): Promise<DocumentType> {
  const find = async () =>
    (await tx.select().from(document_types).where(sql`lower(${document_types.name}) = lower(${name})`))[0];

  const existing = await find();
  if (existing) return existing;
  const [created] = await tx.insert(document_types).values({ name }).onConflictDoNothing().returning();
  if (created) return created;
  // Lost a race with a concurrent insert of the same name; the winner's row is now visible.
  return (await find())!;
}
