import { lazy, Suspense } from "react";
import { Outlet } from "react-router-dom";
import { ApiError } from "../api/client";
import { useMe } from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { MeContext } from "./CurrentUser";

// Removed from a production build, like the switcher (see DevToolsSlot).
const LazyPicker = import.meta.env.DEV ? lazy(() => import("./DevUserPicker")) : null;

function SignInRequired() {
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <EmptyState title="Sign-in is not available yet">
          This build has no way to sign in. Real sign-in arrives in a later stage.
        </EmptyState>
      </div>
    </div>
  );
}

/**
 * Nothing renders below this until the backend has said who the user is. Not signed in (401): in
 * development you are offered the sample users, and otherwise you are told plainly that sign-in
 * is not available yet. Any other failure is shown with a retry.
 */
export function AuthGate() {
  const me = useMe();

  if (me.isLoading) {
    return (
      <div className="page">
        <div className="page-inner">
          <LoadingSkeleton lines={4} label="Loading" />
        </div>
      </div>
    );
  }

  if (me.isError) {
    const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
    if (unauthenticated && import.meta.env.DEV && LazyPicker) {
      return (
        <Suspense fallback={null}>
          <LazyPicker />
        </Suspense>
      );
    }
    if (unauthenticated) return <SignInRequired />;
    return (
      <div className="page">
        <div className="page-inner" style={{ maxWidth: 560 }}>
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        </div>
      </div>
    );
  }

  if (!me.data) return null; // unreachable once loading and error are handled, but it narrows the type
  return (
    <MeContext.Provider value={me.data}>
      <Outlet />
    </MeContext.Provider>
  );
}
