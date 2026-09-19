import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";

export function NotFound() {
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <EmptyState title="Page not found">
          There is nothing at this address. <Link to="/">Back to the dashboard</Link>
        </EmptyState>
      </div>
    </div>
  );
}
