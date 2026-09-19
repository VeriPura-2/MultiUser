import type { IssueStatus } from "../../api/types";
import { ISSUE_STATUS_LABEL } from "../../labels";

/** The three stages an issue moves through, in order. */
export const ISSUE_STEPS: IssueStatus[] = ["open", "correction_requested", "resolved"];

export type StepState = "done" | "current" | "todo";

export interface Step {
  status: IssueStatus;
  label: string;
  number: number;
  state: StepState;
}

/**
 * The stepper. Steps before the current one are done, the current one is highlighted, later ones
 * are still to come. An issue can be resolved straight from open, so "correction requested" can
 * show as done without ever having been the current step.
 */
export function stepsFor(status: IssueStatus): Step[] {
  const at = ISSUE_STEPS.indexOf(status);
  return ISSUE_STEPS.map((s, i) => ({
    status: s,
    label: ISSUE_STATUS_LABEL[s],
    number: i + 1,
    state: i < at ? "done" : i === at ? "current" : "todo",
  }));
}

/** Plain wording for the audit actions the API puts in the activity list. Unknown ones are made readable rather than hidden. */
const ACTION_TEXT: Record<string, string> = {
  "issue.raised": "Raised the issue",
  "issue.correction_requested": "Requested a correction",
  "issue.resolved": "Marked the issue resolved",
};

export function describeAction(action: string): string {
  const known = ACTION_TEXT[action];
  if (known) return known;
  const words = action.replace(/^issue\./, "").replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Updated the issue";
}
