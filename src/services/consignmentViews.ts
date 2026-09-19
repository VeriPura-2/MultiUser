import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import {
  consignments,
  document_checklist_items,
  document_types,
  issues,
  type ChecklistItemStatus,
  type ChecklistRequiredBy,
  type Consignment,
  type ConsignmentStatus,
  type Issue,
  type OrgType,
} from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import { createPermissionResolver, type DocumentPermissions, type PermissionResolver } from "../permissions/engine.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";

/**
 * Read models for the role-scoped views of a consignment's document checklist.
 *
 * Every field and every number returned here passes through the permission engine, so a user
 * never sees a document, an issue, or a count that references something they may not see.
 * Reads run in one repeatable-read, read-only transaction so a view never mixes two moments.
 */

// ---------------------------------------------------------------------------
// Shapes returned to callers
// ---------------------------------------------------------------------------

export interface OpenIssueView {
  problem: string;
  expectedValue: string | null;
  foundValue: string | null;
  responsibleOrgType: OrgType;
  status: "open" | "correction_requested";
  /** Omitted when the issue has no source document, or when that document is hidden from you. */
  sourceDocumentTypeName?: string;
}

/** What a status_only viewer gets: that the document exists and where it stands, nothing more. */
export interface StatusOnlyChecklistItem {
  checklistItemId: string;
  documentTypeName: string;
  status: ChecklistItemStatus;
  canEdit: false;
  canDownload: false;
  canApprove: false;
}

export interface FullChecklistItem {
  checklistItemId: string;
  documentTypeName: string;
  requiredBy: ChecklistRequiredBy;
  status: ChecklistItemStatus;
  category: string | null;
  canEdit: boolean;
  canDownload: boolean;
  canApprove: boolean;
  openIssue: OpenIssueView | null;
}

export type ChecklistItemView = StatusOnlyChecklistItem | FullChecklistItem;

export interface ChecklistResponse {
  consignmentId: string;
  consignmentStatus: ConsignmentStatus;
  checklist: ChecklistItemView[];
}

// ---------------------------------------------------------------------------
// Shared building blocks (also used by the list and workload views)
// ---------------------------------------------------------------------------

export const READ_ONLY_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One error for "does not exist" and "not yours", so the two cannot be told apart. */
export function consignmentNotFound(): NotFoundError {
  return new NotFoundError("Consignment not found");
}

export function isPartyTo(
  actor: UserRef,
  consignment: Pick<Consignment, "importer_org_id" | "exporter_org_id">,
): boolean {
  return (
    isSuperadmin(actor) ||
    (actor.organization_id !== null &&
      (consignment.importer_org_id === actor.organization_id || consignment.exporter_org_id === actor.organization_id))
  );
}

/** A checklist item joined to its document type, with the viewer's permissions resolved. */
export interface ResolvedItem {
  id: string;
  consignmentId: string;
  documentTypeId: string;
  documentTypeName: string;
  category: string | null;
  requiredBy: ChecklistRequiredBy;
  status: ChecklistItemStatus;
  perms: DocumentPermissions;
}

/** Loads every checklist item on the given consignments and resolves the viewer's permissions on each. */
export async function loadResolvedItems(
  db: DbExecutor,
  consignmentIds: readonly string[],
  resolve: PermissionResolver,
): Promise<ResolvedItem[]> {
  if (consignmentIds.length === 0) return [];
  const rows = await db
    .select({
      id: document_checklist_items.id,
      consignmentId: document_checklist_items.consignment_id,
      documentTypeId: document_checklist_items.document_type_id,
      documentTypeName: document_types.name,
      category: document_types.category,
      requiredBy: document_checklist_items.required_by,
      status: document_checklist_items.status,
    })
    .from(document_checklist_items)
    .innerJoin(document_types, eq(document_types.id, document_checklist_items.document_type_id))
    .where(inArray(document_checklist_items.consignment_id, [...consignmentIds]))
    .orderBy(
      asc(document_checklist_items.created_at),
      asc(document_types.name),
      asc(document_checklist_items.required_by),
    );
  return rows.map((r) => ({ ...r, perms: resolve(r.documentTypeId) }));
}

/**
 * The oldest unresolved (open or correction_requested) issue on each item that has one.
 * An item can carry several; the checklist shows one, the longest-standing.
 */
export async function loadUnresolvedIssues(
  db: DbExecutor,
  itemIds: readonly string[],
): Promise<Map<string, Issue>> {
  const byItem = new Map<string, Issue>();
  if (itemIds.length === 0) return byItem;
  const rows = await db
    .select()
    .from(issues)
    .where(and(inArray(issues.document_checklist_item_id, [...itemIds]), ne(issues.status, "resolved")))
    .orderBy(asc(issues.created_at), asc(issues.id));
  for (const row of rows) {
    if (!byItem.has(row.document_checklist_item_id)) byItem.set(row.document_checklist_item_id, row);
  }
  return byItem;
}

/** Items the viewer can see at all (status_only or full). Hidden items are gone, not blanked. */
export const isVisible = (i: ResolvedItem): boolean => i.perms.viewLevel !== "hidden";

/** Items whose contents the viewer may read. Issue detail and issue counts use only these. */
export const isFullView = (i: ResolvedItem): boolean => i.perms.viewLevel === "full";

// ---------------------------------------------------------------------------
// Endpoint 1: the checklist for one consignment
// ---------------------------------------------------------------------------

/**
 * The checklist for one consignment, filtered through the permission engine.
 *
 * Access: superadmin, or an active user of the consignment's importer or exporter org.
 * Anyone else gets NotFoundError, identical to a consignment that does not exist. Choice
 * documented as the prompt asked: this model has no "related but wrong org" relationship beyond
 * being a party, so a 403 would only ever confirm to a stranger that the id is real. An inactive
 * user is refused (403) before any consignment is looked up.
 *
 * Per item, by the viewer's view level:
 * - hidden: omitted entirely.
 * - status_only: id, document type name, status, and all three action flags false. No
 *   requiredBy, category, or issue detail, even when an issue exists.
 * - full: everything, with openIssue set to the longest-standing unresolved issue (or null).
 */
export async function getConsignmentChecklist(
  consignmentId: string,
  actingUser: UserRef,
): Promise<ChecklistResponse> {
  return getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);
    if (!UUID_PATTERN.test(consignmentId)) throw consignmentNotFound();

    const [consignment] = await tx.select().from(consignments).where(eq(consignments.id, consignmentId));
    if (!consignment || !isPartyTo(actor, consignment)) throw consignmentNotFound();

    const resolve = await createPermissionResolver(actor, tx);
    const items = await loadResolvedItems(tx, [consignment.id], resolve);
    const openIssues = await loadUnresolvedIssues(tx, items.filter(isFullView).map((i) => i.id));
    const byId = new Map(items.map((i) => [i.id, i]));

    const checklist: ChecklistItemView[] = [];
    for (const item of items) {
      if (!isVisible(item)) continue;

      if (!isFullView(item)) {
        checklist.push({
          checklistItemId: item.id,
          documentTypeName: item.documentTypeName,
          status: item.status,
          canEdit: false,
          canDownload: false,
          canApprove: false,
        });
        continue;
      }

      const issue = openIssues.get(item.id);
      let openIssue: OpenIssueView | null = null;
      if (issue) {
        openIssue = {
          problem: issue.problem,
          expectedValue: issue.expected_value,
          foundValue: issue.found_value,
          responsibleOrgType: issue.responsible_org_type,
          status: issue.status as OpenIssueView["status"],
        };
        // Name the source document only if the viewer may see that it exists.
        const source = issue.source_document_checklist_item_id
          ? byId.get(issue.source_document_checklist_item_id)
          : undefined;
        if (source && isVisible(source)) openIssue.sourceDocumentTypeName = source.documentTypeName;
      }

      checklist.push({
        checklistItemId: item.id,
        documentTypeName: item.documentTypeName,
        requiredBy: item.requiredBy,
        status: item.status,
        category: item.category,
        canEdit: item.perms.canEdit,
        canDownload: item.perms.canDownload,
        canApprove: item.perms.canApprove,
        openIssue,
      });
    }

    return { consignmentId: consignment.id, consignmentStatus: consignment.status, checklist };
  }, READ_ONLY_SNAPSHOT);
}
