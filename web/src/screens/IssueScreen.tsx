import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useIssue, useRequestCorrection, useResolveIssue } from "../api/hooks";
import type { IssueDetail } from "../api/types";
import { Card } from "../components/Card";
import { describeError, ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { Modal } from "../components/Modal";
import { formatDate, initials, shortRef, timeAgo } from "../format";
import { ISSUE_STATUS_LABEL, ORG_TYPE_LABEL } from "../labels";
import { ThemeToggle } from "../theme/ThemeToggle";
import { describeAction, stepsFor } from "./issue/model";
import "./issue/Issue.css";

/** One issue: what is wrong, what was expected and found, who is responsible, the activity so far, and what the viewer may do. */
export function IssueScreen() {
  const { issueId = "" } = useParams();
  const issue = useIssue(issueId);

  if (issue.isError) {
    return (
      <div className="page">
        <div className="page-inner is-state">
          <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />
          <p className="is-back-only">
            <Link to="/">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }
  if (!issue.data) {
    return (
      <div className="page">
        <div className="page-inner">
          <LoadingSkeleton lines={5} label="Loading issue" />
        </div>
      </div>
    );
  }
  return <IssueView issue={issue.data} />;
}

function IssueView({ issue }: { issue: IssueDetail }) {
  const [dialog, setDialog] = useState<"correction" | "resolve" | null>(null);
  const resolved = issue.status === "resolved";

  return (
    <div className="page">
      <div className="page-inner is-page">
        <div className="is-top">
          <Link to={`/consignments/${issue.consignmentId}`} className="is-back">
            &larr; Back to Compliance Roadmap &middot; Consignment {shortRef(issue.consignmentId)}
          </Link>
          <ThemeToggle />
        </div>

        <div className="is-title">
          <h1 className="display">Issue: {issue.checklistItem.documentTypeName}</h1>
          <span className={`is-status${resolved ? " resolved" : ""}`}>{ISSUE_STATUS_LABEL[issue.status]}</span>
        </div>
        <p className="is-sub">
          Attached to a checklist item &middot; opened {formatDate(issue.createdAt)}
          {issue.resolvedAt ? ` and resolved ${formatDate(issue.resolvedAt)}` : ""}
        </p>

        <Stepper status={issue.status} />

        <div className="is-cols">
          <div className="is-main">
            <Problem issue={issue} />
            <Activity issue={issue} />
          </div>
          <aside className="is-aside">
            <Card className="is-card">
              <div className="is-cap">Responsible party</div>
              <div className="is-strong">{issue.responsibleOrgName ?? ORG_TYPE_LABEL[issue.responsibleOrgType]}</div>
              <div className="is-soft">{issue.responsibleOrgName ? ORG_TYPE_LABEL[issue.responsibleOrgType] : "Not one of the two trading parties"}</div>
            </Card>
            <Card className="is-card">
              <div className="is-cap">Checklist item</div>
              <div className="is-strong">{issue.checklistItem.documentTypeName}</div>
              <div className="is-soft">
                {issue.checklistItem.category ?? "Uncategorised"} &middot; Required from {ORG_TYPE_LABEL[issue.checklistItem.requiredBy]}
              </div>
            </Card>
            <Actions issue={issue} onCorrection={() => setDialog("correction")} onResolve={() => setDialog("resolve")} />
          </aside>
        </div>
      </div>

      <CorrectionDialog issueId={issue.id} open={dialog === "correction"} onClose={() => setDialog(null)} />
      <ResolveDialog issueId={issue.id} open={dialog === "resolve"} onClose={() => setDialog(null)} />
    </div>
  );
}

function Stepper({ status }: { status: IssueDetail["status"] }) {
  const steps = stepsFor(status);
  const resolved = status === "resolved";
  return (
    <Card className="is-stepper">
      <ol aria-label="Issue progress">
        {steps.map((step, i) => (
          <li key={step.status} className={`is-step ${step.state}${resolved && step.state === "current" ? " resolved" : ""}`} aria-current={step.state === "current" ? "step" : undefined}>
            {i > 0 ? <span className={`is-line${step.state !== "todo" ? " on" : ""}${resolved ? " resolved" : ""}`} aria-hidden="true" /> : null}
            <span className="is-step-body">
              <span className="is-dot" aria-hidden="true">
                {step.state === "done" || (resolved && step.state === "current") ? "✓" : step.number}
              </span>
              <span className="is-step-label">{step.label}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Problem({ issue }: { issue: IssueDetail }) {
  const hasValues = issue.expectedValue !== null || issue.foundValue !== null;
  return (
    <Card className="is-card is-wide">
      <h2>Problem</h2>
      <p className="is-problem">{issue.problem}</p>
      {hasValues ? (
        <div className="is-values">
          <div className="is-expected">
            <div className="is-cap">Expected</div>
            <div>{issue.expectedValue ?? "Not stated"}</div>
          </div>
          <div className="is-found">
            <div className="is-cap">Found</div>
            <div>{issue.foundValue ?? "Not stated"}</div>
          </div>
        </div>
      ) : null}
      {issue.sourceDocumentTypeName ? <div className="is-source">Source document: {issue.sourceDocumentTypeName}</div> : null}
    </Card>
  );
}

function Activity({ issue }: { issue: IssueDetail }) {
  return (
    <Card className="is-card is-wide" as="section" aria-label="Activity">
      <h2>Activity</h2>
      {issue.activity.length === 0 ? (
        <p className="is-soft">Nothing has happened on this issue yet.</p>
      ) : (
        <ul className="is-activity">
          {issue.activity.map((entry, i) => (
            <li key={`${entry.createdAt}:${i}`}>
              <div className="is-avatar" aria-hidden="true">
                {initials(entry.actor)}
              </div>
              <div className="is-entry">
                <div>
                  <strong>{entry.actor}</strong> <span className="is-when">{timeAgo(entry.createdAt)}</span>
                </div>
                <div className="is-what">{describeAction(entry.action)}</div>
                {entry.message ? <div className="is-message">{entry.message}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Only what the API says this viewer may do. */
function Actions({ issue, onCorrection, onResolve }: { issue: IssueDetail; onCorrection: () => void; onResolve: () => void }) {
  const { requestCorrection, resolve } = issue.availableActions;
  if (!requestCorrection && !resolve) return issue.status === "resolved" ? <p className="is-soft">This issue is resolved.</p> : null;
  return (
    <div className="is-actions">
      {requestCorrection ? (
        <button type="button" className="btn primary" onClick={onCorrection}>
          Request Correction
        </button>
      ) : null}
      {resolve ? (
        <button type="button" className="btn" onClick={onResolve}>
          Mark Resolved
        </button>
      ) : null}
    </div>
  );
}

function CorrectionDialog({ issueId, open, onClose }: { issueId: string; open: boolean; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useRequestCorrection(issueId);
  const empty = message.trim() === "";

  const close = () => {
    if (action.isPending) return;
    setMessage("");
    setTouched(false);
    action.reset();
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (empty) return;
    action.mutate(message.trim(), { onSuccess: close });
  };

  return (
    <Modal open={open} title="Request correction" onClose={close}>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="correction-message">Message to the responsible party</label>
          <textarea
            id="correction-message"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-invalid={touched && empty}
            aria-describedby={touched && empty ? "correction-error" : undefined}
          />
          {touched && empty ? (
            <div id="correction-error" className="error-text">
              Enter a message for the responsible party.
            </div>
          ) : null}
        </div>
        {action.isError ? (
          <div role="alert" className="error-text">
            {describeError(action.error).title}. {describeError(action.error).detail}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={action.isPending}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={action.isPending}>
            {action.isPending ? "Sending" : "Send request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResolveDialog({ issueId, open, onClose }: { issueId: string; open: boolean; onClose: () => void }) {
  const action = useResolveIssue(issueId);

  const close = () => {
    if (action.isPending) return;
    action.reset();
    onClose();
  };

  return (
    <Modal open={open} title="Mark issue resolved" onClose={close}>
      <p className="is-soft">This closes the issue. It cannot be reopened.</p>
      {action.isError ? (
        <div role="alert" className="error-text">
          {describeError(action.error).title}. {describeError(action.error).detail}
        </div>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={action.isPending}>
          Cancel
        </button>
        <button type="button" className="btn success" disabled={action.isPending} onClick={() => action.mutate(undefined, { onSuccess: close })}>
          {action.isPending ? "Resolving" : "Mark resolved"}
        </button>
      </div>
    </Modal>
  );
}
