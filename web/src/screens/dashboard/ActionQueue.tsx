import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ActionQueueItem, ActionQueueResponse } from "../../api/types";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { DisabledAction } from "../../components/DisabledAction";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";
import { OrgTypeTag } from "../../components/OrgTypeTag";
import { count, shortRef } from "../../format";
import { CHECKLIST_STATUS } from "../../labels";
import { QUEUE_FILTERS, filterQueue, type QueueFilter } from "./model";

const UPLOAD_LATER = "Document upload is coming in a later stage.";
const NUDGE_LATER = "Nudging a party is coming in a later stage.";

/** The action queue: open issues first, then documents awaiting upload, filterable by who has to act. */
export function ActionQueue({ queue }: { queue: UseQueryResult<ActionQueueResponse> }) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const shown = queue.data ? filterQueue(queue.data.items, filter) : [];

  return (
    <Card as="section" aria-label="Required documents action queue" className="queue-card">
      <div className="panel-head">
        <div className="panel-title">
          <h2>Required documents</h2>
          {queue.data ? (
            <span className="panel-count" aria-live="polite">
              {count(shown.length, "item")}
            </span>
          ) : null}
        </div>
        <p className="panel-sub">Action queue: open issues first, then documents awaiting upload.</p>
        <div className="chip-row" role="group" aria-label="Filter queue">
          {QUEUE_FILTERS.map((f) => (
            <button key={f.id} type="button" className={`chip${filter === f.id ? " on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <QueueBody queue={queue} shown={shown} filtered={filter !== "all"} />
    </Card>
  );
}

function QueueBody({ queue, shown, filtered }: { queue: UseQueryResult<ActionQueueResponse>; shown: ActionQueueItem[]; filtered: boolean }) {
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  if (!queue.data) return <LoadingSkeleton lines={4} label="Loading required documents" />;
  if (shown.length === 0) {
    return filtered ? (
      <EmptyState title="Nothing in this view">Try another filter.</EmptyState>
    ) : (
      <EmptyState title="Nothing needs action">Every required document is uploaded and in order.</EmptyState>
    );
  }
  return (
    <ul className="queue">
      {shown.map((item, index) => (
        <QueueRow key={`${item.consignmentId}:${item.documentTypeName}:${index}`} item={item} />
      ))}
    </ul>
  );
}

function QueueRow({ item }: { item: ActionQueueItem }) {
  const flagged = item.status === "flagged";
  const status = CHECKLIST_STATUS[item.status];
  const owner = item.responsibleOrgType ?? item.requiredBy;

  return (
    <li className={`qrow${flagged ? " issue" : ""}`}>
      <div className="q-main">
        <div className="q-title">
          <Link to={`/consignments/${item.consignmentId}`}>{shortRef(item.consignmentId)}</Link> &middot; {item.documentTypeName}
        </div>
        <div className="q-meta">
          {owner ? <OrgTypeTag type={owner} /> : null}
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="q-label">{item.consignmentLabel}</span>
        </div>
      </div>
      <QueueAction item={item} />
    </li>
  );
}

function QueueAction({ item }: { item: ActionQueueItem }) {
  if (item.status === "flagged") {
    return item.issueId ? (
      <Link to={`/issues/${item.issueId}`} className="qbtn primary">
        View issue
      </Link>
    ) : null;
  }
  return item.actionableByMyOrg ? (
    <DisabledAction label="Upload" reason={UPLOAD_LATER} className="qbtn primary" />
  ) : (
    <DisabledAction label="Nudge party" reason={NUDGE_LATER} className="qbtn" />
  );
}
