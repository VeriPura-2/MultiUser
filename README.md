# VeriPura Platform (backend)

Multi-tenant compliance platform backend for importers, exporters, logistics providers,
laboratories/certification bodies, and third-party data sources. This repo is the foundation
layer: data model, permission engine, audit trail, and organization/user lifecycle.

Stack: TypeScript, Node 22+, Postgres 17, Drizzle ORM, Vitest.

Everything runs against a **local sandbox only**. Nothing here deploys anywhere.

## Restarting the project

The project keeps its own memory in the repo, so a fresh Claude session can pick up exactly where
the last one stopped.

- **From anywhere:** type `veripura`. (It is a small function in the PowerShell profile that opens
  Claude in this folder and runs `/pickup`.)
- **From this folder:** run `.\resume.ps1`, or run `claude` and then type `/pickup`.
- **Before stopping:** run `/wrapup`. It updates the memory, verifies, commits, and pushes.

`/pickup` reads `docs/PROJECT_MEMORY.md` (standing rules, state, history, open items), checks git
and the sandbox, runs the tests, and reports any drift between the memory and reality. A git
pre-commit hook and a Claude Code Stop hook stop the memory falling behind. Both are described in
`docs/PROJECT_MEMORY.md`. A new clone gets the git hook from `npm install`.

## Sandbox

Prerequisites: Node 22+, Docker Desktop running.

```powershell
npm install
Copy-Item .env.example .env     # values already match docker-compose.yml
npm run db:up                   # starts Postgres on localhost:5433 and waits until healthy
npm run db:migrate              # applies ./drizzle migrations to the dev database
npm run db:seed                 # optional: a superadmin and starter document types (no permission rules)
```

Postgres is published on host port **5433** (not 5432) so it does not collide with a Postgres
already running on the machine. `npm run db:down` stops it. Data lives in the
`veripura_pgdata` Docker volume; `docker compose down -v` wipes it.

## Tests

```powershell
npm run db:up      # the suite needs the sandbox running
npm test           # full suite
npm run typecheck  # tsc --noEmit
```

The suite runs against a separate `veripura_test` database. It is created and migrated
automatically on first run, and every table is truncated before each test. The runner refuses to
start unless the database name ends in `_test`, so it cannot be pointed at the dev database by
accident. Test files run serially because they share that one database.

## Running the server

```powershell
npm run dev        # http://127.0.0.1:3100, loopback only (not 3000, which a Next.js dev server may hold)
```

`VERIPURA_CORE_MODE=stub` (the default) needs no network: submitting a PO returns a hardcoded
checklist after a short delay. `live` posts to `VERIPURA_CORE_WEBHOOK_URL` and expects core to
call back `POST /webhooks/veripura-core/checklist`, signed with `X-VeriPura-Signature`
(HMAC-SHA256 of the raw body using `VERIPURA_CORE_WEBHOOK_SECRET`). See `.env.example` for every
variable.

**Acting as a user (local development only).** Real sign-in does not exist yet. With
`AUTH_MODE=dev` (the sandbox default in `.env.example`) a request acts as whichever user id it
sends in an `X-Dev-User` header, and `GET /dev/users` lists the users to choose from. The server
**refuses to start** if this is on with `NODE_ENV=production`. Any other `AUTH_MODE` leaves every
acting-user route at 401. (`ALLOW_DEV_ACTOR_HEADER=true` and `X-Acting-User-Id` are a deprecated
alias for the same thing.)

```powershell
npm run seed:dev   # sample superadmin, six organizations, a Viewer-only user, five consignments
npm run dev        # then GET http://127.0.0.1:3100/dev/users
```

`seed:dev` refuses to run against a database that is not on this machine, and does nothing if the
sample data is already there. Everything it creates is labelled "Sample".

## Read views (role-scoped)

With an acting user, three read endpoints return only what that user's role may see:

- `GET /consignments/:consignmentId/checklist`: hidden documents omitted, `status_only` ones show status only, full ones show everything including the longest-standing open issue. A user who is not a party gets the same 404 as for a missing consignment.
- `GET /consignments`: the org's consignments, each with checklist completeness and an open issue count computed over what the viewer may see.
- `GET /parties/workload`: the org's consignments grouped by counterparty (`?orgId=` is for superadmin only and is ignored for everyone else).

## API for the UI

Every route except `/health`, `/dev/users` (dev only), and the core webhook needs an acting user
(401 without one, 403 if that user is not active). A user who cannot see something gets a 404
identical to "does not exist", never a 403. Details and the reasoning for each choice are in
`docs/build-log.md`.

| Route | Who | Returns |
|---|---|---|
| `GET /me` | any | who you are: name, email, organization, role names, `isSuperadmin` |
| `GET /consignments/:id` | a party | the header fields (no quantity: the schema has none) |
| `GET /action-queue` | an org user (superadmin passes `?orgId=`) | documents awaiting upload or flagged, permission-filtered, with `actionableByMyOrg` |
| `GET /issues/:id` | a party who sees the document in full | the issue, its activity list, and which actions are available |
| `POST /issues/:id/request-correction` | same | body `{ message }`; answers with the refreshed issue |
| `POST /issues/:id/resolve` | same | no body needed; answers with the refreshed issue |
| `POST /consignments/:cid/checklist/:itemId/issues` | same | body `{ problem, responsibleOrgType, ... }`; 201 with the issue |
| `GET /organizations/exporters` | an importer org user | active exporters as `{ id, name }`, for the PO form |
| `POST /consignments` | an importer org user | multipart PO form (`file`, `exporterOrgId`, `commodity`, `originCountry`, `destinationCountry`, optional `hsCode`); 201 with the consignment |
| `GET /admin/organizations`, `GET /admin/organizations/:id` | superadmin | organizations with the applicant, and the five standard roles with their configured default permissions (or "not configured") |
| `POST /admin/organizations/:id/approve`, `.../reject` | superadmin | the refreshed organization |

## Schema changes

Edit `src/db/schema.ts`, then:

```powershell
npm run db:generate -- --name <description>   # writes a new SQL file into ./drizzle
npm run db:migrate
```

Commit the generated SQL and the `drizzle/meta` snapshot together with the schema change.

## Layout

```
src/db/          schema, client, migration runner
src/permissions/ permission engine
src/audit/       recordAudit helper
src/services/    lifecycle, consignments, checklist, issues (framework-agnostic)
src/core/        VeriPura core contract: client interface (stub and live), signing, send
src/storage/     file storage interface (local disk default, swappable)
src/http/        thin Fastify layer: webhook, the read views, and the UI endpoints below
src/dev/         local sandbox sample data (seed:dev)
scripts/         seed, seed-dev, memory-check
tests/           Vitest suite
docs/build-log.md  append-only record of what was built and why
```

## Conventions

- `actingUser` is assumed to be resolved by upstream middleware. This layer does no sign-in; the
  `AUTH_MODE=dev` header is a local stand-in only.
- Every service function that mutates state calls `recordAudit` in the same transaction as the
  mutation. A missing `recordAudit` on a mutation is a bug.
- `docs/build-log.md` is append-only. Never rewrite earlier entries.
