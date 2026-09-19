import type { ReactNode } from "react";
import { Card } from "./Card";

/** Shown when a screen or list has nothing to show. It says why, so it never looks broken. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="state">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </Card>
  );
}
