# Project memory: VeriPura multi-tenant platform backend

This file is loaded into every Claude session in this repo (via `CLAUDE.md`). It holds the standing
rules, the current state, and the history in one place, so a cold restart needs nothing else.
Related, read on demand: `docs/build-log.md` (detailed, append-only record of every decision),
`docs/BUILD_PROMPTS.md` (Thomas's original backend specification, including Prompt 4, Stripe), and
`docs/veripura-cli-ui-prompts.md` (Thomas's UI build prompts: UI-1 the API surface, UI-2 the web app).

Keep this file short and current. It must stay under about 250 lines because it loads every time.
Update it when the state changes. Do not turn it into a second build log.

Last updated: 2026-09-19
Tests passing: 276
Stages complete: 3 of 3 backend prompts. UI-1 (API surface for the UI) in progress. Prompt 4 (Stripe) not started.

## Standing rules (Thomas's, apply to every session)

Conduct
1. **No em dashes, ever, in any written content.** Code, comments, docs, commit messages, emails. Use a period, comma, or parentheses.
2. **Never view or type live credentials.** If a secret turns up in output, a log, or a file, flag it to Thomas without forcing a rotation. Never enter a password into any browser automation or computer-use flow; hand that step to Thomas.
3. **Confirm before sending, deleting, or changing anything outward-facing.** A request to "handle my emails" or "clear my todo list" authorizes reading, not blind execution. Draft external correspondence first (to Onno Stienen at VeriPura Core, or to clients), using the `my-writing-style` skill if available, and send only on an explicit go-ahead.
4. **Ask before pattern-fixing.** When a gap or bug is found, search the whole app for every other instance of the same pattern (including whether a function fixed once has the same gap elsewhere). Present each instance one at a time: what it is, and the concrete implications of fixing versus leaving it. Wait for an explicit decision on each. Only when every decision in the batch is made, implement the approved fixes, test them, then deploy. Never fix proactively, even when the fix looks obviously right.
5. **Offer explicit choices when a decision is genuinely Thomas's.** Do not guess. This has consistently produced clear direction.
6. **Verify with real evidence.** Read the actual log, the actual file, run the actual test, before reporting a root cause or calling something done or open. Doc labels go stale silently.
7. **Be concise.** Plain prose in conversation, lists only where clearest, lead with the result. State failures and skipped steps plainly.

Engineering
8. **The build log is append-only.** Add a dated entry after each numbered step: what was built, each decision the spec did not settle (and why), and the test state. Correct mistakes with a new entry, never by rewriting.
9. **One commit per numbered step, and stage explicit paths, never `git add -A`.** The message describes that step. Push to `origin` once a commit looks right. At the end of a stage, check `git remote -v`.
10. **The full suite must pass before a stage counts as done.** A failing test blocks progress; it is never skipped or commented out. When adding tests, mutation-check them: break the behavior on purpose and confirm the suite goes red, then restore.
11. **Local sandbox only.** Nothing is deployed and no cloud is provisioned until Thomas decides to.
12. **Schema changes go through generated migrations** (`npm run db:generate`), never ad hoc SQL against the dev database.
13. **Seams, not features.** Billing columns, `external_core_id`, and the wide `org_type` enum exist so later work is an addition, not a migration. Do not build past them without being asked.
14. **Review the diff after each stage before starting the next.**

## What this is

The backend for a multi-tenant compliance platform used by importers, exporters, logistics
providers, labs/certification bodies, and third-party data sources to manage import/export
document compliance for cross-border consignments. Built as a real MVP trial for businesses that
may convert to paying customers, not a throwaway prototype. Pilot lane: Brazil to GB beef.

- Repo: https://github.com/VeriPura-2/MultiUser (branch `main`). Local folder: `Veripura/Control Tower`.
- Stack: TypeScript, Node 22+, Postgres 17 (Docker), Drizzle ORM, Fastify 5, Vitest.
- Sibling project: the Columbia Wireless tower demo at `Veripura/Wireless/tower-management-demo` (separate repo, separate rules).

## Restart and wrap up

- Start: open a terminal in this folder and run `claude`, then `/pickup`. From anywhere, if the `veripura` PowerShell command is installed, just type `veripura`.
- `/pickup` reads this file and the spec, checks git and the sandbox, runs the tests, and reports state, drift, open items, and a recommended next step. It changes nothing except starting the sandbox.
- `/wrapup` before stopping: appends the build log, updates this file, runs the suite, commits explicit paths, pushes, and verifies local equals remote.

## Keeping this file current (enforced, not just requested)

- **Git pre-commit hook** (`.githooks/`, enabled by `npm install`): a commit that touches code, tests, migrations, scripts, or config is blocked unless `docs/build-log.md` and this file are also staged. It also blocks edits or deletions of existing build-log lines and blocks em dashes. Override only in a real emergency with `SKIP_MEMORY_CHECK=1`.
- **Claude Code Stop hook** (`.claude/settings.json`): if there are uncommitted code changes with no doc updates, Claude is stopped from finishing until memory is updated.
- `npm run memory:check -- --full` audits the checkable facts (the test count above, the date above, required sections).
- The hooks prove the docs were touched and the facts are true. They cannot judge whether the prose is complete; rules 8 and this section are how that is covered.
- Claude's own auto-memory holds only thin pointers to this file. This file is the single source of truth.

## Run it

```powershell
npm install          # also enables the git hooks
Copy-Item .env.example .env
npm run db:up        # Postgres on localhost:5433 (5432 is taken on this machine)
npm run db:migrate
npm test             # needs the sandbox up; uses a separate veripura_test database
npm run dev          # http://127.0.0.1:3000
```

## Map

- `src/db/schema.ts`, `drizzle/`: schema and generated SQL migrations (source of truth).
- `src/permissions/engine.ts`: `resolveDocumentPermissions`, `createPermissionResolver` (bulk, one shared implementation), `canManageOrgUsers`, `canConfigureVisibilityRules`.
- `src/audit/recordAudit.ts`: called in the same transaction as every mutation.
- `src/services/`: lifecycle, consignments, checklist, issues, and `consignmentViews.ts` (the three read models).
- `src/core/`: VeriPura core contract (client interface, stub and live, HMAC signing, send).
- `src/http/`: thin Fastify layer. `tests/`: Vitest suite. `scripts/`: seed and memory check.

## Invariants worth not breaking

- Every mutating service function calls `recordAudit` in the same transaction. A missing call is a bug.
- Edit, download, and approve are only ever true when the view level is `full`. Enforced by a database CHECK and again in the merge.
- Superadmin means `organization_id === null`, checked with strict `===`, never `== null`.
- Anything shown to a user passes through the permission engine. Hidden items are omitted, `status_only` items show status only, issue detail and issue counts use full-view items only.
- A non-party asking about a consignment gets the same 404 as for a missing one.
- The inbound webhook verifies an HMAC over the raw bytes before parsing anything, and refuses everything if no secret is configured. No bypass.
- Never write `eq(a) && eq(b)` in a query. Use `and(...)`. TypeScript cannot catch it.

## History (details in docs/build-log.md)

All dates 2026-09-19. Hashes are the pushed ones (history was corrected twice before the first push, so any hash from an earlier note is stale).

| Milestone | What it delivered | Final commit |
|---|---|---|
| Stage 1: foundation | Schema, permission engine, audit helper, org and user lifecycle, 56 tests | `4e32444` |
| Stage 2: PO intake | Consignments, POs, checklist, issues, VeriPura core contract (stub and live), signed inbound webhook, 133 tests | `155427e` |
| First push | History corrected (two design docs removed) and re-authored to the GitHub noreply address before the first push to `origin` | `3efd9d3` |
| Stage 3: role-scoped views | Checklist per consignment, consignment list, workload by counterparty, 170 tests | `8467261` |
| Project memory, step 1 | `CLAUDE.md`, this file restructured, `BUILD_PROMPTS.md` (the original spec) | `0ec6e2e` |
| Project memory, step 2 | The enforcement: `scripts/memory-check.mjs`, the git pre-commit hook, the Claude Code Stop hook, 36 tests of the enforcement itself (206 total) | `74bbb58` |
| Project memory, step 3 | `/pickup` and `/wrapup` commands, `resume.ps1`, the `veripura` PowerShell command, README section, thin auto-memory pointers | `c5aae93` |
| UI-1: API surface for the UI (in progress) | Step 1: `AUTH_MODE=dev` and `X-Dev-User`, `GET /me`, dev-only `GET /dev/users`, production refuses to start with the dev actor on. Step 2: `npm run seed:dev` sample data. Step 3: `GET /consignments/:id`. Step 4: `GET /action-queue`. Step 5: issue detail and the three issue action endpoints (276 tests total) | see `git log` |

Key decisions (full reasoning in the build log): 404 not 403 for non-parties; a bulk permission
resolver shared with `resolveDocumentPermissions`; hidden source documents are not named in
issues; workload counts cover active consignments only; issues counted per item; superadmin must
pass `?orgId=` for workload; the stub core client returns its checklist synchronously and both
paths share `applyChecklist`; a failed core send keeps the PO and is retryable.

## Open items

- **Decision for Thomas: invented document categories.** The older `npm run db:seed` gives the four stub document types the categories "Customs & logistics" and "Certifications", which nobody confirmed. UI-1 says to invent none, and UI-2 groups the roadmap by category, so on a database seeded with `db:seed` the UI would show those as real. `seed:dev` leaves existing rows alone. To follow UI-1 exactly: null the categories in the dev database and drop them from `scripts/seed.ts`.
- **Real sign-in** replaces the `X-Acting-User-Id` dev header (off by default). Fail closed for deactivated users and suspended orgs belongs there.
- **Core contract is unconfirmed** with Onno's team (outbound signing, response shape, callback payload). Live mode has only been exercised against a fake `fetch`. No automatic retry when core is down.
- **Issue service functions ignore document visibility.** The new HTTP endpoints (`/issues/...`, `.../checklist/:itemId/issues`) gate on "party to the consignment AND full view of the parent document" (`src/services/issueViews.ts`), so the API is safe. But `raiseIssue`, `requestCorrection`, and `resolveIssue` themselves still check only the party org, so any new caller must apply that gate. Also tighten issue authority to a specific role when validation exists.
- `canEdit`, `canDownload`, `canApprove` are returned but not enforced anywhere yet (no upload, download, or approval exists).
- `audit_log` is append-only by convention, not by database constraint. Add a trigger before real customer data lands.
- Nothing stops the last Organization Admin deactivating themselves.
- The default permission matrix is unseeded. Seed it from the pilot Scope of Work Section 7 with grants left false.
- The consignment list is not paginated.
- `npm audit`: 4 moderate findings in drizzle-kit's dev-only transitive esbuild. The suggested fix is a breaking downgrade, so it is left alone.

## Next work

1. **UI-1** (the API surface the screens need) then **UI-2** (the React web app), from
   `docs/veripura-cli-ui-prompts.md`. UI-1 is the immediate next stage. Note UI-1 names its dev
   actor mechanism `AUTH_MODE=dev` with an `X-Dev-User` header, while the code today uses
   `ALLOW_DEV_ACTOR_HEADER` with `X-Acting-User-Id`. Reconcile deliberately and record it.
2. Prompt 4 (Stripe billing): create a customer on org approval, a checkout and subscription
   flow, a webhook keeping `billing_status` in sync, and deliberately no access enforcement yet.
   Columns already exist. Description in `docs/BUILD_PROMPTS.md`, notes section.
3. Real sign-in (Google Sign-In was the direction).

## Gotchas

- **Git identity:** GitHub blocks pushes whose commits use the personal Gmail (GH007). This repo sets a local noreply email; a fresh clone needs the same local setting.
- Two design documents live beside the code and are not part of the repo (gitignored). `git add -A` once committed them by accident. Stage explicit paths.
- Do not run `git filter-branch` without checking the working tree afterward. It deletes files that stop being tracked.
- Thomas's UI design inputs sit untracked in the repo folder: `UI Mockup/` and `docs/ui-mockups/` (HTML and PNG mockups of the dashboard, roadmap, issue, intake, and superadmin approval screens). UI-2 reads `docs/ui-mockups/v2-revised/`. They are design inputs, not code. Do not commit them unless Thomas says so. The memory check deliberately ignores them.
- Running a nested `claude -p` in this folder while the tree has uncommitted code and no doc updates triggers the Stop hook, which forces that session into a `/wrapup` attempt and replaces its answer. Commit first, then test cold starts.
- The memory check on this project takes about a second per commit, and its test file about 45 seconds because it builds throwaway git repos. That is expected.
- Tests truncate every table. The runner refuses to start unless the database name ends in `_test`.
- Claude's own memory is keyed by working directory, so only files in this repo reliably carry over. That is why this file exists.
