import type { ActionQueueItem, ConsignmentSummary, DevUser, Me, PartyWorkloadRow } from "../src/api/types";
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
