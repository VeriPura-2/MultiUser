import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  ORG_STATUSES,
  document_permission_rules,
  document_types,
  organizations,
  users,
  type OrgStatus,
  type OrgType,
  type ViewLevel,
} from "../db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { STANDARD_ROLES } from "../roles.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";
import { UUID_PATTERN } from "./consignmentViews.js";

/** The organization directory the PO form needs, and the superadmin approval screen's data. */

// ---------------------------------------------------------------------------
// Directory: exporters, for choosing a counterparty on a purchase order
// ---------------------------------------------------------------------------

export interface DirectoryOrg {
  id: string;
  name: string;
}

/**
 * Active exporter-type organizations, by name. Available to any active user of an importer
 * organization (the PO form needs it to choose a counterparty) and to superadmin. Everyone else
 * is refused: an exporter has no reason to list the other exporters.
 */
export async function listExporters(actingUser: UserRef): Promise<DirectoryOrg[]> {
  const db = getDb();
  const actor = await loadActiveActor(actingUser);

  if (!isSuperadmin(actor)) {
    const [own] = await db
      .select({ orgType: organizations.org_type })
      .from(organizations)
      .where(eq(organizations.id, actor.organization_id!));
    if (own?.orgType !== "importer") throw new PermissionDeniedError("Only importer organizations can list exporters");
  }

  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.org_type, "exporter"), eq(organizations.status, "active")))
    .orderBy(asc(organizations.name), asc(organizations.id));
}

// ---------------------------------------------------------------------------
// Superadmin: organizations awaiting a decision
// ---------------------------------------------------------------------------

export interface ApplicantContact {
  name: string | null;
  email: string;
}

export interface AdminOrganizationSummary {
  id: string;
  name: string;
  orgType: OrgType;
  status: OrgStatus;
  createdAt: Date;
  /** The first user of the organization, who applied for it. Null if it somehow has none. */
  applicant: ApplicantContact | null;
}

export interface RolePermission {
  documentTypeId: string;
  documentTypeName: string;
  /** Null when no rule is configured. It is never filled in with a guess. */
  viewLevel: ViewLevel | null;
  canEdit: boolean;
  canDownload: boolean;
  canApprove: boolean;
  /** False when there is no rule for this role and document type, so the UI shows "not configured". */
  configured: boolean;
}

export interface AdminOrganizationDetail extends AdminOrganizationSummary {
  /** The five standard roles a newly approved organization receives, with their default permissions. */
  roles: Array<{ name: string; isOrgAdmin: boolean; permissions: RolePermission[] }>;
}

function requireSuperadmin(actor: UserRef): void {
  if (!isSuperadmin(actor)) throw new PermissionDeniedError("Only VeriPura superadmin can do this");
}

/** The first (earliest created) user of each organization, keyed by organization id. */
async function firstUsers(): Promise<Map<string, ApplicantContact>> {
  const rows = await getDb()
    .select({ orgId: users.organization_id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.created_at), asc(users.id));
  const first = new Map<string, ApplicantContact>();
  for (const r of rows) if (r.orgId && !first.has(r.orgId)) first.set(r.orgId, { name: r.name, email: r.email });
  return first;
}

/**
 * Organizations, oldest first (so the approval queue is first-come first-served), optionally
 * filtered by status. Superadmin only. An unknown status is a 400, not an empty list.
 */
export async function listOrganizationsForAdmin(
  actingUser: UserRef,
  options: { status?: string } = {},
): Promise<AdminOrganizationSummary[]> {
  requireSuperadmin(await loadActiveActor(actingUser));
  if (options.status !== undefined && !ORG_STATUSES.includes(options.status as OrgStatus)) {
    throw new ValidationError(`status must be one of ${ORG_STATUSES.join(", ")}`);
  }

  const db = getDb();
  const orgs = await db
    .select()
    .from(organizations)
    .where(options.status ? eq(organizations.status, options.status as OrgStatus) : undefined)
    .orderBy(asc(organizations.created_at), asc(organizations.id));
  const applicants = await firstUsers();

  return orgs.map((o) => ({
    id: o.id,
    name: o.name,
    orgType: o.org_type,
    status: o.status,
    createdAt: o.created_at,
    applicant: applicants.get(o.id) ?? null,
  }));
}

/**
 * One organization for the approval screen. The roles are the five standard ones (a pending
 * organization has no role rows yet; they are created on approval). Each role's permissions come
 * from the configured document_permission_rules for this organization's type, and a document
 * with no rule is reported as not configured. Nothing is invented or defaulted.
 */
export async function getOrganizationForAdmin(actingUser: UserRef, orgId: string): Promise<AdminOrganizationDetail> {
  requireSuperadmin(await loadActiveActor(actingUser));
  if (!UUID_PATTERN.test(orgId)) throw new NotFoundError("Organization not found");

  const db = getDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError("Organization not found");

  const [docTypes, rules, applicants] = await Promise.all([
    db.select().from(document_types).orderBy(asc(document_types.name), asc(document_types.id)),
    db.select().from(document_permission_rules).where(eq(document_permission_rules.org_type, org.org_type)),
    firstUsers(),
  ]);
  const ruleFor = new Map(rules.map((r) => [`${r.org_role_name}|${r.document_type_id}`, r]));

  return {
    id: org.id,
    name: org.name,
    orgType: org.org_type,
    status: org.status,
    createdAt: org.created_at,
    applicant: applicants.get(org.id) ?? null,
    roles: STANDARD_ROLES.map((role) => ({
      name: role.name,
      isOrgAdmin: role.is_org_admin,
      permissions: docTypes.map((doc): RolePermission => {
        const rule = ruleFor.get(`${role.name}|${doc.id}`);
        return rule
          ? {
              documentTypeId: doc.id,
              documentTypeName: doc.name,
              viewLevel: rule.view_level,
              canEdit: rule.can_edit,
              canDownload: rule.can_download,
              canApprove: rule.can_approve,
              configured: true,
            }
          : {
              documentTypeId: doc.id,
              documentTypeName: doc.name,
              viewLevel: null,
              canEdit: false,
              canDownload: false,
              canApprove: false,
              configured: false,
            };
      }),
    })),
  };
}
