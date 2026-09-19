#!/usr/bin/env node
// Keeps the project memory from falling behind the code.
//
// Modes
//   --staged  git pre-commit: checks what is about to be committed.
//   --hook    Claude Code Stop hook: checks uncommitted work, answers with a JSON decision.
//   --full    audit: also runs the test suite and checks the facts stated in PROJECT_MEMORY.md.
//   (none)    checks uncommitted work, human-readable.
//
// Rules enforced
//   1. A change to code, tests, migrations, scripts, or config must be accompanied by a change to
//      docs/build-log.md and docs/PROJECT_MEMORY.md.
//   2. docs/build-log.md is append-only: no existing line may be removed or altered.
//   3. No em dashes in added lines of code or docs.
//   4. PROJECT_MEMORY.md stays valid: required sections, a real "Last updated" date (today, when
//      code changed), a "Tests passing" number, and short enough to load every session.
//   5. --full only: the stated test count is the real one, and the memory is not older than the
//      newest commit.
//
// SKIP_MEMORY_CHECK=1 bypasses everything, loudly. For a genuine emergency only.
//
// Hooks can prove the docs were touched and the checkable facts are true. They cannot judge
// whether the prose is complete; the standing rules and /wrapup cover that.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BUILD_LOG = "docs/build-log.md";
const MEMORY = "docs/PROJECT_MEMORY.md";
const MAX_MEMORY_LINES = 250;
const EM_DASH = String.fromCharCode(0x2014);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// A positive list, on purpose: untracked design inputs beside the code (mockups, PDFs) must never
// count as "code changed".
const CODE_PATTERNS = [
  /^src\//,
  /^drizzle\//,
  /^tests\//,
  /^scripts\//,
  /^\.githooks\//,
  /^\.claude\//,
  /^package\.json$/,
  /^docker-compose\.yml$/,
  /^\.env\.example$/,
  /^vitest\.config\.ts$/,
  /^tsconfig\.json$/,
  /^drizzle\.config\.ts$/,
  /^resume\.ps1$/,
  /^CLAUDE\.md$/,
];
const isCode = (file) => CODE_PATTERNS.some((p) => p.test(file));
const isScanned = (file) => isCode(file) || /^docs\//.test(file) || file === "README.md";

const REQUIRED_HEADINGS = [
  "## Standing rules",
  "## Restart and wrap up",
  "## Keeping this file current",
  "## History",
  "## Open items",
  "## Next work",
];

// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const mode = args.has("--staged") ? "staged" : args.has("--hook") ? "hook" : "working";
const full = args.has("--full");

const root = (() => {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : start;
})();

function git(gitArgs, { allowFail = false } = {}) {
  const r = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${gitArgs.join(" ")} failed: ${r.stderr}`);
  return r.status === 0 ? r.stdout : "";
}

const hasHead = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root }).status === 0;
const base = hasHead ? "HEAD" : EMPTY_TREE;
const lines = (text) => text.split("\n").map((l) => l.trimEnd()).filter(Boolean);

/** Files changed in scope. staged: index vs HEAD. Otherwise: work tree vs HEAD plus new untracked files. */
function changedFiles() {
  if (mode === "staged") return lines(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]));
  const tracked = lines(git(["diff", base, "--name-only", "--diff-filter=ACMRD"]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])];
}

function diffText(pathspec) {
  const spec = pathspec ? ["--", pathspec] : [];
  return mode === "staged"
    ? git(["diff", "--cached", "-U0", "--no-color", ...spec])
    : git(["diff", base, "-U0", "--no-color", ...spec]);
}

/** Lines added per file, parsed from a unified diff. */
function addedLines(diff) {
  const out = [];
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && file) out.push({ file, text: line.slice(1) });
  }
  return out;
}

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const today = process.env.MEMORY_CHECK_TODAY || localDate();

// ---------------------------------------------------------------------------

function run() {
  const problems = [];
  const files = changedFiles();
  const codeChanged = files.some(isCode);

  // 1. Code changed, so the memory must have changed too.
  if (codeChanged) {
    const missing = [];
    if (!files.includes(BUILD_LOG)) missing.push(`${BUILD_LOG} (append a dated entry: what changed, decisions made and why, test state)`);
    if (!files.includes(MEMORY)) missing.push(`${MEMORY} (update status, history, open items, "Tests passing", and "Last updated")`);
    if (missing.length > 0) {
      problems.push(
        `Code, tests, migrations, scripts, or config changed (${files.filter(isCode).slice(0, 3).join(", ")}${files.filter(isCode).length > 3 ? ", ..." : ""}) but the project memory was not updated. Update: ${missing.join("; ")}. Run /wrapup, or edit them and stage them.`,
      );
    }
  }

  // 2. The build log is append-only.
  if (files.includes(BUILD_LOG)) {
    const numstat = lines(git(mode === "staged" ? ["diff", "--cached", "--numstat", "--", BUILD_LOG] : ["diff", base, "--numstat", "--", BUILD_LOG]));
    for (const row of numstat) {
      const [, deleted] = row.split("\t");
      if (deleted && deleted !== "-" && Number(deleted) > 0) {
        problems.push(`${BUILD_LOG} is append-only, but ${deleted} existing line(s) were removed or changed. Restore them and record any correction as a new entry.`);
      }
    }
  }

  // 3. No em dashes in added lines of code or docs.
  const added = addedLines(diffText()).filter((l) => isScanned(l.file));
  if (mode !== "staged") {
    // New untracked files never appear in a diff against HEAD, so read them directly.
    for (const file of lines(git(["ls-files", "--others", "--exclude-standard"]))) {
      if (isScanned(file) && /\.(ts|mjs|md|json|sql|ya?ml|ps1|sh)$/.test(file)) {
        for (const text of readFileSync(path.join(root, file), "utf8").split("\n")) added.push({ file, text });
      }
    }
  }
  const offenders = [...new Set(added.filter((l) => l.text.includes(EM_DASH)).map((l) => l.file))];
  if (offenders.length > 0) {
    problems.push(`Em dash found in ${offenders.join(", ")}. This project bans em dashes: use a period, comma, or parentheses.`);
  }

  // 4. The memory file itself is valid. Checked whenever it changes, when code changed, and in --full.
  if (files.includes(MEMORY) || codeChanged || full) {
    problems.push(...checkMemoryFile(codeChanged));
  }

  // 5. Audit-only facts.
  if (full) problems.push(...auditFacts());

  return problems;
}

function memoryText() {
  const p = path.join(root, MEMORY);
  if (mode === "staged") {
    const staged = spawnSync("git", ["show", `:${MEMORY}`], { cwd: root, encoding: "utf8" });
    if (staged.status === 0) return staged.stdout;
  }
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function checkMemoryFile(codeChanged) {
  const problems = [];
  const text = memoryText();
  if (text === null) return [`${MEMORY} is missing.`];

  for (const heading of REQUIRED_HEADINGS) {
    if (!text.split("\n").some((l) => l.startsWith(heading))) problems.push(`${MEMORY} is missing the section "${heading}".`);
  }
  const lineCount = text.replace(/\n$/, "").split("\n").length;
  if (lineCount > MAX_MEMORY_LINES) {
    problems.push(`${MEMORY} is ${lineCount} lines (limit ${MAX_MEMORY_LINES}) and loads into every session. Move detail into ${BUILD_LOG} and keep this file to state, rules, and open items.`);
  }
  const updated = /^Last updated: (\d{4}-\d{2}-\d{2})\s*$/m.exec(text);
  if (!updated) problems.push(`${MEMORY} needs a line "Last updated: YYYY-MM-DD".`);
  else if (codeChanged && updated[1] !== today) {
    problems.push(`${MEMORY} says "Last updated: ${updated[1]}" but code changed today (${today}). Update the date along with the rest of the state.`);
  }
  if (!/^Tests passing: \d+\s*$/m.test(text)) problems.push(`${MEMORY} needs a line "Tests passing: N".`);
  return problems;
}

function auditFacts() {
  const problems = [];
  const text = memoryText() ?? "";

  const stated = /^Tests passing: (\d+)/m.exec(text);
  const actual = actualTestResult();
  if (actual.error) problems.push(`Could not run the test suite to verify the stated count: ${actual.error}`);
  else {
    if (actual.failed > 0) problems.push(`The test suite has ${actual.failed} failing test(s). A stage is not done until the full suite passes.`);
    if (stated && Number(stated[1]) !== actual.passed) {
      problems.push(`${MEMORY} says "Tests passing: ${stated[1]}" but the suite has ${actual.passed} passing. Update it.`);
    }
  }

  const updated = /^Last updated: (\d{4}-\d{2}-\d{2})/m.exec(text);
  const lastCommit = git(["log", "-1", "--format=%cs"], { allowFail: true }).trim();
  if (updated && lastCommit && updated[1] < lastCommit) {
    problems.push(`${MEMORY} was last updated ${updated[1]} but the newest commit is dated ${lastCommit}. The memory is behind the code.`);
  }
  return problems;
}

/** Runs the suite (a test seam lets the unit tests supply a canned result instead). */
function actualTestResult() {
  if (process.env.MEMORY_CHECK_TEST_RESULT) {
    try {
      return JSON.parse(process.env.MEMORY_CHECK_TEST_RESULT);
    } catch {
      return { error: "MEMORY_CHECK_TEST_RESULT is not valid JSON" };
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "memcheck-"));
  const out = path.join(dir, "result.json");
  try {
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const r = spawnSync(cmd, ["vitest", "run", "--reporter=json", `--outputFile=${out}`], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (!existsSync(out)) return { error: `vitest produced no result file (exit ${r.status}): ${(r.stderr || r.stdout || "").slice(0, 300)}` };
    const json = JSON.parse(readFileSync(out, "utf8"));
    return { passed: json.numPassedTests, failed: json.numFailedTests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

function readStdinJson() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

if (process.env.SKIP_MEMORY_CHECK === "1") {
  console.error("memory-check: SKIP_MEMORY_CHECK=1 is set. The project memory is NOT being verified. Update docs/build-log.md and docs/PROJECT_MEMORY.md as soon as possible.");
  process.exit(0);
}

if (mode === "hook") {
  // Claude Code Stop hook. Never block twice in a row for the same stop, or Claude would loop.
  const input = readStdinJson();
  if (input.stop_hook_active) process.exit(0);
  const problems = run();
  if (problems.length > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `The project memory is out of date. Fix this before finishing (run /wrapup if you are wrapping up):\n- ${problems.join("\n- ")}`,
      }),
    );
  }
  process.exit(0);
}

const problems = run();
if (problems.length === 0) {
  if (mode !== "staged") console.log("memory-check: ok");
  process.exit(0);
}
console.error("memory-check: the project memory is out of date.\n");
for (const p of problems) console.error(`  - ${p}`);
console.error("\nFix the above, or set SKIP_MEMORY_CHECK=1 for a genuine emergency (the memory must then be brought up to date straight after).");
process.exit(1);
