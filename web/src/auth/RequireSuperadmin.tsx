import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useCurrentUser } from "./CurrentUser";

/**
 * Only superadmin may see what is inside. Anyone else is sent to the dashboard rather than shown
 * a screen they cannot use. The backend refuses them too (403), so this is a courtesy, not the lock.
 */
export function RequireSuperadmin({ children }: { children: ReactNode }) {
  const me = useCurrentUser();
  if (!me.isSuperadmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
