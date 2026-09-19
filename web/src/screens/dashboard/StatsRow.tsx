import type { UseQueryResult } from "@tanstack/react-query";
import type { ConsignmentSummary, OrgType, PartyWorkloadResponse } from "../../api/types";
import { ErrorState } from "../../components/ErrorState";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";
import { StatCard } from "../../components/StatCard";
import { counterpartyNoun, portfolioStats } from "./model";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The four headline numbers. The first three come from the consignment list, the fourth from party workload. */
export function StatsRow({
  consignments,
  workload,
  orgType,
}: {
  consignments: UseQueryResult<ConsignmentSummary[]>;
  workload: UseQueryResult<PartyWorkloadResponse>;
  orgType: OrgType | undefined;
}) {
  const failed = consignments.isError ? consignments : workload.isError ? workload : null;
  if (failed) {
    return (
      <div className="stats-state">
        <ErrorState
          error={failed.error}
          onRetry={() => {
            void consignments.refetch();
            void workload.refetch();
          }}
        />
      </div>
    );
  }
  if (!consignments.data || !workload.data) return <LoadingSkeleton lines={2} label="Loading portfolio figures" />;

  const stats = portfolioStats(consignments.data);
  const noun = counterpartyNoun(orgType);
  return (
    <div className="stats">
      <StatCard label="Active consignments" value={stats.active} />
      <StatCard label="Open issues" value={stats.openIssues} tone={stats.openIssues > 0 ? "red" : undefined} />
      <StatCard label="Avg. completeness" value={stats.averageCompleteness === null ? "n/a" : `${stats.averageCompleteness}%`} />
      <StatCard label={`${capitalize(noun.singular)} parties`} value={workload.data.counterparties.length} />
    </div>
  );
}
