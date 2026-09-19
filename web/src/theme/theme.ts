import { useSyncExternalStore } from "react";

/**
 * Light or dark, as a class on <html>. The class is the single source of truth, so every toggle on
 * every screen shows the same label. The choice persists in localStorage under `vp-theme`, and every
 * storage access is wrapped because storage can throw (private windows, blocked site data).
 */

export const THEME_KEY = "vp-theme";
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Applies the saved theme. Called once at startup (the page also does this before first paint). */
export function applySavedTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage is unavailable, so the default (light) stands.
  }
  document.documentElement.classList.toggle("dark", saved === "dark");
  listeners.forEach((l) => l());
}

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not persisted, but the theme still changes for this session.
  }
  listeners.forEach((l) => l());
}

export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "light");
}
