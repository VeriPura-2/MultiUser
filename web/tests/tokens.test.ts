import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve("src/styles/tokens.css"), "utf8");

/** The declarations inside a top-level rule, as { "--name": "value" }. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector}{`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const end = css.indexOf("}", start);
  const body = css.slice(start + selector.length + 1, end);
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

const light = block(":root");
const dark = block("html.dark");

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe("design tokens", () => {
  it("dark theme uses the specified neutral charcoal values exactly", () => {
    expect(dark["--ivory"]).toBe("#303338");
    expect(dark["--paper"]).toBe("#3B3E44");
    expect(dark["--recess"]).toBe("#454850");
    expect(dark["--charcoal"]).toBe("#EEEFF1");
    expect(dark["--charcoal-soft"]).toBe("#B9BDC4");
    expect(dark["--line"]).toBe("#565A62");
  });

  it("light theme keeps the paper-and-gold values", () => {
    expect(light["--ivory"]).toBe("#FAF9F5");
    expect(light["--paper"]).toBe("#FFFEFA");
    expect(light["--charcoal"]).toBe("#22201A");
    expect(light["--gold"]).toBe("#B8860B");
  });

  it("dark surfaces do not drift toward brown: blue is never below red", () => {
    for (const name of ["--ivory", "--paper", "--recess", "--nav", "--nav-top", "--nav-active", "--map-sea", "--map-land"]) {
      const [r, , b] = rgb(dark[name]!);
      expect(b, `${name} ${dark[name]}`).toBeGreaterThanOrEqual(r);
    }
  });

  it("defines every badge, map, and sidebar token in both themes", () => {
    const required = [
      "--green", "--green-bg", "--gray", "--gray-bg", "--blue", "--blue-bg", "--red", "--red-bg",
      "--purple", "--purple-bg", "--amber", "--amber-bg", "--warn-bg", "--warn-line", "--red-line",
      "--green-tint", "--green-line", "--solid-green", "--solid-red", "--gold", "--gold-deep", "--gold-bg",
      "--nav", "--nav-top", "--nav-ink", "--nav-soft", "--nav-mute", "--nav-active", "--nav-line", "--nav-avatar", "--nav-gold",
      "--map-sea", "--map-land", "--map-land-line",
    ];
    for (const name of required) {
      expect(light[name], `light ${name}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(dark[name], `dark ${name}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("names the two fonts the design uses", () => {
    expect(css).toContain('"DM Serif Display"');
    expect(css).toContain('"Source Serif 4 Variable"');
    expect(css).toMatch(/--font-ui:\s*system-ui/);
  });
});
