import { Link } from "react-router-dom";
import type { ConsignmentSummary } from "../../api/types";
import { count, shortRef } from "../../format";
import { liveConsignments, type FirstIssue } from "./model";

/**
 * Shown only when something is wrong. It says how many consignments have open issues, and links to
 * the first one to look at.
 */
export function AttentionBand({ consignments, first }: { consignments: ConsignmentSummary[]; first: FirstIssue | null }) {
  const affected = liveConsignments(consignments).filter((c) => c.openIssueCount > 0);
  if (affected.length === 0) return null;

  const to = first ? (first.issueId ? `/issues/${first.issueId}` : `/consignments/${first.consignmentId}`) : `/consignments/${affected[0]!.id}`;
  const including = first?.issueId ? first.consignmentId : null;

  return (
    <section className="card attention" aria-label="Needs attention">
      <div className="attention-count" aria-hidden="true">
        {affected.length}
      </div>
      <div className="attention-text">
        <strong>
          {count(affected.length, "consignment")} {affected.length === 1 ? "has" : "have"} open issues
        </strong>{" "}
        requiring action
        {including ? (
          <>
            , including a flagged document on <strong>Consignment {shortRef(including)}</strong>
          </>
        ) : null}
        .
      </div>
      <Link to={to} className="attention-link">
        Review issues &rarr;
      </Link>
    </section>
  );
}
