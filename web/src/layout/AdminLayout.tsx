import type { ReactNode } from "react";
import { ThemeToggle } from "../theme/ThemeToggle";

/** The superadmin console's layout: a dark top bar instead of a sidebar, as in its mockup. */
export function AdminLayout({ children, pendingCount }: { children: ReactNode; pendingCount?: number }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--ivory)" }}>
      <header className="topbar">
        <div className="left">
          <span className="brand display">VeriPura</span>
          <span className="console">Superadmin Console</span>
        </div>
        <div className="right">
          <ThemeToggle onNav />
          {pendingCount === undefined ? null : <div className="queue">org-approvals · queue: {pendingCount} pending</div>}
        </div>
      </header>
      <div className="admin-main">{children}</div>
    </div>
  );
}
