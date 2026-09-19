import { createContext, useContext } from "react";
import type { Me } from "../api/types";

export const MeContext = createContext<Me | null>(null);

/** The signed-in user. Only valid below AuthGate, which renders nothing until a user is known. */
export function useCurrentUser(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useCurrentUser was used outside AuthGate");
  return me;
}
