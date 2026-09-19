import { Suspense, lazy, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useActionQueue, useConsignments, usePartyWorkload } from "../api/hooks";
import { useCurrentUser } from "../auth/CurrentUser";
import { ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { count } from "../format";
import { SAMPLE_VESSELS } from "../sample/mapSample";
import { ThemeToggle } from "../theme/ThemeToggle";
import { ActionQueue } from "./dashboard/ActionQueue";
import { AttentionBand } from "./dashboard/AttentionBand";
import { ConsignmentList } from "./dashboard/ConsignmentList";
import { StatsRow } from "./dashboard/StatsRow";
import { counterpartyNoun, firstIssue, liveConsignments } from "./dashboard/model";
import "./dashboard/Dashboard.css";

// The map (Leaflet and its land data) is the heaviest part of the app, so it loads on its own.
const ConsignmentMap = lazy(() => import("./dashboard/ConsignmentMap").then((m) => ({ default: m.ConsignmentMap })));

/** The portfolio overview: what needs attention, headline numbers, the map and action queue, and every consignment. */
export function Dashboard() {
  const me = useCurrentUser();
  const consignments = useConsignments();
  const workload = usePartyWorkload();
  const queue = useActionQueue();
  const { hash } = useLocation();

  // The sidebar's Consignments entry links to #consignments on this page.
  useEffect(() => {
    if (hash && consignments.data) document.getElementById(hash.slice(1))?.scrollIntoView?.();
  }, [hash, consignments.data]);

  const noun = counterpartyNoun(me.organization?.orgType);
  const activeParties = workload.data?.counterparties.filter((p) => p.activeConsignmentCount > 0).length;
  const subtitle = consignments.data
    ? `${count(liveConsignments(consignments.data).length, "active consignment")}` +
      (activeParties === undefined ? "" : ` across ${count(activeParties, noun.singular, noun.plural)}`)
    : "";

  return (
    <>
      <div className="page-head">
        <h1>Portfolio overview</h1>
        <div className="actions">
          <ThemeToggle />
        </div>
      </div>
      <p className="page-sub">{subtitle}</p>

      {consignments.data ? <AttentionBand consignments={consignments.data} first={firstIssue(queue.data?.items, consignments.data)} /> : null}

      <StatsRow consignments={consignments} workload={workload} orgType={me.organization?.orgType} />

      <div className="split">
        <Suspense fallback={<LoadingSkeleton lines={6} label="Loading map" />}>
          <ConsignmentMap vessels={SAMPLE_VESSELS} />
        </Suspense>
        <ActionQueue queue={queue} />
      </div>

      {consignments.isError ? (
        <ErrorState error={consignments.error} onRetry={() => void consignments.refetch()} />
      ) : consignments.data ? (
        <ConsignmentList consignments={consignments.data} />
      ) : (
        <LoadingSkeleton lines={4} label="Loading consignments" />
      )}
    </>
  );
}
