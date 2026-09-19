/**
 * Response shapes of the backend, copied from its read models (src/services/*.ts). Dates arrive
 * as ISO strings. The web app is a separate package, so these are kept by hand; when a backend
 * shape changes, change it here too.
 */

export type OrgType = "importer" | "exporter" | "logistics" | "lab_cert" | "data_source";
export type OrgStatus = "pending_approval" | "active" | "suspended" | "rejected";
export type ViewLevel = "full" | "status_only" | "hidden";
export type ConsignmentStatus =
  | "po_submitted"
  | "checklist_pending"
  | "checklist_received"
  | "active"
  | "completed"
  | "cancelled";
export type ChecklistItemStatus = "awaiting_upload" | "pending" | "verified" | "flagged";
export type ChecklistRequiredBy = "importer" | "exporter" | "logistics";
export type IssueStatus = "open" | "correction_requested" | "resolved";
export type UserStatus = "invited" | "active" | "deactivated";

export interface OrganizationSummary {
  id: string;
  name: string;
  orgType: OrgType;
}

export interface Me {
  userId: string;
  name: string | null;
  email: string;
  organization: OrganizationSummary | null;
  roleNames: string[];
  isSuperadmin: boolean;
}

export interface DevUser extends Me {
  status: UserStatus;
}

export interface ConsignmentSummary {
  id: string;
  commodity: string;
  status: ConsignmentStatus;
  counterpartOrgName: string | null;
  importerOrgName: string;
  exporterOrgName: string;
  originCountry: string;
  destinationCountry: string;
  checklistCompleteness: { verified: number; total: number };
  openIssueCount: number;
}

export interface ConsignmentDetail {
  id: string;
  status: ConsignmentStatus;
  commodity: string;
  hsCode: string | null;
  originCountry: string;
  destinationCountry: string;
  importerOrg: { id: string; name: string };
  exporterOrg: { id: string; name: string };
  createdAt: string;
}

export interface PartyWorkloadResponse {
  orgId: string;
  counterparties: PartyWorkloadRow[];
}

export interface ActionQueueResponse {
  orgId: string;
  items: ActionQueueItem[];
}

export interface PartyWorkloadRow {
  counterpartyOrgId: string;
  counterpartyOrgName: string;
  activeConsignmentCount: number;
  documentsAwaitingUploadCount: number;
  openIssueCount: number;
}

export interface ActionQueueItem {
  consignmentId: string;
  consignmentLabel: string;
  documentTypeName: string;
  requiredBy: ChecklistRequiredBy | null;
  status: "flagged" | "awaiting_upload";
  issueId: string | null;
  responsibleOrgType: OrgType | null;
  actionableByMyOrg: boolean;
}

export interface OpenIssueView {
  issueId: string;
  problem: string;
  expectedValue: string | null;
  foundValue: string | null;
  responsibleOrgType: OrgType;
  status: "open" | "correction_requested";
  sourceDocumentTypeName?: string;
}

/** What a status_only viewer gets: that the document exists and its status, nothing more. */
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

export type ChecklistItem = StatusOnlyChecklistItem | FullChecklistItem;

/**
 * A full item always has requiredBy (a status_only item never does), so its presence is what
 * tells them apart. Rendering is decided by this, never by guessing from other fields.
 */
export function isFullItem(item: ChecklistItem): item is FullChecklistItem {
  return "requiredBy" in item;
}

export interface Checklist {
  consignmentId: string;
  consignmentStatus: ConsignmentStatus;
  checklist: ChecklistItem[];
}

export interface IssueActivity {
  action: string;
  actor: string;
  createdAt: string;
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
  responsibleOrgName: string | null;
  checklistItem: {
    id: string;
    documentTypeName: string;
    category: string | null;
    requiredBy: ChecklistRequiredBy;
  };
  sourceDocumentTypeName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  availableActions: { requestCorrection: boolean; resolve: boolean };
  activity: IssueActivity[];
}

export interface DirectoryOrg {
  id: string;
  name: string;
}

export interface AdminOrganizationSummary {
  id: string;
  name: string;
  orgType: OrgType;
  status: OrgStatus;
  createdAt: string;
  applicant: { name: string | null; email: string } | null;
}

export interface RolePermission {
  documentTypeId: string;
  documentTypeName: string;
  viewLevel: ViewLevel | null;
  canEdit: boolean;
  canDownload: boolean;
  canApprove: boolean;
  configured: boolean;
}

export interface AdminOrganizationDetail extends AdminOrganizationSummary {
  roles: Array<{ name: string; isOrgAdmin: boolean; permissions: RolePermission[] }>;
}
