# Project memory: VeriPura multi-tenant platform backend

Read this first if you are picking the project up cold. `docs/build-log.md` is the detailed,
append-only record (every decision and why, per step). This file is the current state in one page.
Keep it short and update it when the state changes; do not turn it into a second build log.

## What this is

The backend for a multi-tenant compliance platform used by importers, exporters, logistics
providers, labs/certification bodies, and third-party data sources to manage import/export
document compliance for cross-border consignments. Built as a real MVP trial for businesses that
may convert to paying customers, not a throwaway prototype. Pilot lane: Brazil to GB beef.

- Repo: https://github.com/VeriPura-2/MultiUser (branch `main`). Local folder: `Veripura/Control Tower`.
- Stack: TypeScript, Node 22+, Postgres 17 (Docker), Drizzle ORM, Fastify 5, Vitest.
- Local sandbox only. Nothing is deployed anywhere, by design, until there is a UI and a real core integration.

## Status (2026-09-19)

Stages 1 to 3 of the build prompts are complete, tested (170 tests passing), and pushed.

1. **Foundation:** organizations, users, roles, permission matrix, permission engine, audit log, org and user lifecycle.
2. **PO intake:** consignments, purchase orders, document checklist, first-class issues, webhook log, the VeriPura core contract (outbound client with stub and live modes, inbound signed webhook), file storage seam.
3. **Role-scoped views:** checklist per consignment, consignment list, workload by counterparty, all filtered through the permission engine.

Not built, on purpose: document upload, automated validation, the messaging layer, any UI, sign-in, Stripe billing.

## Run it

```powershell
npm install
Copy-Item .env.example .env
npm run db:up        # Postgres on localhost:5433 (5432 is taken on this machine)
npm run db:migrate
npm test             # needs the sandbox up; uses a separate veripura_test database
npm run dev          # http://127.0.0.1:3000
```

## Map

- `src/db/schema.ts` and `drizzle/`: schema and SQL migrations (source of truth).
- `src/permissions/engine.ts`: `resolveDocumentPermissions`, `createPermissionResolver` (bulk, shares one implementation), `canManageOrgUsers`, `canConfigureVisibilityRules`.
- `src/audit/recordAudit.ts`: called in the same transaction as every mutation.
- `src/services/`: lifecycle, consignments, checklist, issues, and `consignmentViews.ts` (the three read models).
- `src/core/`: VeriPura core contract (client interface, stub and live, HMAC signing, send).
- `src/http/`: thin Fastify layer. `tests/`: Vitest suite.

## Invariants worth not breaking

- Every mutating service function calls `recordAudit` in the same transaction. A missing call is a bug.
- Edit, download, and approve are only ever true when the view level is `full`. Enforced by a database CHECK and again in the merge.
- Superadmin means `organization_id === null`, checked with strict `===`, never `== null`.
- Any number or field shown to a user passes through the permission engine. Hidden items are omitted, `status_only` items show status only, issue detail and issue counts use full-view items only.
- A non-party asking about a consignment gets the same 404 as for a missing one.
- The inbound webhook verifies an HMAC over the raw bytes before parsing anything, and refuses everything if no secret is configured. There is no bypass.
- `docs/build-log.md` is append-only. Correct mistakes with a new entry, never by rewriting.

## Open items (also in the build log)

- **Real sign-in** replaces the `X-Acting-User-Id` dev header (off by default). Fail closed for deactivated users and suspended orgs belongs there.
- **Core contract is unconfirmed** with Onno's team (outbound signing, response shape, callback payload). Live mode has only been exercised against a fake `fetch`. No automatic retry when core is down.
- **Issue actions ignore document visibility:** a `status_only` viewer who knows an item id could raise or resolve an issue on it. Tighten issue authority to a specific role and check view level when validation exists.
- `canEdit`, `canDownload`, `canApprove` are returned but not enforced anywhere yet (no upload, download, or approval exists).
- `audit_log` is append-only by convention, not by database constraint. Add a trigger before real customer data lands.
- Nothing stops the last Organization Admin deactivating themselves.
- The default permission matrix is unseeded. Seed it from the pilot Scope of Work Section 7 with grants left false.
- The consignment list is not paginated.
- `npm audit`: 4 moderate findings in drizzle-kit's dev-only transitive esbuild. The suggested fix is a breaking downgrade, so it is left alone.

## Likely next work

Prompt 4: Stripe billing (create a customer on org approval, checkout and subscription flow, a webhook keeping `billing_status` in sync). The columns already exist as a seam. Then real sign-in (Google Sign-In was the direction), then the UI as its own pass.

## Gotchas

- **Git identity:** GitHub blocks pushes whose commits use the personal Gmail (GH007). This repo sets a local noreply email; a fresh clone on another machine needs the same local setting.
- **Stage explicit paths, never `git add -A`.** Two design documents live beside the code and are not part of the repo (they are gitignored). `git add -A` once committed them by accident; history was corrected before the first push.
- Do not run `git filter-branch` without checking the working tree afterward. It deletes files that stop being tracked.
- Tests truncate every table. The runner refuses to start unless the database name ends in `_test`.
- No em dashes in any written content in this project.
