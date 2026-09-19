import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A real `vite build`, as part of the suite. It proves the app compiles for production and, by
 * comparing against a development build, that the development user switcher and everything that
 * reads a chosen sample user is not in the production bundle.
 *
 * It runs in a child process with NODE_ENV set explicitly. Vite decides "production" from NODE_ENV,
 * and the test runner sets that to "test", so an in-process build would not be a production build.
 */

const root = path.resolve(".");
const viteBin = path.resolve("node_modules/vite/bin/vite.js");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

function buildTo(mode: "production" | "development") {
  const outDir = mkdtempSync(path.join(tmpdir(), `vp-${mode}-`));
  dirs.push(outDir);
  // Default minification, as in a real build: it also removes comments, which would otherwise
  // mention the very names being searched for.
  execFileSync(process.execPath, [viteBin, "build", "--mode", mode, "--outDir", outDir, "--emptyOutDir"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: mode },
    stdio: "pipe",
  });
  const all = files(outDir);
  const js = all.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
  const css = all.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
  return { all, js, css, html: readFileSync(path.join(outDir, "index.html"), "utf8") };
}

/** Text that only the development tooling contains. */
const DEV_MARKERS = ["dev-user-switcher", "x-dev-user", "/dev/users", "vp-dev-user", "Choose a sample user"];

describe("vite build", () => {
  it("compiles for production, with the entry page, scripts, styles, and bundled fonts", () => {
    const { all, html } = buildTo("production");
    expect(html).toContain('<div id="root">');
    expect(all.some((f) => f.endsWith(".js"))).toBe(true);
    expect(all.some((f) => f.endsWith(".css"))).toBe(true);
    expect(all.some((f) => /dm-serif-display.*\.woff2$/.test(f))).toBe(true);
    expect(all.some((f) => /source-serif-4.*\.woff2$/.test(f))).toBe(true);
  }, 180_000);

  it("the production bundle has no dev user switcher, no dev header, and no dev endpoint", () => {
    const { js } = buildTo("production");
    for (const marker of DEV_MARKERS) {
      expect(js.toLowerCase().includes(marker.toLowerCase()), `production bundle contains "${marker}"`).toBe(false);
    }
  }, 180_000);

  it("a development build does contain them, which proves the check above can fail", () => {
    const { js } = buildTo("development");
    for (const marker of DEV_MARKERS) {
      expect(js.toLowerCase().includes(marker.toLowerCase()), `development bundle is missing "${marker}"`).toBe(true);
    }
  }, 180_000);

  it("loads no font or asset from an outside server", () => {
    const { html, css } = buildTo("production");
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(css).not.toMatch(/url\(\s*["']?https?:\/\//);
  }, 180_000);
});
