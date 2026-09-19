import { and, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb, type Tx } from "../db/client.js";
import {
  consignments,
  document_checklist_items,
  issues,
  type DocumentChecklistItem,
  type Issue,
  type OrgType,
} from "../db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";

/**
 * Who may work issues: superadmin, or any active user of an org that is a party (importer or
 * exporter) to the consignment. There is no automated validator or dedicated reviewer role
 * yet, so this is deliberately permissive. Tighten it (likely to Compliance Manager, or to a
 * system actor once core's validation is wired in) when document upload and validation land.
 */
async function authorizeForConsignment(tx: Tx, actingUser: UserRef, consignmentId: string) {
  const actor = await loadActiveActor(actingUser, tx);
  if (isSuperadmin(actor)) return actor;

  const [consignment] = await tx.select().from(consignments).where(eq(consignments.id, consignmentId));
  const isParty =
    consignment &&
    (consignment.importer_org_id === actor.organization_id || consignment.exporter_org_id === actor.organization_id);
  if (!isParty) throw new PermissionDeniedError("Your organization is not a party to this consignment");
  return actor;
}

/**
 * Loads an issue and locks its checklist item, then the issue, in that order everywhere so
 * concurrent operations on one item cannot deadlock or race on the item's status.
 */
async function lockIssueAndItem(tx: Tx, issueId: string): Promise<{ issue: Issue; item: DocumentChecklistItem }> {
  const [peek] = await tx.select().from(issues).where(eq(issues.id, issueId));
  if (!peek) throw new NotFoundError(`Issue ${issueId} not found`);

  const [item] = await tx
    .select()
    .from(document_checklist_items)
    .where(eq(document_checklist_items.id, peek.document_checklist_item_id))
    .for("update");
  const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
  return { issue: issue!, item: item! };
}

async function unresolvedIssueCount(tx: Tx, itemId: string, excludingIssueId?: string): Promise<number> {
  const conditions = [eq(issues.document_checklist_item_id, itemId), ne(issues.status, "resolved")];
  if (excludingIssueId) conditions.push(ne(issues.id, excludingIssueId));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(...conditions));
  return row?.n ?? 0;
}

export interface RaiseIssueInput {
  documentChecklistItemId: string;
  problem: string;
  expectedValue?: string | null;
  foundValue?: string | null;
  /** The other document the discrepancy was found against, if any. */
  sourceChecklistItemId?: string | null;
  responsibleOrgType: OrgType;
  actingUser: UserRef;
}

/** Raises an issue (status open) on a checklist item and flags the item. Audit: "issue.raised". */
export async function raiseIssue(input: RaiseIssueInput): Promise<Issue> {
  const problem = input.problem?.trim();
  if (!problem) throw new ValidationError("problem is required");

  return getDb().transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(document_checklist_items)
      .where(eq(document_checklist_items.id, input.documentChecklistItemId))
      .for("update");
    if (!item) throw new NotFoundError(`Checklist item ${input.documentChecklistItemId} not found`);

    const actor = await authorizeForConsignment(tx, input.actingUser, item.consignment_id);

    const sourceId = input.sourceChecklistItemId ?? null;
    if (sourceId) {
      if (sourceId === item.id) throw new ValidationError("An issue's source document must differ from its own document");
      const [source] = await tx.select().from(document_checklist_items).where(eq(document_checklist_items.id, sourceId));
      if (!source || source.consignment_id !== item.consignment_id) {
        throw new ValidationError("sourceChecklistItemId must be an item on the same consignment");
      }
    }

    const [issue] = await tx
      .insert(issues)
      .values({
        document_checklist_item_id: item.id,
        consignment_id: item.consignment_id,
        problem,
        expected_value: input.expectedValue?.trim() || null,
        found_value: input.foundValue?.trim() || null,
        source_document_checklist_item_id: sourceId,
        responsible_org_type: input.responsibleOrgType,
        status: "open",
        created_by_user_id: actor.id,
      })
      .returning();
    await tx
      .update(document_checklist_items)
      .set({ status: "flagged" })
      .where(eq(document_checklist_items.id, item.id));

    await recordAudit(
      {
        actorUser: actor,
        action: "issue.raised",
        targetType: "issue",
        targetId: issue!.id,
        metadata: {
          consignment_id: item.consignment_id,
          document_checklist_item_id: item.id,
          source_document_checklist_item_id: sourceId,
          responsible_org_type: input.responsibleOrgType,
          item_status_before: item.status,
          problem,
        },
      },
      tx,
    );
    return issue!;
  });
}

export interface RequestCorrectionInput {
  issueId: string;
  message: string;
  actingUser: UserRef;
}

/**
 * Sets an unresolved issue to correction_requested, with the message kept in the audit
 * metadata. Asking again on an issue already in that state is allowed (a reminder).
 * Audit: "issue.correction_requested".
 */
export async function requestCorrection(input: RequestCorrectionInput): Promise<Issue> {
  const message = input.message?.trim();
  if (!message) throw new ValidationError("message is required");

  return getDb().transaction(async (tx) => {
    const { issue } = await lockIssueAndItem(tx, input.issueId);
    const actor = await authorizeForConsignment(tx, input.actingUser, issue.consignment_id);
    if (issue.status === "resolved") throw new ValidationError(`Issue ${issue.id} is already resolved`);

    const [updated] = await tx
      .update(issues)
      .set({ status: "correction_requested" })
      .where(eq(issues.id, issue.id))
      .returning();

    await recordAudit(
      {
        actorUser: actor,
        action: "issue.correction_requested",
        targetType: "issue",
        targetId: issue.id,
        metadata: {
          message,
          previous_status: issue.status,
          consignment_id: issue.consignment_id,
          responsible_org_type: issue.responsible_org_type,
        },
      },
      tx,
    );
    return updated!;
  });
}

export interface ResolveIssueInput {
  issueId: string;
  actingUser: UserRef;
}

/**
 * Resolves an issue and stamps resolved_at. The checklist item goes back to `pending`, meaning
 * it needs re-verification and is not marked verified automatically. If the item still has
 * other unresolved issues it stays `flagged`, so the status keeps mirroring the issues table.
 * Audit: "issue.resolved".
 */
export async function resolveIssue(input: ResolveIssueInput): Promise<Issue> {
  return getDb().transaction(async (tx) => {
    const { issue, item } = await lockIssueAndItem(tx, input.issueId);
    const actor = await authorizeForConsignment(tx, input.actingUser, issue.consignment_id);
    if (issue.status === "resolved") throw new ValidationError(`Issue ${issue.id} is already resolved`);

    const [updated] = await tx
      .update(issues)
      .set({ status: "resolved", resolved_at: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();

    const remaining = await unresolvedIssueCount(tx, item.id, issue.id);
    const itemStatusAfter = remaining > 0 ? "flagged" : "pending";
    await tx
      .update(document_checklist_items)
      .set({ status: itemStatusAfter })
      .where(eq(document_checklist_items.id, item.id));

    await recordAudit(
      {
        actorUser: actor,
        action: "issue.resolved",
        targetType: "issue",
        targetId: issue.id,
        metadata: {
          consignment_id: issue.consignment_id,
          document_checklist_item_id: item.id,
          previous_status: issue.status,
          item_status_after: itemStatusAfter,
          remaining_unresolved_issues: remaining,
        },
      },
      tx,
    );
    return updated!;
  });
}
