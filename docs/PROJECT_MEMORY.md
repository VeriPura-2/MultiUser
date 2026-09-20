# Project memory: VeriPura multi-tenant platform backend

This file is loaded into every Claude session in this repo (via `CLAUDE.md`). It holds the standing
rules, the current state, and the history in one place, so a cold restart needs nothing else.
Related, read on demand: `docs/build-log.md` (detailed, append-only record of every decision),
`docs/BUILD_PROMPTS.md` (Thomas's original backend specification, including Prompt 4, Stripe), and
`docs/veripura-cli-ui-prompts.md` (Thomas's UI build prompts: UI-1 the API surface, UI-2 the web app).

Keep this file short and current. It must stay under about 250 lines because it loads every time.
Update it when the state changes. Do not turn it into a second build log.

Last updated: 2026-09-20
Tests passing: 825
Stages complete: 3 of 3 backend prompts, and UI-1 (API surface for the UI). UI-2 (the web app) complete (all seven steps). UI-3 (vessel tracking) complete (all five steps). Prompt 4 (Stripe) not started.

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
- Stack: TypeScript, Node 22+, Postgres 17 (Docker), Drizzle ORM, Fastify 5 (with @fastify/multipart), Vitest. The web app in `web/` is React 19, Vite, React Router, and TanStack Query, with its own package and tests.
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
npm run dev          # the backend, http://127.0.0.1:3100 (3000 is taken by Next.js dev servers on this machine)
npm run web:install  # once, installs web/
npm run web:dev      # the web app, http://localhost:5173
npm run test:all     # backend suite, then the web suite
```

## Map

- `src/db/schema.ts`, `drizzle/`: schema and generated SQL migrations (source of truth).
- `src/permissions/engine.ts`: `resolveDocumentPermissions`, `createPermissionResolver` (bulk, one shared implementation), `canManageOrgUsers`, `canConfigureVisibilityRules`.
- `src/audit/recordAudit.ts`: called in the same transaction as every mutation.
- `src/services/`: lifecycle, consignments, checklist, issues, and `consignmentViews.ts` (the three read models).
- `src/core/`: VeriPura core contract (client interface, stub and live, HMAC signing, send).
- `src/http/`: thin Fastify layer. `tests/`: Vitest suite. `scripts/`: seed and memory check.
- `web/`: the web app. `web/src/styles/tokens.css` holds every colour (extracted from the mockups, no hard-coded colours elsewhere). `web/src/api/` is the client and types (copied by hand from the backend's read models). `web/tests/` holds the tests, including a real production build.

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
| UI-2: the web app (complete) | Step 1: app shell, tokens, theme, fonts, shared components, API client, dev user switcher, auth gate (66 web tests). Step 2: dashboard (stats, attention band, action queue, consignment list, Leaflet map on sample positions), plus `originCountry`/`destinationCountry` on `GET /consignments` (458 tests total). Step 3: roadmap at `/consignments/:id` (grouped by API category, buttons from the permission flags), plus `issueId` on a checklist item's open issue (487 tests total). Step 4: issue screen with request-correction and resolve dialogs (520 tests total). Step 5: intake (purchase order upload, exporter and country selects, handles the saved-but-502 case) and the dashboard's New Consignment link (547 tests total). Step 6: superadmin org approval (queue, detail, permission table from the API, confirm dialogs) (574 tests total). Step 7: coverage against the prompt's list, the hidden-item test, and a real-browser comparison of every screen in both themes (575 tests total) | see `git log` |
| UI-3: vessel tracking (complete) | Step 1: vessel identifiers on consignments (IMO check digit, MMSI, name; 422 on bad values), `PATCH /consignments/:id/vessel` with an audit row, `vessel_positions` table (608 tests total). Step 2: position provider interface, sample and VesselAPI providers, the call-budget ledger, the refresh job, ingestion and pruning, `POST /admin/positions/refresh` (719 tests total). Step 3: `GET /positions`, `GET /consignments/:id/position` (freshness, sample flag, 24-hour trail), `GET /admin/tracking/budget`; reads never reach a provider (765 tests total). Step 4: the dashboard map fed by `GET /positions` (freshness markers, trails, flags, no planned route), vessel on the roadmap header and the intake form, identifier-rule parity test (820 tests total). Step 5: the no-network guard in both suites, `docs/tracking.md` (823 tests total) | see `git log` |
| UI-1: API surface for the UI | All eight items: `AUTH_MODE=dev` and `GET /me`, `npm run seed:dev`, consignment detail, action queue, issue detail and actions, org directory and superadmin approval, multipart `POST /consignments`, and an end-to-end journey test (324 tests total). Verified against the real server on port 3100. | see `git log` |

Key decisions (full reasoning in the build log): 404 not 403 for non-parties; a bulk permission
resolver shared with `resolveDocumentPermissions`; hidden source documents are not named in
issues; workload counts cover active consignments only; issues counted per item; superadmin must
pass `?orgId=` for workload; the stub core client returns its checklist synchronously and both
paths share `applyChecklist`; a failed core send keeps the PO and is retryable.

## Open items

- **Decisions for Thomas (UI-3 step 2).** (1) The reserve: DECIDED 2026-09-20, keep as built: an automatic call may never use it, a manual call may, nothing passes the monthly budget. (2) Who may set a vessel: DECIDED 2026-09-20, importer and exporter (and superadmin). Freight forwarders are deferred: they are linked to no consignment, so they cannot see one; giving them access needs a designed way to attach a forwarder to a consignment, a stage of its own. (3) VesselAPI's documentation does not say whether one batch call counts as one call or one per vessel, what the batch endpoint returns per vessel, or its maximum ids per call, and no terms of service or commercial-use statement was found; nothing live has been run. Before first use, make one manual refresh and compare VesselAPI's own usage counter with the ledger. Details in the build log's UI-3 step 2 entry.
- **Decision for Thomas: the map's tile provider.** CARTO's own server now answers the spec'd tile URLs (`rastertiles/voyager` and `dark_all`) with tiles watermarked "API KEY REQUIRED carto.com/basemaps/apikey" (HTTP 200; fetched directly and seen in the browser, both themes). It is the provider, not the app. The offline land fallback sits underneath and is hidden by the watermarked tiles. Options: get a CARTO key, switch provider (all provider details are in `web/src/map/tiles.ts`, one file), or show only the bundled land map with no tiles. Not changed, because the spec says no paid key and the choice is yours.
- **Mutation checks are incomplete for steps 2 and 5.** Step 2: the system stopped the run for low memory after about 15 of 28 mutants and the results were not kept; step 5: it stopped after 31 of 33 (all caught) and 3 were not run; one mutant (the attention band's zero guard) was left in place and has been restored, and the suite is green. Re-run it when memory allows (the mutant list is described in the build log entry).
- **Decision for Thomas: `POST /purchase-orders` returns 500 for a malformed `exporterOrgId`.** Found while building UI-1 step 6, where the same mistake (a malformed id reaching Postgres) was fixed in new code. Existing routes were probed: the checklist, consignment detail, issue, workload, and admin routes all return a clean 404 or 400. Only this stage 2 route does not, because `submitPurchaseOrder` runs an unvalidated id through a query. The fix is small (validate ids in `submitPurchaseOrder`, giving a 400) and changes only that route's status from 500 to 400. Not changed, per the ask-before-pattern-fix rule. The new `POST /consignments` endpoint validates its ids.
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

1. **UI-2 and UI-3 are complete.** Vessel tracking, its call budget, its env variables and what must be decided before live data reaches customers are in `docs/tracking.md`. Nothing live has ever been called (no key in the sandbox); the sample provider is the default. Before customers: the decisions in Open items, and the tile provider.
2. Prompt 4 (Stripe billing): create a customer on org approval, a checkout and subscription
   flow, a webhook keeping `billing_status` in sync, and deliberately no access enforcement yet.
   Columns already exist. Description in `docs/BUILD_PROMPTS.md`, notes section.
3. Real sign-in (Google Sign-In was the direction).

## Gotchas

- The sandbox database holds two pending sample organizations, "Sample Applicant Exporter (visual check)" and "Sample Applicant Lab (visual check)", created 2026-09-19 to give the superadmin screen something to show. Approve, reject or leave them; they are not in `seed:dev`.

- **Git identity:** GitHub blocks pushes whose commits use the personal Gmail (GH007). This repo sets a local noreply email; a fresh clone needs the same local setting.
- Two design documents live beside the code and are not part of the repo (gitignored). `git add -A` once committed them by accident. Stage explicit paths.
- Do not run `git filter-branch` without checking the working tree afterward. It deletes files that stop being tracked.
- **The UI prompts file was rewritten mid-build (2026-09-19, 14:43).** The Dashboard mockup and its two PNGs changed from an offline SVG map to a Leaflet map on CARTO tiles, and a UI-3 (vessel tracking) prompt was added. The pasted UI-2 prompt said the opposite (no tile server). The newer file on disk was followed for the map. Steps other than the dashboard were unaffected.
- Thomas's UI design inputs sit untracked in the repo folder: `UI Mockup/` and `docs/ui-mockups/` (HTML and PNG mockups of the dashboard, roadmap, issue, intake, and superadmin approval screens). UI-2 reads `docs/ui-mockups/v2-revised/`. They are design inputs, not code. Do not commit them unless Thomas says so. The memory check deliberately ignores them.
- Running a nested `claude -p` in this folder while the tree has uncommitted code and no doc updates triggers the Stop hook, which forces that session into a `/wrapup` attempt and replaces its answer. Commit first, then test cold starts.
- The memory check on this project takes about a second per commit, and its test file about 45 seconds because it builds throwaway git repos. That is expected.
- Tests truncate every table. The runner refuses to start unless the database name ends in `_test`.
- Claude's own memory is keyed by working directory, so only files in this repo reliably carry over. That is why this file exists.
