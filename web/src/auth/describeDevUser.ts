import type { DevUser } from "../api/types";

/** One line for a sample user: "Ivy Importer, Sample Importer Ltd (Organization Admin)". */
export function describeDevUser(user: DevUser): string {
  const who = user.name ?? user.email;
  if (user.isSuperadmin) return `${who}, VeriPura superadmin`;
  const org = user.organization?.name ?? "no organization";
  const roles = user.roleNames.length ? ` (${user.roleNames.join(", ")})` : "";
  const inactive = user.status !== "active" ? ` [${user.status}]` : "";
  return `${who}, ${org}${roles}${inactive}`;
}
