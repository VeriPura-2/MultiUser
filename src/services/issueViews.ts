import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import {
  audit_log,
  consignments,
  document_checklist_items,
  document_types,
  issues,
  organizations,
  users,
  type ChecklistRequiredBy,
  type Consignment,
  type Issue,
  type IssueStatus,
  type OrgType,
} from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import { createPermissionResolver } from "../permissions/engine.js";
import type { UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";
import { READ_ONLY_SNAPSHOT, UUID_PATTERN, isPartyTo } from "./consignmentViews.js";

/**
 * Read model and access gate for a single issue, for the issue screen and its actions.
 *
 * The gate is one rule used by every issue endpoint: you can see or act on an issue only if you
 * are a party to its consignment AND your role sees the parent document at full view. Anything
 * else is a 404 identical to an issue that does not exist, so a status_only or hidden viewer
 * cannot use the API to find out that an issue is there or to act on it.
 *
 * Note this gate lives at the HTTP boundary. The service functions raiseIssue, requestCorrection,
 * and resolveIssue still check only that the actor's org is a party (a known open item), so any
 * new caller of them must apply this gate too.
 */

export interface IssueActivity {
  action: string;
  /** Display name of who did it, or "System" for an action with no user. */
  actor: string;
  createdAt: Date;
  /** The correction request's message, when the action carried one. */
  message?: string;
}

export interface IssueDetail {
  id: string;
  consignmentId: string;
  status: IssueStatus;
  problem: string;
  expectedValue: string | null;
  foundValue: string | null;
  responsibleOrgType: OrgType;
  /** The party org of that type on this consignment. Null when the responsible type is neither the importer nor the exporter. */
  responsibleOrgName: string | null;
  checklistItem: {
    id: string;
    documentTypeName: string;
    category: string | null;
    requiredBy: ChecklistRequiredBy;
  };
  /** Null when there is no source document, or when it is hidden from the viewer. */
  sourceDocumentTypeName: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** What this viewer may do next, so the UI shows only buttons that will work. */
  availableActions: { requestCorrection: boolean; resolve: boolean };
  activity: IssueActivity[];
}

const issueNotFound = () => new NotFoundError("Issue not found");

/** Loads an issue and proves the viewer may see it. Throws the uniform 404 otherwise. */
async function loadViewableIssue(tx: DbExecutor, actor: UserRef, issueId: string) {
  if (!UUID_PATTERN.test(issueId)) throw issueNotFound();
  const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) throw issueNotFound();

  const [consignment] = await tx.select().from(consignments).where(eq(consignments.id, issue.consignment_id));
  if (!consignment || !isPartyTo(actor, consignment)) throw issueNotFound();

  const [item] = await tx
    .select({
      id: document_checklist_items.id,
      documentTypeId: document_checklist_items.document_type_id,
      requiredBy: document_checklist_items.required_by,
      documentTypeName: document_types.name,
      category: document_types.category,
    })
    .from(document_checklist_items)
    .innerJoin(document_types, eq(document_types.id, document_checklist_items.document_type_id))
    .where(eq(document_checklist_items.id, issue.document_checklist_item_id));
  if (!item) throw issueNotFound();

  const resolve = await createPermissionResolver(actor, tx);
  if (resolve(item.documentTypeId).viewLevel !== "full") throw issueNotFound();

  return { issue, consignment, item, resolve };
}

/** Throws the uniform 404 unless the acting user may see and act on this issue. */
export async function assertCanActOnIssue(issueId: string, actingUser: UserRef): Promise<void> {
  await getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);
    await loadViewableIssue(tx, actor, issueId);
  }, READ_ONLY_SNAPSHOT);
}

/**
 * Throws the uniform 404 unless the item is on that consignment, the viewer is a party to it,
 * and the viewer's role sees the item at full view. Used before raising an issue.
 */
export async function assertCanRaiseIssueOn(consignmentId: string, itemId: string, actingUser: UserRef): Promise<void> {
  await getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);
    if (!UUID_PATTERN.test(consignmentId) || !UUID_PATTERN.test(itemId)) throw new NotFoundError("Checklist item not found");

    const [consignment] = await tx.select().from(consignments).where(eq(consignments.id, consignmentId));
    const [item] = await tx.select().from(document_checklist_items).where(eq(document_checklist_items.id, itemId));
    if (!consignment || !item || item.consignment_id !== consignment.id || !isPartyTo(actor, consignment)) {
      throw new NotFoundError("Checklist item not found");
    }
    const resolve = await createPermissionResolver(actor, tx);
    if (resolve(item.document_type_id).viewLevel !== "full") throw new NotFoundError("Checklist item not found");
  }, READ_ONLY_SNAPSHOT);
}

/** The full issue screen data, or the uniform 404. */
export async function getIssueDetail(issueId: string, actingUser: UserRef): Promise<IssueDetail> {
  return getDb().transaction(async (tx) => {
    const actor = await loadActiveActor(actingUser, tx);
    const { issue, consignment, item, resolve } = await loadViewableIssue(tx, actor, issueId);

    const responsibleOrgName = await responsibleOrgNameFor(tx, consignment, issue.responsible_org_type);
    const sourceDocumentTypeName = await sourceNameFor(tx, issue, resolve);
    const activity = await activityFor(tx, issue.id, actor);
    const unresolved = issue.status !== "resolved";

    return {
      id: issue.id,
      consignmentId: issue.consignment_id,
      status: issue.status,
      problem: issue.problem,
      expectedValue: issue.expected_value,
      foundValue: issue.found_value,
      responsibleOrgType: issue.responsible_org_type,
      responsibleOrgName,
      checklistItem: {
        id: item.id,
        documentTypeName: item.documentTypeName,
        category: item.category,
        requiredBy: item.requiredBy,
      },
      sourceDocumentTypeName,
      createdAt: issue.created_at,
      resolvedAt: issue.resolved_at,
      availableActions: { requestCorrection: unresolved, resolve: unresolved },
      activity,
    };
  }, READ_ONLY_SNAPSHOT);
}

async function responsibleOrgNameFor(
  tx: DbExecutor,
  consignment: Consignment,
  responsibleType: OrgType,
): Promise<string | null> {
  const orgs = await tx
    .select({ name: organizations.name, orgType: organizations.org_type })
    .from(organizations)
    .where(inArray(organizations.id, [consignment.importer_org_id, consignment.exporter_org_id]));
  return orgs.find((o) => o.orgType === responsibleType)?.name ?? null;
}

async function sourceNameFor(
  tx: DbExecutor,
  issue: Issue,
  resolve: (documentTypeId: string) => { viewLevel: string },
): Promise<string | null> {
  if (!issue.source_document_checklist_item_id) return null;
  const [source] = await tx
    .select({ documentTypeId: document_checklist_items.document_type_id, name: document_types.name })
    .from(document_checklist_items)
    .innerJoin(document_types, eq(document_types.id, document_checklist_items.document_type_id))
    .where(eq(document_checklist_items.id, issue.source_document_checklist_item_id));
  // A source the viewer may not see is not named: naming it would reveal that it exists.
  if (!source || resolve(source.documentTypeId).viewLevel === "hidden") return null;
  return source.name;
}

async function activityFor(tx: DbExecutor, issueId: string, viewer: UserRef): Promise<IssueActivity[]> {
  const rows = await tx
    .select()
    .from(audit_log)
    .where(and(eq(audit_log.target_type, "issue"), eq(audit_log.target_id, issueId)))
    .orderBy(asc(audit_log.created_at), asc(audit_log.id));

  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter((id): id is string => id !== null))];
  const people = actorIds.length
    ? await tx
        .select({ id: users.id, name: users.name, email: users.email, organizationId: users.organization_id })
        .from(users)
        .where(inArray(users.id, actorIds))
    : [];
  const orgIds = [...new Set(people.map((p) => p.organizationId).filter((id): id is string => id !== null))];
  const orgs = orgIds.length
    ? await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds))
    : [];
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const personById = new Map(people.map((p) => [p.id, p]));

  // Show a name. If a user has none, show their email only to colleagues in the same org, and
  // otherwise just who they work for, so one party never receives the other's contact details.
  const displayName = (actorId: string | null): string => {
    if (!actorId) return "System";
    const p = personById.get(actorId);
    if (!p) return "Unknown user";
    if (p.name) return p.name;
    if (p.organizationId === null) return "VeriPura";
    return p.organizationId === viewer.organization_id ? p.email : `A user at ${orgName.get(p.organizationId) ?? "another organization"}`;
  };

  return rows.map((r) => {
    const message = (r.metadata as { message?: unknown } | null)?.message;
    const entry: IssueActivity = { action: r.action, actor: displayName(r.actor_user_id), createdAt: r.created_at };
    if (typeof message === "string" && message) entry.message = message;
    return entry;
  });
}
