import type { AdminOrganizationDetail, RolePermission, ViewLevel } from "../../api/types";

/** How the approval screen words what the API returns. Nothing here invents a value. */

export const VIEW_LABEL: Record<ViewLevel, string> = {
  full: "Full",
  status_only: "Status only",
  hidden: "Hidden",
};

/** A cell that does not apply. Written as "n/a", never a dash. */
export const NOT_APPLICABLE = "n/a";

export type Cell = { text: string; tone?: "yes" | "no" | "na" };

export type PermissionRow =
  | { kind: "not_configured"; documentTypeName: string }
  | { kind: "rule"; documentTypeName: string; view: Cell; edit: Cell; download: Cell; approve: Cell };

const yesNo = (value: boolean): Cell => ({ text: value ? "Yes" : "No", tone: value ? "yes" : "no" });
const na: Cell = { text: NOT_APPLICABLE, tone: "na" };

/**
 * One row of the permission table. With no rule, the row says "not configured" and nothing else:
 * the API gives no view level then, and none is assumed. Editing, downloading and approving only
 * mean something for a document the role can see in full, so for status only or hidden they do not apply.
 */
export function permissionRow(p: RolePermission): PermissionRow {
  if (!p.configured || p.viewLevel === null) return { kind: "not_configured", documentTypeName: p.documentTypeName };
  const seesFull = p.viewLevel === "full";
  return {
    kind: "rule",
    documentTypeName: p.documentTypeName,
    view: { text: VIEW_LABEL[p.viewLevel] },
    edit: seesFull ? yesNo(p.canEdit) : na,
    download: seesFull ? yesNo(p.canDownload) : na,
    approve: seesFull ? yesNo(p.canApprove) : na,
  };
}

/** How many role-and-document rules have nothing configured, out of how many there are. */
export function configuredCounts(roles: AdminOrganizationDetail["roles"]): { notConfigured: number; total: number } {
  const all = roles.flatMap((r) => r.permissions);
  return { notConfigured: all.filter((p) => !p.configured || p.viewLevel === null).length, total: all.length };
}
