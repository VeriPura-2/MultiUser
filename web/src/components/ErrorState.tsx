import { ApiError } from "../api/client";
import { Card } from "./Card";

/** Plain-language text for what went wrong. Never shows a stack or a raw status code alone. */
export function describeError(error: unknown): { title: string; detail: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) return { title: "You are not signed in", detail: "Sign in to continue." };
    if (error.status === 403) return { title: "You do not have access", detail: "Your role does not allow this." };
    if (error.status === 404) return { title: "Not found", detail: "It may not exist, or you may not be able to see it." };
    return { title: "Something went wrong", detail: error.message };
  }
  return { title: "Could not reach the server", detail: "Check that the backend is running, then try again." };
}

/** An error, with a retry button when the caller can offer one. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, detail } = describeError(error);
  return (
    <Card className="state error">
      <div role="alert">
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </Card>
  );
}
