import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./client";
import type { ActionQueueResponse, ConsignmentPositionItem, AdminOrganizationDetail, AdminOrganizationSummary, Checklist, ConsignmentDetail, ConsignmentSummary, DirectoryOrg, DevUser, IssueDetail, Me, PartyWorkloadResponse } from "./types";

/** Query keys in one place, so a mutation can invalidate exactly what it changed. */
export const keys = {
  me: ["me"] as const,
  devUsers: ["dev-users"] as const,
  consignments: ["consignments"] as const,
  workload: ["parties-workload"] as const,
  actionQueue: ["action-queue"] as const,
  consignment: (id: string) => ["consignment", id] as const,
  checklist: (id: string) => ["checklist", id] as const,
  issue: (id: string) => ["issue", id] as const,
  exporters: ["exporters"] as const,
  positions: ["positions"] as const,
  adminOrgs: (status: string) => ["admin-orgs", status] as const,
  adminOrg: (id: string) => ["admin-org", id] as const,
};

/** Who the app is acting as. Every screen keys off this, so it is fetched once and cached. */
export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/me") });
}

/** The sample users behind the development switcher. Development only. */
export function useDevUsers() {
  return useQuery({ queryKey: keys.devUsers, queryFn: () => api.get<{ users: DevUser[] }>("/dev/users").then((r) => r.users) });
}

/** Every consignment the acting user's organization is a party to. */
export function useConsignments() {
  return useQuery({
    queryKey: keys.consignments,
    queryFn: () => api.get<{ consignments: ConsignmentSummary[] }>("/consignments").then((r) => r.consignments),
  });
}

/** The organizations the acting user's organization trades with, and what is outstanding with each. */
export function usePartyWorkload() {
  return useQuery({ queryKey: keys.workload, queryFn: () => api.get<PartyWorkloadResponse>("/parties/workload") });
}

/** Documents that need action, open issues first. */
export function useActionQueue() {
  return useQuery({ queryKey: keys.actionQueue, queryFn: () => api.get<ActionQueueResponse>("/action-queue") });
}

/** One consignment's header facts. A consignment the user is not a party to answers 404. */
export function useConsignmentDetail(id: string) {
  return useQuery({ queryKey: keys.consignment(id), queryFn: () => api.get<ConsignmentDetail>(`/consignments/${encodeURIComponent(id)}`) });
}

/** One consignment's checklist, already filtered by what the user may see. */
export function useChecklist(id: string) {
  return useQuery({ queryKey: keys.checklist(id), queryFn: () => api.get<Checklist>(`/consignments/${encodeURIComponent(id)}/checklist`) });
}

/** One issue with its activity and what the viewer may do next. A viewer who may not see it gets 404. */
export function useIssue(id: string) {
  return useQuery({ queryKey: keys.issue(id), queryFn: () => api.get<IssueDetail>(`/issues/${encodeURIComponent(id)}`) });
}

/**
 * Acting on an issue changes more than the issue: the checklist row, the dashboard's counts and the
 * action queue all follow from it. The answer to the action is the issue as it now stands, so it is
 * put straight into the cache, and everything else that depends on it is marked stale.
 */
function useIssueAction<TVariables>(issueId: string, send: (variables: TVariables) => Promise<IssueDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (updated) => {
      client.setQueryData(keys.issue(issueId), updated);
      void client.invalidateQueries({ queryKey: keys.checklist(updated.consignmentId) });
      void client.invalidateQueries({ queryKey: keys.consignments });
      void client.invalidateQueries({ queryKey: keys.actionQueue });
      void client.invalidateQueries({ queryKey: keys.workload });
    },
  });
}

export function useRequestCorrection(issueId: string) {
  return useIssueAction(issueId, (message: string) =>
    api.post<IssueDetail>(`/issues/${encodeURIComponent(issueId)}/request-correction`, { message }),
  );
}

export function useResolveIssue(issueId: string) {
  return useIssueAction(issueId, () => api.post<IssueDetail>(`/issues/${encodeURIComponent(issueId)}/resolve`));
}

/** The approved exporters a purchase order can be addressed to. */
export function useExporters() {
  return useQuery({
    queryKey: keys.exporters,
    queryFn: () => api.get<{ organizations: DirectoryOrg[] }>("/organizations/exporters").then((r) => r.organizations),
  });
}

/** Submits a purchase order. The new consignment appears on the dashboard, so what lists consignments is marked stale. */
export function useSubmitConsignment() {
  const client = useQueryClient();
  const staleLists = () => {
    void client.invalidateQueries({ queryKey: keys.consignments });
    void client.invalidateQueries({ queryKey: keys.actionQueue });
    void client.invalidateQueries({ queryKey: keys.workload });
    void client.invalidateQueries({ queryKey: keys.positions });
  };
  return useMutation({
    mutationFn: (form: FormData) => api.postForm<{ consignment: ConsignmentDetail }>("/consignments", form).then((r) => r.consignment),
    onSuccess: (consignment) => {
      client.setQueryData(keys.consignment(consignment.id), consignment);
      staleLists();
    },
    // A 502 means the purchase order was saved even though the checklist service was unreachable.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 502) staleLists();
    },
  });
}

/** Organizations with a given status, oldest first (the approval queue is first come, first served). Superadmin only. */
export function useAdminOrgs(status: string) {
  return useQuery({
    queryKey: keys.adminOrgs(status),
    queryFn: () =>
      api.get<{ organizations: AdminOrganizationSummary[] }>(`/admin/organizations?status=${encodeURIComponent(status)}`).then((r) => r.organizations),
  });
}

/** One organization with the standard roles and the permissions they would receive. */
export function useAdminOrg(id: string | null) {
  return useQuery({
    queryKey: keys.adminOrg(id ?? ""),
    queryFn: () => api.get<AdminOrganizationDetail>(`/admin/organizations/${encodeURIComponent(id!)}`),
    enabled: id !== null,
  });
}

export type OrgDecision = "approve" | "reject";

/**
 * Approves or rejects an organization. The answer is the organization as it now stands. It leaves the
 * pending list, and an approved exporter becomes choosable on the purchase order form, so both are marked stale.
 */
export function useDecideOrganization(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (decision: OrgDecision) => api.post<AdminOrganizationDetail>(`/admin/organizations/${encodeURIComponent(id)}/${decision}`),
    onSuccess: (updated) => {
      client.setQueryData(keys.adminOrg(id), updated);
      void client.invalidateQueries({ queryKey: ["admin-orgs"] });
      void client.invalidateQueries({ queryKey: keys.exporters });
    },
  });
}

/** How often the map re-reads positions while the tab is showing. This reads only our own database. */
export const POSITIONS_REFETCH_MS = 60_000;

/**
 * Where each consignment's vessel is. The server answers from its own database and never calls a
 * position provider for this, so refetching every minute costs nothing at the provider. The interval
 * pauses while the tab is hidden (refetchIntervalInBackground is off), so a forgotten tab does no work.
 */
export function usePositions() {
  return useQuery({
    queryKey: keys.positions,
    queryFn: () => api.get<{ positions: ConsignmentPositionItem[] }>("/positions").then((r) => r.positions),
    refetchInterval: POSITIONS_REFETCH_MS,
    refetchIntervalInBackground: false,
  });
}
