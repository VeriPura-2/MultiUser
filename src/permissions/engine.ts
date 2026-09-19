import { and, eq, inArray } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import {
  document_permission_rules,
  org_roles,
  organizations,
  user_role_assignments,
  type DocumentPermissionRule,
  type DocumentType,
  type ViewLevel,
} from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import { isSuperadmin, type UserRef } from "../types.js";

export interface DocumentPermissions {
  viewLevel: ViewLevel;
  canEdit: boolean;
  canDownload: boolean;
  canApprove: boolean;
}

/** VeriPura superadmin: always everything, regardless of any configured rule. */
export const SUPERADMIN_PERMISSIONS: DocumentPermissions = Object.freeze({
  viewLevel: "full",
  canEdit: true,
  canDownload: true,
  canApprove: true,
});

/**
 * No rule configured for the combination: visible by default (opt-out on view restriction),
 * but edit, download, and approve stay opt-in so write or sign-off authority is never granted
 * by omission.
 */
export const DEFAULT_PERMISSIONS: DocumentPermissions = Object.freeze({
  viewLevel: "full",
  canEdit: false,
  canDownload: false,
  canApprove: false,
});

const VIEW_RANK: Record<ViewLevel, number> = { hidden: 0, status_only: 1, full: 2 };

type RuleGrant = Pick<DocumentPermissionRule, "view_level" | "can_edit" | "can_download" | "can_approve">;

/**
 * Combines the rules matched by a user's roles into one result, most permissive wins:
 * view_level takes the highest of full > status_only > hidden, and each boolean is true if any
 * rule grants it. Then the consistency constraint is re-applied to the merged result, so a
 * grant that only ever existed on a rule below full view cannot leak through the merge.
 * With no rules, returns DEFAULT_PERMISSIONS.
 *
 * Booleans are counted only from rules that are themselves full view. The database CHECK
 * already forbids a status_only or hidden rule carrying a grant, so for stored data this is
 * identical to "any rule grants it". It is kept as defense in depth: if that constraint were
 * ever dropped or a row slipped past it, the bad grant still could not surface in a merge
 * where another role resolves the view level to full.
 */
export function mergePermissionRules(rules: readonly RuleGrant[]): DocumentPermissions {
  if (rules.length === 0) return { ...DEFAULT_PERMISSIONS };

  let viewLevel: ViewLevel = "hidden";
  let canEdit = false;
  let canDownload = false;
  let canApprove = false;

  for (const rule of rules) {
    if (VIEW_RANK[rule.view_level] > VIEW_RANK[viewLevel]) viewLevel = rule.view_level;
    if (rule.view_level === "full") {
      canEdit ||= rule.can_edit;
      canDownload ||= rule.can_download;
      canApprove ||= rule.can_approve;
    }
  }

  if (viewLevel !== "full") {
    canEdit = false;
    canDownload = false;
    canApprove = false;
  }
  return { viewLevel, canEdit, canDownload, canApprove };
}

/** Resolves the permissions for any document type, for one user, from data loaded up front. */
export type PermissionResolver = (documentTypeId: string) => DocumentPermissions;

/**
 * Loads what is needed to resolve `user`'s permissions (organization type, role names, and the
 * matching rules) once, and returns a function that resolves any document type from memory.
 * Use it wherever many document types are resolved for one user, so the cost is a fixed three
 * queries instead of three per document. resolveDocumentPermissions is built on this, so the
 * two cannot drift apart.
 *
 * Superadmin resolves to full/all-true without touching the database. Only roles belonging to
 * the user's own organization count, even if a stray assignment pointed elsewhere. A user with
 * no roles matches no rules and so gets the opt-in defaults. Pass `documentTypeIds` to load
 * rules for just those types when only a few are needed.
 */
export async function createPermissionResolver(
  user: UserRef,
  db: DbExecutor = getDb(),
  documentTypeIds?: readonly string[],
): Promise<PermissionResolver> {
  if (isSuperadmin(user)) return () => ({ ...SUPERADMIN_PERMISSIONS });

  const orgId = user.organization_id;
  if (typeof orgId !== "string") {
    // Neither null (superadmin) nor a uuid: malformed caller input. Fail closed.
    throw new TypeError("resolveDocumentPermissions: user.organization_id must be a string or null");
  }

  const [org] = await db
    .select({ org_type: organizations.org_type })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError(`Organization ${orgId} not found`);

  const roleRows = await db
    .select({ name: org_roles.name })
    .from(user_role_assignments)
    .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id))
    .where(and(eq(user_role_assignments.user_id, user.id), eq(org_roles.organization_id, orgId)));
  const roleNames = [...new Set(roleRows.map((r) => r.name))];
  if (roleNames.length === 0) return () => ({ ...DEFAULT_PERMISSIONS });

  const rulesByType = new Map<string, DocumentPermissionRule[]>();
  if (!documentTypeIds || documentTypeIds.length > 0) {
    const conditions = [
      eq(document_permission_rules.org_type, org.org_type),
      inArray(document_permission_rules.org_role_name, roleNames),
    ];
    if (documentTypeIds) conditions.push(inArray(document_permission_rules.document_type_id, [...documentTypeIds]));
    for (const rule of await db.select().from(document_permission_rules).where(and(...conditions))) {
      const list = rulesByType.get(rule.document_type_id) ?? [];
      list.push(rule);
      rulesByType.set(rule.document_type_id, list);
    }
  }

  return (documentTypeId) => mergePermissionRules(rulesByType.get(documentTypeId) ?? []);
}

/**
 * Resolves what `user` may do with documents of `documentType`.
 *
 * Superadmin returns full/all-true immediately. Otherwise the user's organization type and
 * assigned role names are looked up and matched against document_permission_rules, and the
 * matches are merged (most permissive wins, then the full-view constraint is re-applied).
 *
 * Async because it reads the database. `db` may be a transaction handle.
 */
export async function resolveDocumentPermissions(
  user: UserRef,
  documentType: Pick<DocumentType, "id">,
  db: DbExecutor = getDb(),
): Promise<DocumentPermissions> {
  const resolve = await createPermissionResolver(user, db, [documentType.id]);
  return resolve(documentType.id);
}

/**
 * True for superadmin, or for a user holding at least one role with is_org_admin = true in
 * their own organization. Async because it reads the database.
 */
export async function canManageOrgUsers(user: UserRef, db: DbExecutor = getDb()): Promise<boolean> {
  if (isSuperadmin(user)) return true;

  const orgId = user.organization_id;
  if (typeof orgId !== "string") return false;

  const adminRoles = await db
    .select({ id: org_roles.id })
    .from(user_role_assignments)
    .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id))
    .where(
      and(
        eq(user_role_assignments.user_id, user.id),
        eq(org_roles.organization_id, orgId),
        eq(org_roles.is_org_admin, true),
      ),
    )
    .limit(1);
  return adminRoles.length > 0;
}

/** Cross-org visibility and permission rules are configured by VeriPura superadmin only. */
export function canConfigureVisibilityRules(user: UserRef): boolean {
  return isSuperadmin(user);
}
