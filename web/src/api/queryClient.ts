import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/**
 * Do not retry an answer the server has already given (401, 403, 404, 400): repeating it changes
 * nothing and only delays the error state. Retry a network failure or a 5xx a couple of times.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 15_000, refetchOnWindowFocus: false },
    },
  });
}
