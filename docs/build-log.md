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

---

## 2026-09-19, Stage 1, Step 3: Organization and user lifecycle

**Built**
- `src/services/organizations.ts`: `proposeOrganization`, `approveOrganization`, `rejectOrganization`.
- `src/services/users.ts`: `inviteUser`, `deactivateUser`.
- `src/roles.ts`: `STANDARD_ROLES` (Organization Admin with is_org_admin true; Compliance Manager, Compliance User, Reviewer, Viewer with false).
- `src/services/util.ts` (email normalization, unique-violation detection), `src/index.ts` (barrel export).
- `scripts/seed.ts`: idempotent local seed of one superadmin (`SEED_SUPERADMIN_EMAIL`, default `superadmin@veripura.local`) and four starter document types. Seeds NO permission rules, per the prompt's notes (the default matrix is a later data-seeding step from the pilot Scope of Work). The superadmin creation writes an audit row (`user.superadmin_seeded`, actor null).

**Audit actions and targets**
- `organization.proposed` / `organization.approved` / `organization.rejected`: target_type `organization`, target_id the org.
- `user.invited` / `user.deactivated`: target_type `user`, target_id the affected user.
- Every function writes its mutation and its audit row in one transaction (the transaction handle is passed to `recordAudit`).

**Decisions not fully specified in the prompt**
- The prompt's schema section gives "org.approved" as an example event name while the lifecycle section says "organization.approved". Used the lifecycle names, since those are the explicit instructions.
- `proposeOrganization` records the requester (the new invited user) as the audit actor, not null. Null means system-initiated; a person proposing an organization is not that. It returns `{ organization, user }`.
- Approve and reject require the org to be `pending_approval`, and take a row lock (`SELECT ... FOR UPDATE`). Approving an active org, or reversing a rejection, would otherwise double-create roles or silently rewrite history. Anything else throws `ValidationError`.
- "First user" for approval is the earliest-created user in the org (ties broken by id). At proposal time exactly one exists.
- Rejecting an org leaves its requester user in `invited`. The prompt only says to set the org status.
- `inviteUser` requires the org to be `active`, requires at least one role, and requires every role id to belong to that org. The at-least-one-role rule closes the roleless-user gap noted under step 2. It also normalizes email (trim, lowercase). Duplicate emails, including case variants, are rejected with `ValidationError`.
- `inviteUser` permission failures throw `PermissionDeniedError`. `deactivateUser` deliberately returns `NotFoundError` (not a permission error) when a non-superadmin targets a user outside their own org, so org admins cannot probe which user ids exist in other orgs. This matches the "do not leak existence" stance the prompt takes for consignments in stage 3. A caller with no user-management authority at all still gets `PermissionDeniedError`.
- `deactivateUser` refuses to deactivate an already-deactivated user (`ValidationError`) rather than writing a duplicate audit row.
- Known gap, not in the prompt: nothing stops an org admin from deactivating themselves or the last Organization Admin, which would leave the org with no one who can manage users (superadmin can still recover). Flagging rather than inventing a rule.
- Superadmin is only ever created by the seed script. No service function creates a superadmin.

**Tests:** none yet (step 5). `tsc --noEmit` clean; seed script run twice against the dev database to confirm idempotence.

---

## 2026-09-19, Stage 1, Step 5: Tests

**Built**
- `tests/permissions.test.ts` (22 tests), `tests/lifecycle.test.ts` (29), `tests/audit.test.ts` (5, counting the parameterized cases), `tests/helpers.ts` (factories that build orgs through the real propose/approve functions).
- Coverage of the prompt's list:
  - Compliance User with a status_only rule gets status_only and no grants.
  - Two roles, one full+can_approve and one hidden: resolves to full with can_approve true.
  - No leak of edit/download/approve from below-full rules: proven in the pure merge function with hand-built rows the database would never allow (hidden and status_only carrying grants merge to a below-full result with all grants false), and separately that Postgres rejects such rows (`dpr_grants_require_full_view`).
  - Org admin can invite into their own org but not another: refused with `PermissionDeniedError`, and no user row and no audit row is written.
  - Document type with zero rules: full view, no edit/download/approve.
  - Superadmin: full/all-true even when every role of every org type is hidden.
  - Approval creates all five standard roles with the correct `is_org_admin` flags and assigns Organization Admin to the first user.
  - Every lifecycle function (proposed, approved, rejected, invited, deactivated) writes exactly one audit row with the right action, target type, target id, and actor.
- Beyond the list: cross-org role ids refused, roleless invites refused, duplicate email in any case refused, double-approve refused, org-admin cannot reach another org's users (NotFound), undefined `organization_id` is not treated as superadmin, `recordAudit` rolls back with its transaction, malformed action names refused.

**Decision made during this step**
- `mergePermissionRules` now counts each boolean only from rules that are themselves full view (previously it ORed all rules, then cleared the booleans if the merged view was below full). For stored data the two are identical because of the CHECK constraint. The change closes one case the original wording would leave open if that constraint were ever dropped: a below-full rule carrying a grant merged with a full rule from another role would have leaked the grant into a full result. The post-merge re-application of the constraint is kept, as the prompt requires. Covered by the test "does not leak a grant from a below-full rule into a merged result that resolves to full".

**Verification**
- Full suite: **56 of 56 passing**, run from a freshly dropped and recreated test database (migrations and bootstrap included). `tsc --noEmit` clean.
- Mutation check, to confirm the tests can fail: removing the full-only guard, removing the own-org check in `inviteUser`, renaming the audit action in `approveOrganization`, and making the defaults grant edit each turned the suite red at the expected tests. Source restored afterward.
- The suite runs against `veripura_test` only. The dev database (`veripura`, seeded) was confirmed untouched.

**Open items carried forward (not blocking this stage)**
- Fail closed for deactivated users and suspended orgs belongs in the authentication prompt (see step 2).
- No database-level immutability on `audit_log` yet (see step 4).
- Nothing prevents the last Organization Admin from deactivating themselves (see step 3).
- Default permission matrix is unseeded, by design; seed from the pilot Scope of Work Section 7 with grants left false.
- No git remote configured for this repo; see stage-end note below.

**Stage 1 status:** complete. Steps 1 to 5 built and tested. No HTTP layer or webhook code, per the prompt.

---

## 2026-09-19, Stage 1, correction to the Step 5 entry

The Step 5 entry gave per-file test counts of 22 / 29 / 5. The verified counts are **permissions 22, lifecycle 25, audit 9** (audit counts each parameterized malformed-action case). The total of 56 passing was correct and is unchanged.

---

# Stage 2: PO intake, consignments, issues, VeriPura core webhook contract

Stage 1 code (`src/db`, `src/permissions`, `src/audit`, `src/services/organizations.ts`, `src/services/users.ts`) was read and reused as is. Build order this stage: 1 (schema), 3 (outbound contract), 4 (inbound contract), 2 (PO submission, which calls both contracts), 5 (issues), 6 (tests plus the HTTP layer's tests). Numbering in the prompt is unchanged; only the order differs, and the commit history shows it.

## 2026-09-19, Stage 2, Step 1: Schema additions

**Built**
- Migration `drizzle/0001_stage2_consignments_checklist_issues.sql`: `consignments`, `purchase_orders`, `document_checklist_items`, `issues`, `webhook_events`, plus enums for consignment status, checklist `required_by`, checklist item status, issue status, webhook direction and status.
- `consignments.external_core_id` is nullable text, present from now on for the eventual real core link.

**Decisions not fully specified in the prompt**
- `document_checklist_items` is unique on (consignment_id, document_type_id, required_by). This unique index is what makes replaying a checklist callback idempotent (`ON CONFLICT DO NOTHING`), even under concurrent replays. `required_by` is part of the key so a document that genuinely must come from two parties is representable.
- `document_types.name` uniqueness changed from case-sensitive to case-insensitive (`lower(name)`). Core will send names as free text; "bill of lading" and "Bill of Lading" must be one type. Existing rows were unaffected (dev database re-checked).
- `consignments` has a CHECK that importer and exporter are different orgs.
- `issues` has a CHECK that `resolved_at` is set if and only if status is `resolved`, and a CHECK that an issue's source item differs from its own item. `issues.consignment_id` is denormalized from the checklist item so party-scoped queries need no join.
- `webhook_events.consignment_id` is nullable, used only for an inbound call from core that could not be tied to a known consignment (signature valid, consignment unknown).
- `hs_code` is nullable and `submitPurchaseOrder` will accept an optional `hsCode`, because the outbound payload carries `hsCode`.

**Dependency note:** `npm audit` reports 4 moderate findings, all in `drizzle-kit`'s transitive `esbuild` (a dev-server request issue). It is a dev tool that never runs a dev server here, and the suggested fix downgrades drizzle-kit to 0.18.1. Left as is.

**Tests:** stage 1's 56 still pass against the new schema (see run at commit time). New tests arrive in step 6.

---

## 2026-09-19, Stage 2, Step 3 (built before Step 2): Outbound contract to VeriPura core

**Built**
- `src/core/types.ts`: `CoreConsignmentPayload` (`consignmentId, externalCoreId, commodity, hsCode, originCountry, destinationCountry, importerOrgId, exporterOrgId, poFileUrl`), `CoreChecklistPayload`, and the `VeriPuraCoreClient` interface (`submitConsignment`).
- `src/core/client.ts`: `StubVeriPuraCoreClient` (simulated delay, hardcoded checklist of Commercial Invoice, Packing List, Bill of Lading, Export Health Certificate; never reports an externalCoreId) and `HttpVeriPuraCoreClient` (real `fetch` POST, 10 s timeout, any 2xx is "accepted"). Selected by `VERIPURA_CORE_MODE=stub|live`, default `stub`. `live` fails fast at first use if `VERIPURA_CORE_WEBHOOK_URL` or `VERIPURA_CORE_WEBHOOK_SECRET` is missing. `setCoreClient()` is the test override.
- `src/core/signature.ts`: HMAC-SHA256 sign and constant-time verify, shared by the outbound client and the inbound endpoint (step 4).
- `src/core/send.ts`: `sendToVeriPuraCore(consignment, actingUser?)`.
- Env vars added to `.env.example` (and the local `.env`): `VERIPURA_CORE_MODE`, `VERIPURA_CORE_STUB_DELAY_MS`, `VERIPURA_CORE_WEBHOOK_URL`, `VERIPURA_CORE_WEBHOOK_SECRET`. The secret in the example file is an obvious placeholder for the local sandbox.

**Decisions not fully specified in the prompt**
- The stub returns the checklist in its response, and the submit flow applies it through the same function the inbound webhook uses. That gives the end-to-end behavior the prompt wants (checklist created, status checklist_received) with one code path for applying a checklist, while the live client stays asynchronous (core calls back).
- `sendToVeriPuraCore` takes only the consignment, per the prompt, and looks up the PO file location itself (latest `purchase_orders` row).
- The network call is made outside any DB transaction. Afterward the outbound `webhook_events` row, the status change, and the audit row commit together.
- Status moves po_submitted -> checklist_pending only from `po_submitted`. A resend from `checklist_pending` leaves it alone; sending from any other status is a `ValidationError`.
- Failure path (not in the prompt): a failed call writes an outbound `webhook_events` row with status `failed`, audits `consignment.core_send_failed` (error text in metadata), leaves the consignment in `po_submitted`, and throws `VeriPuraCoreError` carrying the consignment id. The PO is not lost. There is no retry mechanism yet; a caller can call `sendToVeriPuraCore` again.
- Extra audit action `consignment.sent_to_core` because the function mutates status and inserts a row, and the stage 1 rule is that every mutation is audited.
- Outbound signing: the live client signs its body with `X-VeriPura-Signature` (same HMAC scheme as the callbacks it expects). The prompt only specifies signing for the inbound direction, so this is our proposal and is **to be confirmed with Onno's team** along with the rest of the contract.
- A bug caught while writing this step: an `eq(a) && eq(b)` in the status update's `WHERE` would have silently dropped the id filter (JavaScript `&&` on two SQL objects returns the second), updating every `po_submitted` consignment. Fixed to `and(...)`. TypeScript cannot catch that; step 6 adds a test that sending one consignment leaves another `po_submitted` consignment untouched.

**Tests:** none yet for this step (step 6). `tsc --noEmit` clean.
