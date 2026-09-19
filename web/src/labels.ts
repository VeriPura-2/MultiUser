import type { ChecklistItemStatus, ConsignmentStatus, IssueStatus, OrgType } from "./api/types";

/**
 * Display text for the backend's fixed vocabularies (statuses and organization types).
 * This is text for system values, not for documents: document names and categories always
 * come from the API and are never written in the app.
 */

export type Tone = "green" | "gray" | "blue" | "red";

export const ORG_TYPE_LABEL: Record<OrgType, string> = {
  importer: "Importer",
  exporter: "Exporter",
  logistics: "Logistics",
  lab_cert: "Lab / Cert",
  data_source: "Data Source",
};

export const CHECKLIST_STATUS: Record<ChecklistItemStatus, { label: string; tone: Tone }> = {
  awaiting_upload: { label: "Awaiting upload", tone: "gray" },
  pending: { label: "Under review", tone: "blue" },
  verified: { label: "Verified", tone: "green" },
  flagged: { label: "Correction needed", tone: "red" },
};

export const CONSIGNMENT_STATUS: Record<ConsignmentStatus, { label: string; tone: Tone }> = {
  po_submitted: { label: "PO submitted", tone: "gray" },
  checklist_pending: { label: "Awaiting checklist", tone: "gray" },
  checklist_received: { label: "In review", tone: "blue" },
  active: { label: "Active", tone: "green" },
  completed: { label: "Completed", tone: "green" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  correction_requested: "Correction requested",
  resolved: "Resolved",
};

/** Consignments that are still being worked. */
export const isLiveConsignment = (status: ConsignmentStatus): boolean => status !== "completed" && status !== "cancelled";
