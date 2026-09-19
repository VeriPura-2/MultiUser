/**
 * Which sample user the development build is acting as. Development only: real sign-in does not
 * exist yet, and a production build never reads this (see api/client.ts).
 */

export const DEV_USER_KEY = "vp-dev-user";

export function getDevUserId(): string | null {
  try {
    return localStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
  }
}

export function setDevUserId(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEV_USER_KEY, id);
    else localStorage.removeItem(DEV_USER_KEY);
  } catch {
    // Storage is unavailable, so the choice lasts only until the page reloads.
  }
}
