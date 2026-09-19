import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Proves the memory enforcement (scripts/memory-check.mjs) in throwaway git repositories, so the
 * rule that keeps the project memory current cannot silently stop working.
 */

const SCRIPT = path.resolve("scripts/memory-check.mjs");
const EM = String.fromCharCode(0x2014); // built from its code point so this file has none
const TODAY = "2026-01-15";

const VALID_MEMORY = [
  "# Project memory",
  `Last updated: ${TODAY}`,
  "Tests passing: 10",
  "## Standing rules",
  "## Restart and wrap up",
  "## Keeping this file current",
  "## History",
  "## Open items",
  "## Next work",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Commits in these repos are dated 2026-01-15 unless a test says otherwise, so date checks are deterministic. */
const COMMIT_DATE = `${TODAY}T12:00:00`;

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository with valid docs and one source file, committed. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "memcheck-test-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.test");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  write("docs/build-log.md", "# Build log\n\n## Entry one\nFirst.\n");
  write("docs/PROJECT_MEMORY.md", VALID_MEMORY);
  write("src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return {
    dir,
    write,
    append: (rel: string, text: string) => appendFileSync(path.join(dir, rel), text),
    stage: (...paths: string[]) => git(dir, "add", "--", ...paths),
    /** Touch both docs the legitimate way: append to the log, bump the memory. */
    updateDocs: () => {
      appendFileSync(path.join(dir, "docs/build-log.md"), "\n## Entry two\nSecond.\n");
      writeFileSync(path.join(dir, "docs/PROJECT_MEMORY.md"), VALID_MEMORY.replace("Tests passing: 10", "Tests passing: 11"));
    },
  };
}

function check(dir: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_CHECK_TODAY: TODAY, CLAUDE_PROJECT_DIR: dir, ...opts.env };
  if (!opts.env || !("SKIP_MEMORY_CHECK" in opts.env)) delete env.SKIP_MEMORY_CHECK;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: "utf8", input: opts.input ?? "" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

describe("pre-commit (--staged)", () => {
  it("blocks a code change with no doc updates, and names both files", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.stage("src/a.ts");
    const res = check(r.dir, ["--staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("docs/build-log.md");
    expect(res.out).toContain("docs/PROJECT_MEMORY.md");
  });

  it("blocks when only one of the two docs is updated, naming the missing one", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.append("docs/build-log.md", "\n## Entry two\nSecond.\n");
    r.stage("src/a.ts", "docs/build-log.md");
    const res = check(r.dir, ["--staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("docs/PROJECT_MEMORY.md");
    expect(res.out).not.toMatch(/Update: docs\/build-log\.md/);
  });

  it("passes when the code change comes with both docs", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.updateDocs();
    r.stage("src/a.ts", "docs/build-log.md", "docs/PROJECT_MEMORY.md");
    expect(check(r.dir, ["--staged"]).code).toBe(0);
  });

  it.each([
    ["a migration", "drizzle/0002_x.sql", "select 1;\n"],
    ["a test", "tests/x.test.ts", "export {};\n"],
    ["a script", "scripts/x.mjs", "export {};\n"],
    ["package.json", "package.json", "{}\n"],
    ["a claude command", ".claude/commands/x.md", "x\n"],
    ["a git hook", ".githooks/pre-commit", "#!/bin/sh\n"],
    ["web app source", "web/src/App.tsx", "export {};\n"],
    ["a web test", "web/tests/x.test.ts", "export {};\n"],
    ["the web package file", "web/package.json", "{}\n"],
  ])("treats %s as code that needs the docs", (_label, file, content) => {
    const r = makeRepo();
    r.write(file, content);
    r.stage(file);
    expect(check(r.dir, ["--staged"]).code).toBe(1);
  });

  it("lets a docs-only commit through", () => {
    const r = makeRepo();
    r.append("docs/build-log.md", "\n## Entry two\nSecond.\n");
    r.write("README.md", "# Readme\n");
    r.stage("docs/build-log.md", "README.md");
    expect(check(r.dir, ["--staged"]).code).toBe(0);
  });

  it("does not treat unrelated files (design inputs, lockfile) as code", () => {
    const r = makeRepo();
    r.write("UI Mockup/Dashboard.html", `<p>a ${EM} b</p>`);
    r.write("package-lock.json", "{}\n");
    r.stage("UI Mockup/Dashboard.html", "package-lock.json");
    expect(check(r.dir, ["--staged"]).code).toBe(0);
  });

  it("enforces that the build log is append-only", () => {
    const r = makeRepo();
    r.write("docs/build-log.md", "# Build log\n\n## Entry one\nREWRITTEN.\n\n## Entry two\nSecond.\n");
    r.stage("docs/build-log.md");
    const res = check(r.dir, ["--staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("append-only");
  });

  it("blocks removing a build log line, but allows a pure append", () => {
    const r = makeRepo();
    r.write("docs/build-log.md", "# Build log\n\n## Entry one\n");
    r.stage("docs/build-log.md");
    expect(check(r.dir, ["--staged"]).code).toBe(1);

    const r2 = makeRepo();
    r2.append("docs/build-log.md", "\nMore.\n");
    r2.stage("docs/build-log.md");
    expect(check(r2.dir, ["--staged"]).code).toBe(0);
  });

  it("blocks an em dash in an added line of code or docs, but ignores em dashes in other files", () => {
    const r = makeRepo();
    r.append("docs/build-log.md", `\n## Entry two\nA ${EM} B.\n`);
    r.stage("docs/build-log.md");
    const res = check(r.dir, ["--staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("Em dash");

    const r2 = makeRepo();
    r2.write("src/a.ts", `// note ${EM} here\n`);
    r2.updateDocs();
    r2.stage("src/a.ts", "docs/build-log.md", "docs/PROJECT_MEMORY.md");
    expect(check(r2.dir, ["--staged"]).code).toBe(1);
  });

  it("does not re-flag an em dash that was already committed", () => {
    const r = makeRepo();
    r.write("docs/legacy.md", `old ${EM} text\n`);
    r.stage("docs/legacy.md");
    git(r.dir, "commit", "-q", "--no-verify", "-m", "legacy");
    r.append("docs/build-log.md", "\n## Entry two\nSecond.\n");
    r.stage("docs/build-log.md");
    expect(check(r.dir, ["--staged"]).code).toBe(0);
  });

  it("requires the memory's 'Last updated' to be today when code changes", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.append("docs/build-log.md", "\n## Entry two\nSecond.\n");
    r.write("docs/PROJECT_MEMORY.md", VALID_MEMORY.replace(TODAY, "2025-12-31"));
    r.stage("src/a.ts", "docs/build-log.md", "docs/PROJECT_MEMORY.md");
    const res = check(r.dir, ["--staged"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("Last updated: 2025-12-31");
  });

  it("keeps the memory file valid: sections, date, test count, and length", () => {
    const cases: [string, string, RegExp][] = [
      ["a missing section", VALID_MEMORY.replace("## Open items\n", ""), /missing the section "## Open items"/],
      ["a missing date line", VALID_MEMORY.replace(`Last updated: ${TODAY}\n`, ""), /Last updated: YYYY-MM-DD/],
      ["a missing test count", VALID_MEMORY.replace("Tests passing: 10\n", ""), /Tests passing: N/],
      ["too many lines", VALID_MEMORY + "filler\n".repeat(260), /limit 250/],
    ];
    for (const [label, memory, message] of cases) {
      const r = makeRepo();
      r.write("docs/PROJECT_MEMORY.md", memory);
      r.stage("docs/PROJECT_MEMORY.md");
      const res = check(r.dir, ["--staged"]);
      expect(res.code, label).toBe(1);
      expect(res.out, label).toMatch(message);
    }
  });

  it("can be bypassed with SKIP_MEMORY_CHECK=1, loudly", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.stage("src/a.ts");
    const res = check(r.dir, ["--staged"], { env: { SKIP_MEMORY_CHECK: "1" } });
    expect(res.code).toBe(0);
    expect(res.out).toContain("NOT being verified");
  });

  it("works on the very first commit of a repository (no HEAD yet)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memcheck-test-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "docs/build-log.md"), "# Build log\n");
    writeFileSync(path.join(dir, "docs/PROJECT_MEMORY.md"), VALID_MEMORY);
    writeFileSync(path.join(dir, "src/a.ts"), "export {};\n");
    git(dir, "add", "-A");
    expect(check(dir, ["--staged"]).code).toBe(0);
  });
});

describe("Stop hook (--hook)", () => {
  it("blocks with a JSON decision when there are uncommitted code changes and no doc updates", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n"); // not even staged: uncommitted is enough
    const res = check(r.dir, ["--hook"], { input: JSON.stringify({ stop_hook_active: false }) });
    expect(res.code).toBe(0);
    const decision = JSON.parse(res.stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("docs/PROJECT_MEMORY.md");
  });

  it("does not block a second time for the same stop (prevents an endless loop)", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    const res = check(r.dir, ["--hook"], { input: JSON.stringify({ stop_hook_active: true }) });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("stays silent when the tree is clean or only docs changed", () => {
    const r = makeRepo();
    expect(check(r.dir, ["--hook"]).stdout).toBe("");
    r.append("docs/build-log.md", "\n## Entry two\nSecond.\n");
    expect(check(r.dir, ["--hook"]).stdout).toBe("");
  });

  it("stays silent once both docs are updated alongside the code", () => {
    const r = makeRepo();
    r.write("src/a.ts", "export const a = 2;\n");
    r.updateDocs();
    expect(check(r.dir, ["--hook"]).stdout).toBe("");
  });

  it("notices a brand-new untracked source file, but ignores untracked design inputs", () => {
    const r = makeRepo();
    r.write("UI Mockup/Dashboard.html", `<p>${EM}</p>`);
    r.write("Design.pdf", "not text");
    expect(check(r.dir, ["--hook"]).stdout).toBe("");

    r.write("src/new.ts", "export const n = 1;\n");
    expect(JSON.parse(check(r.dir, ["--hook"]).stdout).decision).toBe("block");
  });

  it("catches an em dash in a new untracked docs file", () => {
    const r = makeRepo();
    r.write("docs/new.md", `text ${EM} text\n`);
    expect(JSON.parse(check(r.dir, ["--hook"]).stdout).reason).toContain("Em dash");
  });

  it("blocks an edit to existing build log lines in the working tree", () => {
    const r = makeRepo();
    r.write("docs/build-log.md", "# Build log\n\n## Entry one\nEDITED.\n");
    expect(JSON.parse(check(r.dir, ["--hook"]).stdout).reason).toContain("append-only");
  });
});

describe("audit (--full)", () => {
  const ok = (passed: number, failed = 0) => ({ MEMORY_CHECK_TEST_RESULT: JSON.stringify({ passed, failed }) });

  it("passes when the stated test count is the real one", () => {
    const r = makeRepo();
    expect(check(r.dir, ["--full"], { env: ok(10) }).code).toBe(0);
  });

  it("fails when the memory states a different test count than the suite has", () => {
    const r = makeRepo();
    const res = check(r.dir, ["--full"], { env: ok(12) });
    expect(res.code).toBe(1);
    expect(res.out).toContain('"Tests passing: 10" but the suite has 12');
  });

  it("fails when any test is failing", () => {
    const r = makeRepo();
    const res = check(r.dir, ["--full"], { env: ok(9, 1) });
    expect(res.code).toBe(1);
    expect(res.out).toContain("1 failing");
  });

  it("fails when the memory is older than the newest commit", () => {
    const r = makeRepo();
    r.write("docs/later.md", "later\n");
    r.stage("docs/later.md");
    const later = spawnSync("git", ["commit", "-q", "-m", "later"], {
      cwd: r.dir,
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-02-01T12:00:00", GIT_COMMITTER_DATE: "2026-02-01T12:00:00" },
    });
    expect(later.status).toBe(0);
    const res = check(r.dir, ["--full"], { env: ok(10) });
    expect(res.code).toBe(1);
    expect(res.out).toContain("memory is behind the code");
  });

  it("reports a suite that cannot be run instead of passing silently", () => {
    const r = makeRepo();
    const res = check(r.dir, ["--full"], { env: { MEMORY_CHECK_TEST_RESULT: "not json" } });
    expect(res.code).toBe(1);
    expect(res.out).toContain("not valid JSON");
  });
});

describe("the real repository is wired up", () => {
  const read = (rel: string) => readFileSync(path.resolve(rel), "utf8");

  it("has a pre-commit hook that runs the check, with LF endings enforced", () => {
    expect(read(".githooks/pre-commit")).toContain("memory-check.mjs --staged");
    expect(read(".gitattributes")).toContain(".githooks/* text eol=lf");
  });

  it("enables the hooks on npm install and exposes memory:check", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts.prepare).toContain("core.hooksPath .githooks");
    expect(scripts["memory:check"]).toBe("node scripts/memory-check.mjs");
  });

  it("registers the Claude Code Stop hook", () => {
    const settings = JSON.parse(read(".claude/settings.json"));
    const command = settings.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("memory-check.mjs");
    expect(command).toContain("--hook");
  });

  it("CLAUDE.md loads the project memory", () => {
    expect(read("CLAUDE.md")).toMatch(/^@docs\/PROJECT_MEMORY\.md/m);
  });

  it("the real PROJECT_MEMORY.md is structurally valid, short enough, and free of em dashes", () => {
    const memory = read("docs/PROJECT_MEMORY.md");
    for (const heading of [
      "## Standing rules",
      "## Restart and wrap up",
      "## Keeping this file current",
      "## History",
      "## Open items",
      "## Next work",
    ]) {
      expect(memory, heading).toContain(heading);
    }
    expect(memory).toMatch(/^Last updated: \d{4}-\d{2}-\d{2}$/m);
    expect(memory).toMatch(/^Tests passing: \d+$/m);
    expect(memory.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(250);
    for (const rel of ["docs/PROJECT_MEMORY.md", "docs/BUILD_PROMPTS.md", "CLAUDE.md", "README.md"]) {
      expect(read(rel).includes(EM), `${rel} contains an em dash`).toBe(false);
    }
  });
});
