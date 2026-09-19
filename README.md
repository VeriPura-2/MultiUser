# VeriPura Platform (backend)

Multi-tenant compliance platform backend for importers, exporters, logistics providers,
laboratories/certification bodies, and third-party data sources. This repo is the foundation
layer: data model, permission engine, audit trail, and organization/user lifecycle.

Stack: TypeScript, Node 22+, Postgres 17, Drizzle ORM, Vitest.

Everything runs against a **local sandbox only**. Nothing here deploys anywhere.

## Sandbox

Prerequisites: Node 22+, Docker Desktop running.

```powershell
npm install
Copy-Item .env.example .env     # values already match docker-compose.yml
npm run db:up                   # starts Postgres on localhost:5433 and waits until healthy
npm run db:migrate              # applies ./drizzle migrations to the dev database
npm run db:seed                 # optional: superadmin, document types, sample rules
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
src/services/    organization and user lifecycle (framework-agnostic)
scripts/         seed
tests/           Vitest suite
docs/build-log.md  append-only record of what was built and why
```

## Conventions

- `actingUser` is assumed to be resolved by upstream middleware. This layer does no sign-in.
- Every service function that mutates state calls `recordAudit` in the same transaction as the
  mutation. A missing `recordAudit` on a mutation is a bug.
- `docs/build-log.md` is append-only. Never rewrite earlier entries.
