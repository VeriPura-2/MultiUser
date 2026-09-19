import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { applySavedTheme, getTheme, THEME_KEY } from "../src/theme/theme";
import { ThemeToggle } from "../src/theme/ThemeToggle";

const html = () => document.documentElement;

describe("theme toggle", () => {
  it("starts light, labelled with what it will switch to", () => {
    render(<ThemeToggle />);
    expect(html()).not.toHaveClass("dark");
    expect(screen.getByRole("button", { name: /toggle dark mode/i })).toHaveTextContent("● Dark mode");
  });

  it("adds the dark class on <html> when toggled, updates its label, and persists under vp-theme", async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /toggle dark mode/i });

    await userEvent.click(button);
    expect(html()).toHaveClass("dark");
    expect(button).toHaveTextContent("☀ Light mode");
    expect(localStorage.getItem("vp-theme")).toBe("dark");
    expect(THEME_KEY).toBe("vp-theme");
  });

  it("removes the dark class when toggled back, and persists light", async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /toggle dark mode/i });

    await userEvent.click(button);
    await userEvent.click(button);
    expect(html()).not.toHaveClass("dark");
    expect(button).toHaveTextContent("● Dark mode");
    expect(localStorage.getItem("vp-theme")).toBe("light");
  });

  it("restores the saved theme at startup", () => {
    localStorage.setItem("vp-theme", "dark");
    applySavedTheme();
    expect(html()).toHaveClass("dark");
    expect(getTheme()).toBe("dark");

    localStorage.setItem("vp-theme", "light");
    applySavedTheme();
    expect(html()).not.toHaveClass("dark");
  });

  it("falls back to light for an unrecognised saved value", () => {
    localStorage.setItem("vp-theme", "purple");
    applySavedTheme();
    expect(html()).not.toHaveClass("dark");
  });

  it("keeps working when storage throws: the theme still changes for the session", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => applySavedTheme()).not.toThrow();

    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button", { name: /toggle dark mode/i }));
    expect(html()).toHaveClass("dark");
  });

  it("keeps every toggle on the page in step", async () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle onNav />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: /toggle dark mode/i });
    await userEvent.click(first!);
    expect(second).toHaveTextContent("☀ Light mode");
    await act(async () => {
      await userEvent.click(second!);
    });
    expect(first).toHaveTextContent("● Dark mode");
  });

  it("marks the pressed state for assistive technology", async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /toggle dark mode/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});
