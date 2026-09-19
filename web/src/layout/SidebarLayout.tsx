import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useCurrentUser } from "../auth/CurrentUser";
import { initials } from "../format";

/**
 * Sidebar entries. Only the first two lead anywhere today. The rest have no screen yet, so they are
 * shown but disabled with a reason, the same way document upload and nudging are elsewhere, rather
 * than linking to a page that does not exist.
 */
const COMING_LATER = "This section is not built yet.";
const DISABLED_ENTRIES = ["Parties", "Issues", "Documents", "Settings"] as const;

/** The dashboard's layout: brand, navigation, and the signed-in user at the foot of the sidebar. */
export function SidebarLayout({ children }: { children: ReactNode }) {
  const me = useCurrentUser();
  const name = me.name ?? me.email;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand display">VeriPura</div>
        <div className="brand-sub">Control Tower</div>
        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
            Dashboard
          </NavLink>
          <Link to={{ pathname: "/", hash: "consignments" }} className="navlink">
            Consignments
          </Link>
          {DISABLED_ENTRIES.map((entry) => (
            <span key={entry} className="navlink disabled" role="link" aria-disabled="true" title={COMING_LATER}>
              {entry}
            </span>
          ))}
        </div>
        <div className="who">
          <div className="avatar" aria-hidden="true">
            {initials(name)}
          </div>
          <div className="who-text">
            <div className="who-name">{name}</div>
            <div className="who-org">{me.organization?.name ?? "VeriPura"}</div>
          </div>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
