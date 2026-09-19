import type { ActionQueueItem, ConsignmentDetail, ConsignmentSummary, DevUser, FullChecklistItem, IssueDetail, Me, PartyWorkloadRow, StatusOnlyChecklistItem } from "../src/api/types";
import { mockApi, respond } from "./mockApi";

/**
 * Sample users for tests. These are test data, kept outside web/src, so document names and
 * categories used elsewhere in tests never appear in the app itself.
 */

export const importerAdmin: Me = {
  userId: "user-importer-admin",
  name: "Ivy Importer",
  email: "admin@importer.example.test",
  organization: { id: "org-importer", name: "Sample Importer Ltd", orgType: "importer" },
  roleNames: ["Organization Admin"],
  isSuperadmin: false,
};

export const importerViewer: Me = {
  userId: "user-importer-viewer",
  name: "Victor Viewer",
  email: "viewer@importer.example.test",
  organization: { id: "org-importer", name: "Sample Importer Ltd", orgType: "importer" },
  roleNames: ["Viewer"],
  isSuperadmin: false,
};

export const exporterAdmin: Me = {
  userId: "user-exporter-admin",
  name: "Alma Alpha",
  email: "admin@alpha.example.test",
  organization: { id: "org-alpha", name: "Sample Exporter Alpha", orgType: "exporter" },
  roleNames: ["Organization Admin"],
  isSuperadmin: false,
};

export const superadmin: Me = {
  userId: "user-superadmin",
  name: "Sample Superadmin",
  email: "superadmin@example.test",
  organization: null,
  roleNames: [],
  isSuperadmin: true,
};

export const devUsers: DevUser[] = [importerAdmin, importerViewer, exporterAdmin, superadmin].map((u) => ({ ...u, status: "active" }));

/** A /me handler that answers as `user` only when that user's id is sent, and 401 otherwise. */
export function meFor(user: Me) {
  return (request: { headers: Headers }) =>
    request.headers.get("X-Dev-User") === user.userId ? user : respond(401, { error: "unauthenticated" });
}

// Dashboard data ---------------------------------------------------------------------------


let sequence = 0;
/** A consignment summary with sensible defaults; each call gets a distinct id. */
export function consignment(overrides: Partial<ConsignmentSummary> = {}): ConsignmentSummary {
  sequence += 1;
  const n = String(sequence).padStart(8, "0");
  return {
    id: `${n}-0000-4000-8000-000000000000`,
    commodity: "Frozen beef",
    status: "checklist_received",
    counterpartOrgName: "Sample Exporter Alpha",
    importerOrgName: "Sample Importer Ltd",
    exporterOrgName: "Sample Exporter Alpha",
    originCountry: "BR",
    destinationCountry: "GB",
    checklistCompleteness: { verified: 1, total: 4 },
    openIssueCount: 0,
    ...overrides,
  };
}

export function queueItem(overrides: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    consignmentId: "00000001-0000-4000-8000-000000000000",
    consignmentLabel: "Frozen beef, BR to GB",
    documentTypeName: "Sample Certificate A",
    requiredBy: "exporter",
    status: "awaiting_upload",
    issueId: null,
    responsibleOrgType: null,
    actionableByMyOrg: false,
    ...overrides,
  };
}

export const workloadRow = (name: string, activeConsignmentCount = 1): PartyWorkloadRow => ({
  counterpartyOrgId: `org-${name}`,
  counterpartyOrgName: name,
  activeConsignmentCount,
  documentsAwaitingUploadCount: 0,
  openIssueCount: 0,
});

/** Mocks everything the dashboard asks for, as `user`. Anything not given is empty. */
export function dashboardApi(
  user: Me,
  data: { consignments?: ConsignmentSummary[]; queue?: ActionQueueItem[]; parties?: PartyWorkloadRow[] } = {},
  extra: Record<string, unknown> = {},
) {
  localStorage.setItem("vp-dev-user", user.userId);
  return mockApi({
    "GET /me": user,
    "GET /consignments": { consignments: data.consignments ?? [] },
    "GET /parties/workload": { orgId: user.organization?.id ?? "", counterparties: data.parties ?? [] },
    "GET /action-queue": { orgId: user.organization?.id ?? "", items: data.queue ?? [] },
    ...extra,
  });
}

// Roadmap data -----------------------------------------------------------------------------

export function detail(overrides: Partial<ConsignmentDetail> = {}): ConsignmentDetail {
  return {
    id: "a1b2c3d4-0000-4000-8000-000000000000",
    status: "checklist_received",
    commodity: "Frozen boneless beef",
    hsCode: "0202.30",
    originCountry: "BR",
    destinationCountry: "GB",
    importerOrg: { id: "org-importer", name: "Sample Importer Ltd" },
    exporterOrg: { id: "org-alpha", name: "Sample Exporter Alpha" },
    createdAt: "2026-09-16T09:30:00.000Z",
    ...overrides,
  };
}

let itemSeq = 0;
/** A checklist item the viewer has full access to. Flags default to false, as the API would give a read-only role. */
export function fullItem(overrides: Partial<FullChecklistItem> = {}): FullChecklistItem {
  itemSeq += 1;
  return {
    checklistItemId: `item-${itemSeq}`,
    documentTypeName: `Sample Document ${itemSeq}`,
    requiredBy: "exporter",
    status: "awaiting_upload",
    category: "Sample Category One",
    canEdit: false,
    canDownload: false,
    canApprove: false,
    openIssue: null,
    ...overrides,
  };
}

export function statusOnlyItem(overrides: Partial<StatusOnlyChecklistItem> = {}): StatusOnlyChecklistItem {
  itemSeq += 1;
  return {
    checklistItemId: `item-${itemSeq}`,
    documentTypeName: `Sealed Document ${itemSeq}`,
    status: "pending",
    canEdit: false,
    canDownload: false,
    canApprove: false,
    ...overrides,
  };
}

/** Mocks a consignment's header and checklist, as `user`. */
export function roadmapApi(
  user: Me,
  data: { detail?: ConsignmentDetail; checklist?: Array<FullChecklistItem | StatusOnlyChecklistItem> } = {},
  extra: Record<string, unknown> = {},
) {
  localStorage.setItem("vp-dev-user", user.userId);
  const d = data.detail ?? detail();
  return mockApi({
    "GET /me": user,
    "GET /consignments/:id": d,
    "GET /consignments/:id/checklist": { consignmentId: d.id, consignmentStatus: d.status, checklist: data.checklist ?? [] },
    ...extra,
  });
}

// Issue data ------------------------------------------------------------------------------

export function issueDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: "issue-1",
    consignmentId: "a1b2c3d4-0000-4000-8000-000000000000",
    status: "open",
    problem: "A reference number does not match the source document",
    expectedValue: "RVX-2287",
    foundValue: "RVX-2291",
    responsibleOrgType: "exporter",
    responsibleOrgName: "Sample Exporter Alpha",
    checklistItem: { id: "item-9", documentTypeName: "Sample Certificate", category: "Sample Category", requiredBy: "exporter" },
    sourceDocumentTypeName: "Sample Invoice",
    createdAt: "2026-09-16T09:30:00.000Z",
    resolvedAt: null,
    availableActions: { requestCorrection: true, resolve: true },
    activity: [],
    ...overrides,
  };
}

/** Mocks one issue, as `user`. The issue can be a function so an action can change what the next read returns. */
export function issueApi(user: Me, issue: IssueDetail | (() => IssueDetail) = issueDetail(), extra: Record<string, unknown> = {}) {
  localStorage.setItem("vp-dev-user", user.userId);
  return mockApi({
    "GET /me": user,
    "GET /issues/:id": () => (typeof issue === "function" ? issue() : issue),
    ...extra,
  });
}

// Intake data -----------------------------------------------------------------------------

export const exporterOrgs = [
  { id: "org-alpha", name: "Sample Exporter Alpha" },
  { id: "org-bravo", name: "Sample Exporter Bravo" },
];

/** Mocks the intake form's data, as `user`. */
export function intakeApi(user: Me, orgs: Array<{ id: string; name: string }> = exporterOrgs, extra: Record<string, unknown> = {}) {
  localStorage.setItem("vp-dev-user", user.userId);
  return mockApi({
    "GET /me": user,
    "GET /organizations/exporters": { organizations: orgs },
    ...extra,
  });
}
