import { Link } from "react-router-dom";
import type { ConsignmentSummary } from "../../api/types";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { count, countryName, shortRef } from "../../format";
import { CONSIGNMENT_STATUS } from "../../labels";
import { completenessPercent, liveConsignments } from "./model";

/** One row per consignment, each a link to its roadmap. Live ones first, finished ones after, under their own heading. */
export function ConsignmentList({ consignments }: { consignments: ConsignmentSummary[] }) {
  const live = liveConsignments(consignments);
  const finished = consignments.filter((c) => !live.includes(c));

  return (
    <section id="consignments" aria-label="Consignments" className="consignments">
      <h2>Active consignments</h2>
      {live.length === 0 ? (
        <EmptyState title="No active consignments">Consignments appear here once a purchase order is submitted.</EmptyState>
      ) : (
        <ul className="clist">
          {live.map((c) => (
            <ConsignmentRow key={c.id} consignment={c} />
          ))}
        </ul>
      )}
      {finished.length > 0 ? (
        <>
          <h2 className="finished-head">Finished consignments</h2>
          <ul className="clist">
            {finished.map((c) => (
              <ConsignmentRow key={c.id} consignment={c} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ConsignmentRow({ consignment: c }: { consignment: ConsignmentSummary }) {
  const percent = completenessPercent(c.checklistCompleteness);
  const status = CONSIGNMENT_STATUS[c.status];
  const hasIssues = c.openIssueCount > 0;

  return (
    <li>
      <Link to={`/consignments/${c.id}`} className={`card crow${hasIssues ? " has-issues" : ""}`}>
        <div>
          <div className="crow-title">
            {shortRef(c.id)} &middot; {c.commodity}
          </div>
          <div className="crow-parties">
            {c.exporterOrgName} &rarr; {c.importerOrgName}
          </div>
        </div>
        <div className="crow-route">
          {countryName(c.originCountry)} &rarr; {countryName(c.destinationCountry)}
        </div>
        <div>
          <div className="crow-pct">{percent}% complete</div>
          <div className="bar" role="presentation">
            <div className={`bar-fill${hasIssues ? "" : " ok"}`} style={{ width: `${percent}%` }} />
          </div>
        </div>
        <Badge tone={hasIssues ? "red" : "gray"}>{count(c.openIssueCount, "issue")}</Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
      </Link>
    </li>
  );
}
