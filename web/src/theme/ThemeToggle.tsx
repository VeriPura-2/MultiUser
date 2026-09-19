import { toggleTheme, useTheme } from "./theme";

/**
 * The pill button that switches theme, labelled with what it will switch to, as in the mockups
 * ("Dark mode" while light, "Light mode" while dark). `onNav` styles it for the dark top bar.
 */
export function ThemeToggle({ onNav = false }: { onNav?: boolean }) {
  const theme = useTheme();
  const label = theme === "dark" ? "☀ Light mode" : "● Dark mode";
  return (
    <button
      type="button"
      className={`themebtn${onNav ? " on-nav" : ""}`}
      onClick={toggleTheme}
      aria-label="Toggle dark mode"
      aria-pressed={theme === "dark"}
    >
      {label}
    </button>
  );
}
