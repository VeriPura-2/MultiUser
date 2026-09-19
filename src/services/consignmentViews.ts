import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import {
  consignments,
  document_checklist_items,
  document_types,
  issues,
  organizations,
  type ChecklistItemStatus,
  type ChecklistRequiredBy,
  type Consignment,
  type ConsignmentStatus,
  type Issue,
  type OrgType,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../errors.js";
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

// ---------------------------------------------------------------------------
// Endpoint 2: the consignment list
// ---------------------------------------------------------------------------

export interface ConsignmentSummary {
  id: string;
  commodity: string;
  status: ConsignmentStatus;
  /** The other party as seen from the viewer's org. Null for superadmin, who has no side. */
  counterpartOrgName: string | null;
  importerOrgName: string;
  exporterOrgName: string;
  /** verified items over all items the viewer can see (status_only and full; hidden excluded). */
  checklistCompleteness: { verified: number; total: number };
  /** Items with an open or correction_requested issue that the viewer can see at full view. */
  openIssueCount: number;
}

/** The visibility-filtered figures every summary and workload row is built from. */
export interface ItemTotals {
  visibleTotal: number;
  visibleVerified: number;
  awaitingUpload: number;
  openIssueItems: number;
}

/**
 * Counts one consignment's items from the viewer's point of view. Completeness uses every item
 * the viewer can see, exactly the set the checklist endpoint returns. Anything that exposes
 * content (awaiting-upload counts and issue counts) uses only full-view items, so a status_only
 * or hidden document never contributes to a number the viewer could use to infer what is in it.
 */
export function totalsFor(items: readonly ResolvedItem[], openIssues: ReadonlyMap<string, Issue>): ItemTotals {
  const visible = items.filter(isVisible);
  const full = items.filter(isFullView);
  return {
    visibleTotal: visible.length,
    visibleVerified: visible.filter((i) => i.status === "verified").length,
    awaitingUpload: full.filter((i) => i.status === "awaiting_upload").length,
    openIssueItems: full.filter((i) => openIssues.has(i.id)).length,
  };
}

/** Groups resolved items by consignment id. */
export function groupByConsignment(items: readonly ResolvedItem[]): Map<string, ResolvedItem[]> {
  const grouped = new Map<string, ResolvedItem[]>();
  for (const item of items) {
    const list = grouped.get(item.consignmentId) ?? [];
    list.push(item);
    grouped.set(item.consignmentId, list);
  }
  return grouped;
}

/**
 * Consignments the viewer is a party to (all of them for superadmin), newest first, each with a
 * summary computed through the same visibility filtering as the checklist endpoint. Not
 * paginated yet: one organization's consignments are expected to be few during the trial.
 */
export async function listConsignments(actingUser: UserRef): Promise<ConsignmentSummary[]> {
  return getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);

    const rows = await tx
      .select()
      .from(consignments)
      .where(
        isSuperadmin(actor)
          ? undefined
          : or(eq(consignments.importer_org_id, actor.organization_id!), eq(consignments.exporter_org_id, actor.organization_id!)),
      )
      .orderBy(desc(consignments.created_at), asc(consignments.id));
    if (rows.length === 0) return [];

    const orgIds = [...new Set(rows.flatMap((c) => [c.importer_org_id, c.exporter_org_id]))];
    const orgs = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds));
    const nameOf = new Map(orgs.map((o) => [o.id, o.name]));

    const resolve = await createPermissionResolver(actor, tx);
    const items = await loadResolvedItems(tx, rows.map((c) => c.id), resolve);
    const openIssues = await loadUnresolvedIssues(tx, items.filter(isFullView).map((i) => i.id));
    const byConsignment = groupByConsignment(items);

    return rows.map((c) => {
      const totals = totalsFor(byConsignment.get(c.id) ?? [], openIssues);
      const counterpartId = isSuperadmin(actor)
        ? null
        : c.importer_org_id === actor.organization_id
          ? c.exporter_org_id
          : c.importer_org_id;
      return {
        id: c.id,
        commodity: c.commodity,
        status: c.status,
        counterpartOrgName: counterpartId ? (nameOf.get(counterpartId) ?? null) : null,
        importerOrgName: nameOf.get(c.importer_org_id) ?? "",
        exporterOrgName: nameOf.get(c.exporter_org_id) ?? "",
        checklistCompleteness: { verified: totals.visibleVerified, total: totals.visibleTotal },
        openIssueCount: totals.openIssueItems,
      };
    });
  }, READ_ONLY_SNAPSHOT);
}

// ---------------------------------------------------------------------------
// Endpoint 3: workload by counterparty
// ---------------------------------------------------------------------------

export interface PartyWorkloadRow {
  counterpartyOrgId: string;
  counterpartyOrgName: string;
  /** Consignments with this counterparty whose status is not completed or cancelled. */
  activeConsignmentCount: number;
  /** Full-view checklist items still awaiting upload, across the active consignments. */
  documentsAwaitingUploadCount: number;
  /** Full-view items with an open or correction_requested issue, across the active consignments. */
  openIssueCount: number;
}

export interface PartyWorkloadResponse {
  /** The organization whose workload this is. */
  orgId: string;
  counterparties: PartyWorkloadRow[];
}

const FINISHED_STATUSES: readonly ConsignmentStatus[] = ["completed", "cancelled"];

/**
 * Where each relationship stands, grouped by the other party on each consignment: the exporter
 * when the viewer's org is the importer, the importer when it is the exporter. It is a working
 * operator view, so any active user of an org may read their own org's workload.
 *
 * Superadmin has no org and must name one with `orgId`; other users always get their own org and
 * any `orgId` they pass is ignored, so it cannot be used to look at another org.
 *
 * Counts use the same visibility filtering as the consignment views: only items the viewer can
 * see at full view contribute, and issues are counted per item, the same definition as
 * `openIssueCount` on the list endpoint. There is deliberately no "overdue" figure, since no
 * deadline exists on a consignment or checklist item yet.
 *
 * Decision (the prompt left the scope of the two counts open): they cover only active
 * consignments. A cancelled consignment's leftover awaiting uploads are not anyone's workload.
 * A counterparty whose consignments are all finished still gets a row, with zeros.
 */
export async function getPartyWorkload(
  actingUser: UserRef,
  options: { orgId?: string } = {},
): Promise<PartyWorkloadResponse> {
  return getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);

    let orgId: string;
    if (isSuperadmin(actor)) {
      if (!options.orgId || !UUID_PATTERN.test(options.orgId)) {
        throw new ValidationError("Superadmin must pass a valid orgId to choose whose workload to view");
      }
      const [org] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, options.orgId));
      if (!org) throw new NotFoundError("Organization not found");
      orgId = org.id;
    } else {
      orgId = actor.organization_id!;
    }

    const rows = await tx
      .select()
      .from(consignments)
      .where(or(eq(consignments.importer_org_id, orgId), eq(consignments.exporter_org_id, orgId)));

    const counterpartyOf = (c: Consignment) => (c.importer_org_id === orgId ? c.exporter_org_id : c.importer_org_id);
    const active = rows.filter((c) => !FINISHED_STATUSES.includes(c.status));

    const counterpartyIds = [...new Set(rows.map(counterpartyOf))];
    if (counterpartyIds.length === 0) return { orgId, counterparties: [] };
    const orgs = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, counterpartyIds));
    const nameOf = new Map(orgs.map((o) => [o.id, o.name]));

    const resolve = await createPermissionResolver(actor, tx);
    const items = await loadResolvedItems(tx, active.map((c) => c.id), resolve);
    const openIssues = await loadUnresolvedIssues(tx, items.filter(isFullView).map((i) => i.id));
    const byConsignment = groupByConsignment(items);

    const perCounterparty = new Map<string, PartyWorkloadRow>(
      counterpartyIds.map((id) => [
        id,
        {
          counterpartyOrgId: id,
          counterpartyOrgName: nameOf.get(id) ?? "",
          activeConsignmentCount: 0,
          documentsAwaitingUploadCount: 0,
          openIssueCount: 0,
        },
      ]),
    );
    for (const c of active) {
      const row = perCounterparty.get(counterpartyOf(c))!;
      const totals = totalsFor(byConsignment.get(c.id) ?? [], openIssues);
      row.activeConsignmentCount += 1;
      row.documentsAwaitingUploadCount += totals.awaitingUpload;
      row.openIssueCount += totals.openIssueItems;
    }

    const counterparties = [...perCounterparty.values()].sort(
      (a, b) => a.counterpartyOrgName.localeCompare(b.counterpartyOrgName) || a.counterpartyOrgId.localeCompare(b.counterpartyOrgId),
    );
    return { orgId, counterparties };
  }, READ_ONLY_SNAPSHOT);
}

// ---------------------------------------------------------------------------
// UI-1: consignment detail
// ---------------------------------------------------------------------------

export interface ConsignmentDetail {
  id: string;
  status: ConsignmentStatus;
  commodity: string;
  hsCode: string | null;
  originCountry: string;
  destinationCountry: string;
  importerOrg: { id: string; name: string };
  exporterOrg: { id: string; name: string };
  createdAt: Date;
}

/**
 * One consignment's header, for the roadmap screen. Same authorization and the same 404 choice
 * as the checklist: a user who is not a party gets exactly what they would for a consignment
 * that does not exist. Only fields the schema has. There is no quantity, so none is returned.
 */
export async function getConsignmentDetail(consignmentId: string, actingUser: UserRef): Promise<ConsignmentDetail> {
  return getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);
    if (!UUID_PATTERN.test(consignmentId)) throw consignmentNotFound();

    const [c] = await tx.select().from(consignments).where(eq(consignments.id, consignmentId));
    if (!c || !isPartyTo(actor, c)) throw consignmentNotFound();

    const orgs = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, [c.importer_org_id, c.exporter_org_id]));
    const nameOf = new Map(orgs.map((o) => [o.id, o.name]));

    return {
      id: c.id,
      status: c.status,
      commodity: c.commodity,
      hsCode: c.hs_code,
      originCountry: c.origin_country,
      destinationCountry: c.destination_country,
      importerOrg: { id: c.importer_org_id, name: nameOf.get(c.importer_org_id) ?? "" },
      exporterOrg: { id: c.exporter_org_id, name: nameOf.get(c.exporter_org_id) ?? "" },
      createdAt: c.created_at,
    };
  }, READ_ONLY_SNAPSHOT);
}
