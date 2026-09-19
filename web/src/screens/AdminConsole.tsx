import { useState } from "react";
import { useAdminOrg, useAdminOrgs, useDecideOrganization, type OrgDecision } from "../api/hooks";
import type { AdminOrganizationDetail, AdminOrganizationSummary } from "../api/types";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { describeError, ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { Modal } from "../components/Modal";
import { OrgTypeTag } from "../components/OrgTypeTag";
import { formatDate, shortRef } from "../format";
import { NOT_APPLICABLE, configuredCounts, permissionRow, type Cell } from "./admin/model";
import "./admin/Admin.css";

interface Notice {
  name: string;
  decision: OrgDecision;
}

/** Organizations waiting for a decision: the queue, the selected application, its default permissions, and Approve or Reject. */
export function AdminConsole() {
  const pending = useAdminOrgs("pending_approval");
  const [chosen, setChosen] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The selection follows the list: if the chosen organization has left it (decided), the first one is shown.
  const list = pending.data ?? [];
  const selectedId = list.find((o) => o.id === chosen)?.id ?? list[0]?.id ?? null;

  return (
    <div className="admin-body">
      <h1>Pending organization applications</h1>
      <p className="page-sub">Review applicant details and default permission rules before onboarding a new organization.</p>

      {notice ? (
        <div role="status" className={`ad-notice ${notice.decision}`}>
          {notice.decision === "approve" ? `${notice.name} was approved.` : `${notice.name} was rejected.`}
        </div>
      ) : null}

      {pending.isError ? (
        <ErrorState error={pending.error} onRetry={() => void pending.refetch()} />
      ) : !pending.data ? (
        <LoadingSkeleton lines={4} label="Loading applications" />
      ) : list.length === 0 ? (
        <EmptyState title="No organizations are waiting for approval">New applications appear here when an organization applies.</EmptyState>
      ) : (
        <div className="ad-split">
          <Queue orgs={list} selectedId={selectedId} onSelect={setChosen} />
          {selectedId ? <Detail key={selectedId} id={selectedId} onDecided={(name, decision) => setNotice({ name, decision })} /> : null}
        </div>
      )}
    </div>
  );
}

function Queue({ orgs, selectedId, onSelect }: { orgs: AdminOrganizationSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <Card className="ad-table-card">
      <table>
        <thead>
          <tr>
            <th scope="col">Organization</th>
            <th scope="col">Type</th>
            <th scope="col">Applicant contact</th>
            <th scope="col">Submitted</th>
            <th scope="col">
              <span className="sr-only">Review</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => {
            const selected = org.id === selectedId;
            return (
              <tr key={org.id} className={selected ? "selected" : undefined}>
                <td className="strong">{org.name}</td>
                <td>
                  <OrgTypeTag type={org.orgType} variant="solid" />
                </td>
                <td>{org.applicant?.email ?? NOT_APPLICABLE}</td>
                <td>{formatDate(org.createdAt)}</td>
                <td>
                  <button type="button" className={`ad-review${selected ? " on" : ""}`} aria-pressed={selected} aria-label={`${selected ? "Reviewing" : "Review"} ${org.name}`} onClick={() => onSelect(org.id)}>
                    {selected ? "Reviewing" : "Review"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Detail({ id, onDecided }: { id: string; onDecided: (name: string, decision: OrgDecision) => void }) {
  const org = useAdminOrg(id);
  if (org.isError) return <ErrorState error={org.error} onRetry={() => void org.refetch()} />;
  if (!org.data) return <LoadingSkeleton lines={6} label="Loading application" />;
  return <DetailPanel org={org.data} onDecided={onDecided} />;
}

function DetailPanel({ org, onDecided }: { org: AdminOrganizationDetail; onDecided: (name: string, decision: OrgDecision) => void }) {
  const [asking, setAsking] = useState<OrgDecision | null>(null);
  const decide = useDecideOrganization(org.id);
  const counts = configuredCounts(org.roles);

  const close = () => {
    if (decide.isPending) return;
    decide.reset();
    setAsking(null);
  };
  const confirm = () => {
    if (!asking) return;
    const decision = asking;
    decide.mutate(decision, {
      onSuccess: () => {
        onDecided(org.name, decision);
        decide.reset();
        setAsking(null);
      },
    });
  };

  return (
    <Card className="ad-detail" as="section" aria-label={`Application from ${org.name}`}>
      <div className="ad-detail-head">
        <div>
          <div className="ad-name">{org.name}</div>
          <div className="ad-soft">Application {shortRef(org.id)}</div>
        </div>
        <OrgTypeTag type={org.orgType} variant="solid" />
      </div>

      <dl className="ad-facts">
        <div>
          <dt>Contact</dt>
          <dd>{org.applicant?.name ?? NOT_APPLICABLE}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{org.applicant?.email ?? NOT_APPLICABLE}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{formatDate(org.createdAt)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <Badge tone="gray">Pending approval</Badge>
          </dd>
        </div>
      </dl>

      <div className="ad-cap">Default permission rules on approval</div>
      <p className="ad-soft ad-rules-note">
        These are the rules configured today for {org.orgType.replace("_", " ")} organizations, one row for each role and document type.
        {counts.notConfigured > 0 ? ` ${counts.notConfigured} of ${counts.total} have no rule configured.` : ""}
      </p>
      <PermissionTable roles={org.roles} />

      <div className="ad-buttons">
        <button type="button" className="ad-approve" onClick={() => setAsking("approve")}>
          Approve organization
        </button>
        <button type="button" className="ad-reject" onClick={() => setAsking("reject")}>
          Reject
        </button>
      </div>

      <Modal open={asking !== null} title={asking === "approve" ? "Approve organization" : "Reject application"} onClose={close}>
        <p className="ad-confirm">
          {asking === "approve"
            ? `This approves ${org.name}. It becomes an active organization, its first user is activated, and it receives its five standard roles with the permissions shown.`
            : `This rejects the application from ${org.name}. It is marked as rejected and does not become active.`}
        </p>
        {decide.isError ? (
          <div role="alert" className="error-text">
            {describeError(decide.error).title}. {describeError(decide.error).detail}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={decide.isPending}>
            Cancel
          </button>
          <button type="button" className={`btn ${asking === "approve" ? "success" : "danger"}`} onClick={confirm} disabled={decide.isPending}>
            {decide.isPending ? "Working" : asking === "approve" ? "Approve" : "Reject application"}
          </button>
        </div>
      </Modal>
    </Card>
  );
}

const cellClass = (cell: Cell) => `cc${cell.tone ? ` ${cell.tone}` : ""}`;

function PermissionTable({ roles }: { roles: AdminOrganizationDetail["roles"] }) {
  if (roles.every((r) => r.permissions.length === 0)) {
    return <p className="ad-soft">No document types exist yet, so there are no rules to show.</p>;
  }
  return (
    <div className="ad-perm-scroll">
      <table className="ad-perm">
        <thead>
          <tr>
            <th scope="col">Document</th>
            <th scope="col" className="cc">View</th>
            <th scope="col" className="cc">Edit</th>
            <th scope="col" className="cc">Download</th>
            <th scope="col" className="cc">Approve</th>
          </tr>
        </thead>
        {roles.map((role) => (
          <tbody key={role.name}>
            <tr className="role-row">
              <th scope="rowgroup" colSpan={5}>
                {role.name}
                {role.isOrgAdmin ? " (organization admin)" : ""}
              </th>
            </tr>
            {role.permissions.map((p) => {
              const row = permissionRow(p);
              return row.kind === "not_configured" ? (
                <tr key={p.documentTypeId}>
                  <td>{row.documentTypeName}</td>
                  <td colSpan={4} className="cc nc">
                    Not configured
                  </td>
                </tr>
              ) : (
                <tr key={p.documentTypeId}>
                  <td>{row.documentTypeName}</td>
                  <td className={cellClass(row.view)}>{row.view.text}</td>
                  <td className={cellClass(row.edit)}>{row.edit.text}</td>
                  <td className={cellClass(row.download)}>{row.download.text}</td>
                  <td className={cellClass(row.approve)}>{row.approve.text}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
