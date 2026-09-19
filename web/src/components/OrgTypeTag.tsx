import type { OrgType } from "../api/types";
import { ORG_TYPE_LABEL } from "../labels";

/**
 * An organization type. "outline" is the plain tag used in rows; "solid" is the coloured chip
 * used on the superadmin screen.
 */
export function OrgTypeTag({ type, variant = "outline" }: { type: OrgType; variant?: "outline" | "solid" }) {
  const label = ORG_TYPE_LABEL[type] ?? type;
  return variant === "solid" ? <span className={`otag ${type}`}>{label}</span> : <span className="tag">{label}</span>;
}
