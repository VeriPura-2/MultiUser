import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useDevUsers } from "../api/hooks";
import { getDevUserId, setDevUserId } from "./devUser";
import { describeDevUser } from "./describeDevUser";

/**
 * The corner select for trying each role and organization. DEVELOPMENT ONLY: it is imported
 * lazily behind `import.meta.env.DEV` (see DevToolsSlot), so a production build contains none of it.
 */
export default function DevUserSwitcher() {
  const users = useDevUsers();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function choose(id: string) {
    setDevUserId(id || null);
    // Everything cached belongs to the previous user, so drop it and start over from the top.
    void queryClient.resetQueries();
    navigate("/");
  }

  return (
    <div className="dev-switcher" data-testid="dev-user-switcher">
      <label htmlFor="dev-user-select">Acting as</label>
      <select id="dev-user-select" value={getDevUserId() ?? ""} onChange={(e) => choose(e.target.value)}>
        <option value="">Choose a sample user</option>
        {users.data?.map((u) => (
          <option key={u.userId} value={u.userId}>
            {describeDevUser(u)}
          </option>
        ))}
      </select>
    </div>
  );
}
