import type { ActionQueueItem, ConsignmentSummary, OrgType } from "../../api/types";
import { isLiveConsignment } from "../../labels";

/** Everything the dashboard works out from the API's answers. Pure functions, so they are tested directly. */

export const liveConsignments = (all: ConsignmentSummary[]): ConsignmentSummary[] => all.filter((c) => isLiveConsignment(c.status));

export interface PortfolioStats {
  active: number;
  openIssues: number;
  /** Mean of each live consignment's verified share, 0 to 100. null when nothing has a checklist yet. */
  averageCompleteness: number | null;
}

export const completenessPercent = ({ verified, total }: ConsignmentSummary["checklistCompleteness"]): number =>
  total === 0 ? 0 : Math.round((verified / total) * 100);

export function portfolioStats(all: ConsignmentSummary[]): PortfolioStats {
  const live = liveConsignments(all);
  const withChecklist = live.filter((c) => c.checklistCompleteness.total > 0);
  const average =
    withChecklist.length === 0
      ? null
      : Math.round(
          withChecklist.reduce((sum, c) => sum + c.checklistCompleteness.verified / c.checklistCompleteness.total, 0) /
            withChecklist.length *
            100,
        );
  return {
    active: live.length,
    openIssues: live.reduce((sum, c) => sum + c.openIssueCount, 0),
    averageCompleteness: average,
  };
}

/** What to call the other side of a consignment, from the viewing organization's type. */
export function counterpartyNoun(orgType: OrgType | undefined): { singular: string; plural: string } {
  if (orgType === "importer") return { singular: "exporter", plural: "exporters" };
  if (orgType === "exporter") return { singular: "importer", plural: "importers" };
  return { singular: "partner", plural: "partners" };
}

export type QueueFilter = "all" | "mine" | "others";

export const QUEUE_FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Needs my org" },
  { id: "others", label: "Waiting on others" },
];

export function filterQueue(items: ActionQueueItem[], filter: QueueFilter): ActionQueueItem[] {
  if (filter === "mine") return items.filter((i) => i.actionableByMyOrg);
  if (filter === "others") return items.filter((i) => !i.actionableByMyOrg);
  return items;
}

export interface FirstIssue {
  consignmentId: string;
  /** Set when the queue names the issue itself, so the link can go straight to it. */
  issueId: string | null;
}

/**
 * Where the attention band's link should go: the first flagged document in the queue (the queue is
 * already ordered flagged first), else the first consignment that has an open issue.
 */
export function firstIssue(queue: ActionQueueItem[] | undefined, consignments: ConsignmentSummary[]): FirstIssue | null {
  const flagged = queue?.find((item) => item.status === "flagged");
  if (flagged) return { consignmentId: flagged.consignmentId, issueId: flagged.issueId };
  const withIssue = liveConsignments(consignments).find((c) => c.openIssueCount > 0);
  return withIssue ? { consignmentId: withIssue.id, issueId: null } : null;
}
