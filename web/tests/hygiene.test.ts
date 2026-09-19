import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep-style guards over everything the app ships: web/src and web/index.html. They live here in
 * tests/ rather than in src/ because they must contain the very strings they forbid.
 */

const root = path.resolve(".");
const srcDir = path.join(root, "src");
// Built from its code point so that this file, which the repo also scans, contains none.
const EM_DASH = String.fromCharCode(0x2014);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const TEXT_EXTENSIONS = /\.(ts|tsx|css|html|json|svg|md)$/;
const shipped = [...walk(srcDir), path.join(root, "index.html")].filter((f) => TEXT_EXTENSIONS.test(f));
const rel = (file: string) => path.relative(root, file).replaceAll("\\", "/");
const read = (file: string) => readFileSync(file, "utf8");

/** Files where a hard-coded colour is allowed: the token definitions themselves. */
const isTokenFile = (file: string) => rel(file) === "src/styles/tokens.css";

function offenders(pattern: RegExp, files = shipped): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) found.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  return found;
}

describe("what the app must never contain", () => {
  it("scans a meaningful set of files (so the guards below cannot pass by scanning nothing)", () => {
    expect(shipped.length).toBeGreaterThan(20);
    expect(shipped.some((f) => rel(f) === "src/App.tsx")).toBe(true);
    expect(shipped.some((f) => rel(f) === "index.html")).toBe(true);
  });

  it('has no "Document name TBC" placeholder text', () => {
    expect(offenders(/Document name TBC/i)).toEqual([]);
  });

  it("has no wallet or VERI token panel", () => {
    expect(offenders(/wallet/i)).toEqual([]);
    expect(offenders(/VERI token/i)).toEqual([]);
  });

  it("has no em dash anywhere", () => {
    expect(offenders(new RegExp(EM_DASH))).toEqual([]);
  });

  it("does not present AI extraction, Guardian, forensic, ledger, passport, or IOTA features", () => {
    expect(offenders(/AI-extracted|Guardian Assistant|Forensic view|Trust Verification Ledger|Consignment Passport|IOTA|50\+ agents/i)).toEqual([]);
  });
});

describe("design rules", () => {
  it("uses no hard-coded colour outside tokens.css: every colour comes from a token", () => {
    const files = shipped.filter((f) => /\.(ts|tsx|css|html)$/.test(f) && !isTokenFile(f));
    // #rgb, #rrggbb, #rrggbbaa, and rgb()/rgba()/hsl() functions.
    expect(offenders(/#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgb|rgba|hsl|hsla)\(/, files)).toEqual([]);
  });

  it("uses nothing under 14px", () => {
    const small: string[] = [];
    for (const file of shipped.filter((f) => /\.(css|tsx|ts)$/.test(f))) {
      read(file).split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
          if (Number(m[1]) < 14) small.push(`${rel(file)}:${i + 1}: ${m[0]}`);
        }
        for (const m of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b/g)) {
          if (Number(m[1]) < 14) small.push(`${rel(file)}:${i + 1}: ${m[0]}`);
        }
      });
    }
    expect(small).toEqual([]);
  });

  it("respects prefers-reduced-motion", () => {
    const base = read(path.join(srcDir, "styles/base.css"));
    expect(base).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("gives focusable things a visible focus state", () => {
    expect(read(path.join(srcDir, "styles/base.css"))).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });
});

describe("the guards themselves can fail", () => {
  it("would catch each forbidden thing if it were present", () => {
    // Positive controls: run the same patterns over strings that contain the forbidden content.
    const would = (pattern: RegExp, text: string) => pattern.test(text);
    expect(would(/Document name TBC/i, "<span>Document name TBC</span>")).toBe(true);
    expect(would(/wallet/i, "VERI Wallet")).toBe(true);
    expect(would(new RegExp(EM_DASH), `a ${EM_DASH} b`)).toBe(true);
    expect(would(/#[0-9a-fA-F]{3,8}\b(?![\w-])/, "color: #B8860B;")).toBe(true);
    expect(would(/#[0-9a-fA-F]{3,8}\b(?![\w-])/, "href=\"/#consignments\"")).toBe(false);
    expect(/font-size:\s*(\d+)px/.exec("font-size:12px")?.[1]).toBe("12");
  });
});
