# Build log

Append-only. One dated entry per numbered build step. Never rewrite earlier entries.

---

## 2026-09-19, Stage 1, Step 1: Sandbox and database schema

**Built**
- Repo location: `Veripura/Control Tower` (contained only two design documents, no code). `git init -b main`.
- Local sandbox: `docker-compose.yml` (Postgres 17, host port 5433), `.env.example`, README sandbox section.
- Stack: TypeScript on Node 22, Drizzle ORM + drizzle-kit for migrations, `pg`, Vitest as the single test runner for all stages.
- Schema in `src/db/schema.ts`, initial migration `drizzle/0000_init_schema.sql`: organizations, users, org_roles, user_role_assignments, document_types, document_permission_rules, audit_log.
- Test harness: `tests/global-setup.ts` (creates `veripura_test` if missing, migrates it), `tests/setup.ts` (truncates all public tables before each test).

**Decisions not fully specified in the prompt**
- Port 5433, not 5432: another Postgres is already listening on 5432 on this machine.
- Column keys in the TypeScript schema are snake_case so they match the spec's field names (`user.organization_id`).
- `document_permission_rules.org_type` uses its own enum `rule_org_type` (the five org types plus `veripura_superadmin`). The permission engine short-circuits superadmin, so a CHECK (`dpr_no_superadmin_rows`) rejects rows using that value rather than allowing dead configuration.
- The "no edit/download/approve unless view_level is full" rule is a database CHECK (`dpr_grants_require_full_view`) that rejects the row. It does not clamp. A bad row fails loudly at write time. Confirmed against the live database: an insert with `status_only` and `can_edit = true` is refused.
- `users.email` is unique case-insensitively (`lower(email)`) and globally, since a user belongs to exactly one organization.
- `org_roles` is unique on (organization_id, name). `user_role_assignments` has a composite primary key.
- `document_types.name` is unique.
- `audit_log.target_id` is NOT NULL (the spec types it as uuid with no nullability, and every audited action has a target).
- Test runner refuses to run unless the test database name ends in `_test`, because tests truncate every table.
- Test files run serially (`fileParallelism: false`) since they share one database.

**Not built here, on purpose**
- Billing columns (`billing_status`, `stripe_customer_id`, `stripe_subscription_id`) exist as a seam only. Nothing reads them.

**Tests:** none yet (step 5). Migration applied cleanly to the dev database, `tsc --noEmit` clean.
