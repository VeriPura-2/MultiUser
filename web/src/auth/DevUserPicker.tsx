import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useDevUsers } from "../api/hooks";
import { Card } from "../components/Card";
import { ErrorState } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { setDevUserId } from "./devUser";
import { describeDevUser } from "./describeDevUser";
import "./DevUserPicker.css";

/**
 * Shown in development before a sample user has been chosen. DEVELOPMENT ONLY, loaded lazily
 * behind `import.meta.env.DEV` (see AuthGate), so a production build contains none of it.
 */
export default function DevUserPicker() {
  const users = useDevUsers();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function choose(id: string) {
    setDevUserId(id);
    void queryClient.resetQueries();
    navigate("/");
  }

  return (
    <div className="page">
      <div className="page-inner picker">
        <h1 className="display">Choose a sample user</h1>
        <p className="page-sub">
          Real sign-in does not exist yet. In development, pick who to act as. You can switch at any time from the corner.
        </p>
        {users.isLoading ? <LoadingSkeleton lines={4} label="Loading sample users" /> : null}
        {users.isError ? <ErrorState error={users.error} onRetry={() => void users.refetch()} /> : null}
        <div className="picker-list">
          {users.data?.map((u) => (
            <Card key={u.userId} className="picker-item">
              <button type="button" onClick={() => choose(u.userId)}>
                {describeDevUser(u)}
              </button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
