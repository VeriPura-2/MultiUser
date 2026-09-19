import type { ReactNode } from "react";
import type { Tone } from "../labels";

/** A status pill. The tone chooses the colour pair from the tokens. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
