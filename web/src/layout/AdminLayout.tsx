import type { ReactNode } from "react";
import { useAdminOrgs } from "../api/hooks";
import { ThemeToggle } from "../theme/ThemeToggle";

/** The superadmin console's layout: a dark top bar instead of a sidebar, as in its mockup. It shows how many applications are waiting. */
export function AdminLayout({ children }: { children: ReactNode }) {
  const pending = useAdminOrgs("pending_approval");
  return (
    <div style={{ minHeight: "100vh", background: "var(--ivory)" }}>
      <header className="topbar">
        <div className="left">
          <span className="brand display">VeriPura</span>
          <span className="console">Superadmin Console</span>
        </div>
        <div className="right">
          <ThemeToggle onNav />
          {pending.data ? <div className="queue">org-approvals · queue: {pending.data.length} pending</div> : null}
        </div>
      </header>
      <div className="admin-main">{children}</div>
    </div>
  );
}
