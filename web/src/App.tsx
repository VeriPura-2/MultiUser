import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "./auth/AuthGate";
import { useCurrentUser } from "./auth/CurrentUser";
import { DevToolsSlot } from "./auth/DevToolsSlot";
import { RequireSuperadmin } from "./auth/RequireSuperadmin";
import { AdminLayout } from "./layout/AdminLayout";
import { SidebarLayout } from "./layout/SidebarLayout";
import { AdminConsole } from "./screens/AdminConsole";
import { Dashboard } from "./screens/Dashboard";
import { IssueScreen } from "./screens/IssueScreen";
import { NotFound } from "./screens/NotFound";
import { Roadmap } from "./screens/Roadmap";

/** Superadmin has no organization, so the dashboard has nothing to show them: they land on the console. */
function Home() {
  const me = useCurrentUser();
  if (me.isSuperadmin) return <Navigate to="/admin" replace />;
  return (
    <SidebarLayout>
      <Dashboard />
    </SidebarLayout>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthGate />}>
        <Route path="/" element={<Home />} />
        <Route
          path="/admin"
          element={
            <RequireSuperadmin>
              <AdminLayout>
                <AdminConsole />
              </AdminLayout>
            </RequireSuperadmin>
          }
        />
        <Route path="/consignments/:consignmentId" element={<Roadmap />} />
        <Route path="/issues/:issueId" element={<IssueScreen />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <>
      <AppRoutes />
      <DevToolsSlot />
    </>
  );
}
