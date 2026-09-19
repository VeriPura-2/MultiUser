import { Link, useParams } from "react-router-dom";
import { useChecklist, useConsignmentDetail } from "../api/hooks";
import { isFullItem, type Checklist, type ChecklistItem, type ConsignmentDetail } from "../api/types";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { DisabledAction } from "../components/DisabledAction";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { OrgTypeTag } from "../components/OrgTypeTag";
import { countryName, formatDate, shortRef } from "../format";
import { CHECKLIST_STATUS, CONSIGNMENT_STATUS } from "../labels";
import { ThemeToggle } from "../theme/ThemeToggle";
import { buttonsFor, groupChecklist } from "./roadmap/model";
import "./roadmap/Roadmap.css";

const UPLOAD_LATER = "Document upload is coming in a later stage.";
const DOWNLOAD_LATER = "Document download is coming in a later stage.";
const APPROVE_LATER = "Approving a document is coming in a later stage.";

/** One consignment's compliance roadmap: its header facts, and its checklist grouped by category. */
export function Roadmap() {
  const { consignmentId = "" } = useParams();
  const detail = useConsignmentDetail(consignmentId);
  const checklist = useChecklist(consignmentId);

  if (detail.isError) {
    return (
      <div className="page">
        <div className="page-inner rm-state">
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          <p className="rm-back-only">
            <Link to="/">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rm">
      <RoadmapHeader consignmentId={consignmentId} detail={detail.data} />
      <div className="rm-body" id="roadmap-panel" role="tabpanel" aria-labelledby="roadmap-tab">
        <RoadmapBody checklist={checklist} />
      </div>
    </div>
  );
}

function RoadmapHeader({ consignmentId, detail }: { consignmentId: string; detail: ConsignmentDetail | undefined }) {
  const status = detail ? CONSIGNMENT_STATUS[detail.status] : null;
  return (
    <header className="rm-head">
      <div className="rm-head-row">
        <div>
          <div className="rm-eyebrow">Consignment {shortRef(consignmentId)}</div>
          {detail ? (
            <h1 className="display">
              {detail.commodity} &middot; {countryName(detail.originCountry)} &rarr; {countryName(detail.destinationCountry)}
            </h1>
          ) : (
            <h1 className="display">Loading consignment</h1>
          )}
        </div>
        <div className="rm-head-actions">
          <Link to="/" className="rm-back">
            &larr; Back to dashboard
          </Link>
          <ThemeToggle />
        </div>
      </div>
      {detail ? (
        <dl className="rm-meta">
          <div>
            <dt>Seller</dt>
            <dd>{detail.exporterOrg.name}</dd>
          </div>
          <div>
            <dt>Buyer</dt>
            <dd>{detail.importerOrg.name}</dd>
          </div>
          {detail.hsCode ? (
            <div>
              <dt>HS Code</dt>
              <dd>{detail.hsCode}</dd>
            </div>
          ) : null}
          <div>
            <dt>Product</dt>
            <dd>{detail.commodity}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{status ? <Badge tone={status.tone}>{status.label}</Badge> : null}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(detail.createdAt)}</dd>
          </div>
        </dl>
      ) : (
        <div className="rm-meta-loading">
          <LoadingSkeleton lines={1} label="Loading consignment details" />
        </div>
      )}
      <div className="rm-tabs" role="tablist" aria-label="Consignment">
        <span id="roadmap-tab" className="tab active" role="tab" aria-selected="true" aria-controls="roadmap-panel">
          Compliance Roadmap
        </span>
      </div>
    </header>
  );
}

function RoadmapBody({ checklist }: { checklist: ReturnType<typeof useChecklist> }) {
  if (checklist.isError) return <ErrorState error={checklist.error} onRetry={() => void checklist.refetch()} />;
  if (!checklist.data) return <LoadingSkeleton lines={5} label="Loading checklist" />;
  return <ChecklistGroups data={checklist.data} />;
}

function ChecklistGroups({ data }: { data: Checklist }) {
  if (data.checklist.length === 0) {
    return (
      <EmptyState title="No checklist yet">
        The required documents appear here once the checklist for this consignment has arrived.
      </EmptyState>
    );
  }
  const groups = groupChecklist(data.checklist);
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} className="rm-group" aria-label={group.label}>
          <h2 className="gh">
            {group.label} <span className="gh-count">({group.items.length})</span>
          </h2>
          <ul className="rm-rows">
            {group.items.map((item) => (
              <li key={item.checklistItemId}>
                <ChecklistRow item={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const status = CHECKLIST_STATUS[item.status];
  const full = isFullItem(item);

  // A flagged document with an issue is one link to that issue: the whole row, as in the mockup.
  if (full && item.status === "flagged" && item.openIssue) {
    return (
      <Link to={`/issues/${item.openIssue.issueId}`} className="row flagged">
        <div className="row-main">
          <div className="row-name">{item.documentTypeName}</div>
          <div className="row-issue">{item.openIssue.problem} &middot; view issue</div>
        </div>
        <OrgTypeTag type={item.requiredBy} />
        <Badge tone={status.tone}>{status.label}</Badge>
      </Link>
    );
  }

  const buttons = buttonsFor(item);
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-name">{item.documentTypeName}</div>
      </div>
      {full ? <OrgTypeTag type={item.requiredBy} /> : null}
      <Badge tone={status.tone}>{status.label}</Badge>
      {buttons.upload ? <DisabledAction label="Upload" reason={UPLOAD_LATER} className="upl" /> : null}
      {buttons.download ? <DisabledAction label="Download" reason={DOWNLOAD_LATER} className="upl" /> : null}
      {buttons.approve ? <DisabledAction label="Approve" reason={APPROVE_LATER} className="upl" /> : null}
    </div>
  );
}
