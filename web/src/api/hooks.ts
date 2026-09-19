import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { DevUser, Me } from "./types";

/** Query keys in one place, so a mutation can invalidate exactly what it changed. */
export const keys = {
  me: ["me"] as const,
  devUsers: ["dev-users"] as const,
};

/** Who the app is acting as. Every screen keys off this, so it is fetched once and cached. */
export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/me") });
}

/** The sample users behind the development switcher. Development only. */
export function useDevUsers() {
  return useQuery({ queryKey: keys.devUsers, queryFn: () => api.get<{ users: DevUser[] }>("/dev/users").then((r) => r.users) });
}
