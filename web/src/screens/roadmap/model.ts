import type { ChecklistItem } from "../../api/types";
import { isFullItem } from "../../api/types";

/** How the roadmap arranges a checklist. Pure, so it is tested directly. */

/** Shown for a full item whose document type has no category. */
export const UNCATEGORISED = "Uncategorised";
/** Shown for items the viewer may see only the status of: their category is not part of what they may know. */
export const LIMITED_ACCESS = "Limited access";

export interface ChecklistGroup {
  label: string;
  items: ChecklistItem[];
}

/**
 * Groups items by the category the API gives, never by a list of names in the app. Named
 * categories come first, alphabetically (so the order does not depend on how the server happens
 * to return rows), then Uncategorised, then Limited access. Within a group the API's order holds.
 */
export function groupChecklist(items: ChecklistItem[]): ChecklistGroup[] {
  const named = new Map<string, ChecklistItem[]>();
  const uncategorised: ChecklistItem[] = [];
  const limited: ChecklistItem[] = [];

  for (const item of items) {
    if (!isFullItem(item)) {
      limited.push(item);
    } else if (item.category && item.category.trim() !== "") {
      const group = named.get(item.category) ?? [];
      group.push(item);
      named.set(item.category, group);
    } else {
      uncategorised.push(item);
    }
  }

  const groups: ChecklistGroup[] = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, groupItems]) => ({ label, items: groupItems }));
  if (uncategorised.length > 0) groups.push({ label: UNCATEGORISED, items: uncategorised });
  if (limited.length > 0) groups.push({ label: LIMITED_ACCESS, items: limited });
  return groups;
}

export interface ItemButtons {
  upload: boolean;
  download: boolean;
  approve: boolean;
}

/**
 * Which buttons a row shows, decided only by the flags the API returned and by where the document
 * stands. (Every one of them is rendered disabled for now: upload, download and approval are later
 * stages. What matters here is that a user without the flag never sees the button.)
 */
export function buttonsFor(item: ChecklistItem): ItemButtons {
  if (!isFullItem(item)) return { upload: false, download: false, approve: false };
  return {
    upload: item.canEdit && (item.status === "awaiting_upload" || item.status === "flagged"),
    download: item.canDownload && item.status !== "awaiting_upload",
    approve: item.canApprove && item.status === "pending",
  };
}
