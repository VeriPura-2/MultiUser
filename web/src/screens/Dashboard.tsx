import { Suspense, lazy, useEffect, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useActionQueue, useConsignments, usePartyWorkload, usePositions } from "../api/hooks";
import { useCurrentUser } from "../auth/CurrentUser";
import { Card } from "../components/Card";
import { ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { count } from "../format";
import { ThemeToggle } from "../theme/ThemeToggle";
import { ActionQueue } from "./dashboard/ActionQueue";
import { AttentionBand } from "./dashboard/AttentionBand";
import { ConsignmentList } from "./dashboard/ConsignmentList";
import { StatsRow } from "./dashboard/StatsRow";
import { buildMapVessels } from "./dashboard/mapModel";
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
  const positions = usePositions();
  const { hash } = useLocation();

  // Rebuilt only when the consignments or the positions actually change, so the map is not redrawn every minute for nothing.
  const vessels = useMemo(
    () => (consignments.data && positions.data ? buildMapVessels(consignments.data, positions.data) : null),
    [consignments.data, positions.data],
  );

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
          {me.organization?.orgType === "importer" ? (
            <Link to="/consignments/new" className="new-consignment">
              + New Consignment
            </Link>
          ) : null}
        </div>
      </div>
      <p className="page-sub">{subtitle}</p>

      {consignments.data ? <AttentionBand consignments={consignments.data} first={firstIssue(queue.data?.items, consignments.data)} /> : null}

      <StatsRow consignments={consignments} workload={workload} orgType={me.organization?.orgType} />

      <div className="split">
        {vessels ? (
          <Suspense fallback={<LoadingSkeleton lines={6} label="Loading map" />}>
            <ConsignmentMap vessels={vessels} />
          </Suspense>
        ) : (
          <MapPlaceholder
            error={positions.isError ? positions.error : consignments.isError ? consignments.error : null}
            onRetry={() => {
              void positions.refetch();
              void consignments.refetch();
            }}
          />
        )}
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

/** What the map card shows until there is something to draw: a loading state, or why there is nothing. */
function MapPlaceholder({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <Card as="section" aria-label="Consignment map, loading" className="map-card map-loading">
      <LoadingSkeleton lines={6} label="Loading map" />
    </Card>
  );
}
