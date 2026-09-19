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

---

## 2026-09-19, Stage 1, Step 2: Permission engine

**Built**
- `src/permissions/engine.ts`: `resolveDocumentPermissions`, `canManageOrgUsers`, `canConfigureVisibilityRules`, plus the pure helper `mergePermissionRules` and the constants `SUPERADMIN_PERMISSIONS` and `DEFAULT_PERMISSIONS`.
- `src/types.ts` (`UserRef`, `isSuperadmin`) and `src/errors.ts` (`PermissionDeniedError`, `NotFoundError`, `ValidationError`) shared by later steps.

**Decisions not fully specified in the prompt**
- `resolveDocumentPermissions` and `canManageOrgUsers` are `async` (return a Promise). The prompt's signatures show plain return types, but both must read roles and rules from the database, and hiding a synchronous DB call is not possible in Node. `canConfigureVisibilityRules` stays synchronous because it only inspects `organization_id`. Each DB-backed function takes an optional trailing `db` argument so it can run inside a transaction.
- Merge logic lives in a pure function (`mergePermissionRules`) so the leak-prevention rule is testable without a database: rank hidden < status_only < full, OR the three booleans, then force all three false if the merged view level is not full.
- Superadmin is detected with strict `organization_id === null`, not `== null`. A caller that omits the field (undefined) is not treated as superadmin. A non-null, non-string value throws in the resolver and returns false in `canManageOrgUsers` (fail closed).
- Only roles that belong to the user's own organization count in the resolver and in `canManageOrgUsers`, even if a stray `user_role_assignments` row pointed at another org's role. Defense in depth; `inviteUser` will also refuse cross-org role ids.
- A user with zero role assignments matches no rules and gets the opt-in defaults (full view, no edit/download/approve), exactly as the prompt specifies for "no rule row exists". Consequence to be aware of: a roleless user can see a document type that every real role has hidden. Step 3 closes the practical gap by requiring at least one role at invite time.
- Not in the prompt, deliberately not added: the engine does not look at `users.status` or `organizations.status`, so a deactivated user or suspended org still resolves permissions. Blocking those is an authentication/session concern (the prompt says sign-in is a separate, upstream piece). Flag for that prompt: fail closed on deactivated users and suspended orgs.
- Trust boundary: the engine trusts the `organization_id` on the `UserRef` it is handed. Upstream middleware must load the user from the database, never from client input.

**Tests:** none yet (step 5). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 1, Step 4 (built before Step 3): Audit helper

**Built**
- `src/audit/recordAudit.ts`: `recordAudit({ actorUser, action, targetType, targetId, metadata }, db?)`. Inserts one `audit_log` row. `actorUser` may be `null` for system-initiated actions.

**Order note:** step 4 was built ahead of step 3 because every lifecycle function in step 3 calls `recordAudit`. The commit history therefore shows audit helper, then lifecycle. Nothing else about the numbering changes.

**Decisions not fully specified in the prompt**
- Optional second argument `db` (a transaction handle). Lifecycle functions pass their open transaction so the audit row commits or rolls back with the mutation it describes. Default is the shared client.
- `action` must be a dotted lowercase name (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), otherwise `ValidationError`. Keeps the event vocabulary greppable and stops typos like "OrgApproved" from entering the trail.
- `metadata` defaults to `{}`. The column is NOT NULL.
- This is append-only by convention: nothing in the codebase updates or deletes `audit_log` rows. Not enforced at the database level (no trigger yet). Worth adding before real customer data lands, since the Control Tower design treats the audit trail as the system of record.

**Tests:** none yet (step 5). `tsc --noEmit` clean.
