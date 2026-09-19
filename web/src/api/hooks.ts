import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { ActionQueueResponse, Checklist, ConsignmentDetail, ConsignmentSummary, DevUser, Me, PartyWorkloadResponse } from "./types";

/** Query keys in one place, so a mutation can invalidate exactly what it changed. */
export const keys = {
  me: ["me"] as const,
  devUsers: ["dev-users"] as const,
  consignments: ["consignments"] as const,
  workload: ["parties-workload"] as const,
  actionQueue: ["action-queue"] as const,
  consignment: (id: string) => ["consignment", id] as const,
  checklist: (id: string) => ["checklist", id] as const,
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
