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

---

## 2026-09-19, Stage 2, Step 4 (built before Step 2): Inbound contract, `POST /webhooks/veripura-core/checklist`

**Built**
- `src/core/validate.ts`: `parseChecklistPayload`, strict validation of `{ consignmentId, externalCoreId?, requiredDocuments: [{ documentTypeName, requiredBy }] }`.
- `src/services/checklist.ts`: `applyChecklist(payload, actingUser?)`, the single code path for both this endpoint and the stub client's synchronous checklist. Plus `logFailedInboundWebhook`.
- `src/http/webhooks.ts`: the Fastify route, registered as an encapsulated plugin. `src/http/app.ts`: `buildApp()` (does not listen, so tests use `app.inject()`), plus `GET /health`.
- Dependency: `fastify` 5.

**How it behaves**
- Signature: HMAC-SHA256 of the **raw body bytes**, hex, in `X-VeriPura-Signature` (a `sha256=` prefix is also accepted), compared in constant time. Verified before any JSON parsing. Missing, malformed, or wrong: 401 `invalid_signature`, and nothing is written or logged. If no secret is configured the endpoint returns 503 and refuses everything; there is no bypass.
- Idempotent: checklist items are unique per (consignment, document type, requiredBy) and inserted with `ON CONFLICT DO NOTHING`. A replay creates nothing, returns 200 with `duplicate: true`, and writes no audit row. A payload that adds a new document to an existing checklist adds just that item.
- `externalCoreId` first write wins under a row lock on the consignment: stored only if null. A later different value is ignored and recorded in the audit metadata (`external_core_id_ignored`).
- Document types are found case-insensitively by name, or created (category left null).
- Status moves to `checklist_received` only from `po_submitted` or `checklist_pending`. It never moves backward from `active`. Consignments that are `completed` or `cancelled` refuse a checklist (409).
- Every call that reaches `applyChecklist` writes an inbound `webhook_events` row (`received`). Authenticated calls that fail write one with status `failed` (bad JSON, bad payload, unknown consignment with `consignment_id` null, or state conflict). Audit `consignment.checklist_received` (actor null, system) is written only when something changed.
- Responses: 200 `{ ok, consignmentId, status, itemsCreated, duplicate }`, 400 `invalid_payload`, 401 `invalid_signature`, 404 `consignment_not_found`, 409 `consignment_state_conflict`, 503 `webhook_secret_not_configured`.

**Decisions not fully specified in the prompt**
- A callback for a consignment still in `po_submitted` (a fast live core answering before our own status update lands) is accepted and moves straight to `checklist_received`; `sendToVeriPuraCore` only advances from `po_submitted`, so it cannot pull it back.
- An empty `requiredDocuments` array is rejected (400) rather than treated as "no documents needed". Payloads are limited to 200 documents, names to 200 characters.
- Duplicate entries inside one payload (same name ignoring case, same requiredBy) are collapsed.
- No timestamp or nonce replay protection, since idempotency already makes replays harmless. Worth revisiting if the contract adds timestamps.
- Signed failures are logged in `webhook_events` with the body (truncated to 4000 characters for invalid JSON). Unsigned or wrongly signed requests are deliberately not stored, so an unauthenticated caller cannot fill the table.

**Smoke check (before step 6's real tests):** ran the app with `inject()` for no signature, wrong signature, signature over a different body, bad JSON, bad payload, unknown consignment, and no configured secret. All returned the codes above, and only the three authenticated failures were logged. The dev database rows it created were removed.

**Tests:** none yet (step 6). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 2, Step 2: PO submission flow

**Built**
- `src/services/consignments.ts`: `submitPurchaseOrder({ importerOrgId, exporterOrgId, commodity, hsCode?, originCountry, destinationCountry, fileBuffer, fileName, actingUser })`.
- `src/storage/fileStorage.ts`: the `FileStorage` interface and `uploadFile(buffer, filename): Promise<string>` entry point the prompt asked for. Default `LocalFileStorage` writes to `STORAGE_DIR` (default `.storage/`, gitignored) and returns a `local://` key; `InMemoryFileStorage` for tests; `setFileStorage()` is the swap point for S3/GCS. Filenames are reduced to a safe basename.
- `src/services/actors.ts`: `loadActiveActor`.
- `src/http/purchaseOrders.ts`: `POST /purchase-orders`, a thin wrapper. `src/http/app.ts` gains a central error handler (permission 403, not found 404, validation 400, core failure 502 with the saved consignment id). `src/server.ts` (`npm run dev` / `npm start`), bound to 127.0.0.1 only.

**Flow:** authorize, validate, upload file, one transaction (consignment `po_submitted` + `purchase_orders` row + audit `consignment.po_submitted`), then `sendToVeriPuraCore` (status to `checklist_pending`, outbound webhook event), then, if the client returned a checklist (the stub does), `applyChecklist` (status to `checklist_received`, checklist items, inbound event, audit `consignment.checklist_received`). Returns the final consignment row.

**Decisions not fully specified in the prompt**
- Authorization is checked first, before any organization lookup, so an unauthorized caller cannot learn which orgs exist. Actor must be superadmin or an active user whose stored `organization_id` equals `importerOrgId`. The actor's row is re-read from the database, so the stored org and status are used, not whatever the caller-supplied reference claimed.
- The importer org must be an active `importer`-type org and the exporter org an active `exporter`-type org, and they must differ (also enforced by a table CHECK). The prompt did not say to validate org types; without it a logistics org could be named as an exporter.
- The PO file is uploaded before the database transaction (storage is an external side effect). If the transaction then fails, an orphaned file remains in storage. Acceptable for now, since cleanup belongs with the real storage backend.
- If core is unreachable: the PO and consignment are kept in `po_submitted`, the failed call is logged, and `VeriPuraCoreError` (HTTP 502) carrying the consignment id is thrown. The caller retries by calling `sendToVeriPuraCore` again. No automatic retry yet.
- **HTTP layer and authentication:** the prompt says sign-in is out of scope and `actingUser` is resolved upstream. `POST /purchase-orders` therefore returns 401 unless `ALLOW_DEV_ACTOR_HEADER=true`, in which case it trusts an `X-Acting-User-Id` header. That is a sandbox stand-in, off by default (the `.env.example` value is `false`), and must be replaced by real middleware before anything is exposed. The PO file travels as base64 in JSON (`fileName`, `fileBase64`) rather than multipart, keeping the layer thin; the service takes a Buffer either way.

**Tests:** none yet (step 6). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 2, Step 5: Issues service layer

**Built**
- `src/services/issues.ts`: `raiseIssue`, `requestCorrection`, `resolveIssue`. `src/index.ts` now also exports the stage 2 modules.

**Behavior**
- `raiseIssue({ documentChecklistItemId, problem, expectedValue, foundValue, sourceChecklistItemId, responsibleOrgType, actingUser })`: inserts an `open` issue, sets the checklist item to `flagged`. Audit `issue.raised`.
- `requestCorrection({ issueId, message, actingUser })`: sets `correction_requested`, message in audit metadata. Audit `issue.correction_requested`.
- `resolveIssue({ issueId, actingUser })`: sets `resolved` and `resolved_at`, moves the item back to `pending` (never `verified`). Audit `issue.resolved`.
- Permission for all three: superadmin, or an **active** user whose org is the importer or exporter on the issue's consignment. Anyone else gets `PermissionDeniedError`. The actor's stored row is re-read, so a caller-supplied org id cannot widen access.

**Decisions not fully specified in the prompt**
- **Tighten later, as the prompt asked:** the permission check is deliberately permissive because no automated validator or dedicated reviewer role exists yet. It should move to a specific role (likely Compliance Manager) or a system actor once a real validation engine exists. This is also recorded in the code comment on `authorizeForConsignment`.
- Resolving an issue only sets the item to `pending` when no other unresolved issue remains on that item. If others remain the item stays `flagged`. The prompt's wording ("sets the item back to pending") would otherwise let the convenience status contradict the issues table, which the prompt itself calls the source of truth.
- Known wart, not fixed: an item that was `awaiting_upload` when flagged becomes `pending` once resolved, which implies an upload that may not have happened. The prompt specifies `pending`, and document upload does not exist yet. The pre-flag status is stored in the `issue.raised` audit metadata (`item_status_before`) so a later stage can restore it properly.
- `requestCorrection` on an issue already in `correction_requested` is allowed (a reminder); on a `resolved` issue it is a `ValidationError`. Resolving an already resolved issue is a `ValidationError`, with no duplicate audit row.
- `sourceChecklistItemId` must be a different item on the same consignment (also a CHECK for the self-reference case).
- Concurrency: each operation locks the checklist item row first, then the issue, everywhere, so concurrent raise/resolve on one item serialize and cannot deadlock or race on the item's status.

**Tests:** none yet (step 6). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 2, Step 6: Tests

**Built**
- `tests/purchaseOrders.test.ts` (29), `tests/webhook.test.ts` (31), `tests/issues.test.ts` (17), plus stage 2 helpers in `tests/helpers.ts` (`createTradeParties`, `submitTestPO`, `RecordingCoreClient`, `postChecklist`, and others). Stage 1 files are unchanged: permissions 22, lifecycle 25, audit 9.
- Test harness: `vitest.config.ts` now pins `VERIPURA_CORE_MODE=stub`, a 0 ms stub delay, a test webhook secret, and `ALLOW_DEV_ACTOR_HEADER=false`, so the suite never depends on a developer's local `.env`. `tests/setup.ts` resets in-memory file storage and the core client before every test.

**Coverage of the prompt's list**
- Submitting a PO as a user outside the importer org is rejected (also for the exporter's own admin, an invited user, and a forged `organization_id`), and nothing is created: no consignment, PO, webhook event, consignment audit row, core call, or stored file.
- Stub end to end: consignment reaches `checklist_received`, four `awaiting_upload` items with the right `required_by`, PO row and stored file, one outbound `sent` and one inbound `received` event with the documented payload, and `po_submitted`, `sent_to_core`, `checklist_received` audit rows with the right actors.
- Inbound endpoint rejects an invalid signature (six variants: wrong, well-formed but wrong, over a different body, wrong secret, missing header, malformed) with 401 and leaves no trace (no items, no status change, no event rows, no audit rows). Also: tampered body with a valid signature over the original, prefix form accepted, 503 when no secret is configured.
- Replaying the same payload twice, three times, and six times concurrently creates no duplicate items.
- `externalCoreId` populates when null; a second payload with a different value does not overwrite it (and the audit row records the ignored value).
- Raising an issue flags the item; resolving returns it to `pending`, never `verified`; every issue transition writes its audit row with the right action, target, actor, and details.

**Beyond the list:** core outage keeps the PO and can be retried; live client via a fake `fetch` (payload, signature, non-2xx and network errors); env-based client selection; filename sanitizing; `POST /purchase-orders` (401 by default, 201, 403, 400, 502); payload validation cases; unknown consignment (404, logged as failed with no consignment id); cancelled consignment (409); document types matched case-insensitively; multi-issue item stays `flagged`; concurrent raise and resolve on one item; table CHECK constraints on issues.

**Defects the tests caught during this step**
- `POST` with `Content-Type: text/plain` was not rejected with 415. Fastify's default text parser gave the handler a string. It was not a signature bypass (the HMAC still had to match the same bytes) but it accepted a content type the endpoint should not. Fixed: the webhook plugin now removes Fastify's default parsers and accepts only its raw-bytes `application/json` parser, and the handler asserts it received a Buffer.
- Found by review before any test existed, then locked in by a test: the `eq(...) && eq(...)` in `sendToVeriPuraCore` (see Step 3).

**Verification**
- Full suite: **133 of 133 passing**, run from a freshly dropped and recreated test database. `tsc --noEmit` clean. No em dashes in any file.
- Mutation check, to confirm the tests can fail. Each of these turned the suite red at the expected tests, then the source was restored: dropping the id filter in `sendToVeriPuraCore`; making `verifySignature` always true; letting `externalCoreId` be overwritten; making `resolveIssue` set `verified`; making `resolveIssue` ignore other unresolved issues; skipping the importer-org check in `submitPurchaseOrder`; skipping issue authorization; restoring Fastify's default content-type parsers.
- The dev database (`veripura`) was confirmed untouched by the suite.

**Open items carried forward**
- Real sign-in replaces the `X-Acting-User-Id` stand-in (separate prompt). Fail closed for deactivated users and suspended orgs belongs there too (stage 1 note).
- The contract with core is unconfirmed: the outbound request signing, the response shape for accepted submissions, and the callback payload should be confirmed with Onno's team before the live client is used. `VERIPURA_CORE_MODE=live` has only been exercised against a fake `fetch`.
- No automatic retry when core is unreachable; a failed send is retried by calling `sendToVeriPuraCore` again.
- An item that was `awaiting_upload` when flagged returns to `pending` on resolve (per the prompt); `item_status_before` is in the `issue.raised` audit metadata for a later stage to restore it properly.
- Issue permissions are intentionally permissive; tighten to a specific role or system actor when validation exists.
- `audit_log` is still not immutable at the database level.
- `npm audit`: 4 moderate findings in `drizzle-kit`'s dev-only transitive `esbuild`; the suggested fix is a breaking downgrade. Left as is.

**Stage 2 status:** complete. Steps 1 to 6 built and tested. No document upload and no automated validation, per the prompt.

---

## 2026-09-19, Repository: first push to origin, and a history correction made before it

`origin` is `https://github.com/VeriPura-2/MultiUser.git` (empty at the time of the first push).

**Correction:** two design source documents that were already in this folder before the build began (`trade_compliance_control_tower_design.pdf`, `Veripura_Comparison_Two_Product_Architecture_Documents.docx`) had been committed by accident. They were unstaged in the very first commit, then swept back in by a later blanket `git add -A`. They are internal design documents that nobody asked to publish, so before the first push they were removed from every local commit (a one-off `git filter-branch` on the unpushed `main`) and added to `.gitignore`. The files themselves are unchanged on disk, verified byte for byte against the copies in history. As a result the commit hashes for steps 2 onward differ from any earlier notes; the content of every commit is otherwise identical. Nothing had been pushed, so no shared history was rewritten.

**Lesson recorded:** stage explicit paths, not `git add -A`, in a folder that holds files the repo does not own.

---

## 2026-09-19, Repository: commit identity

The first push to `origin` was declined by GitHub (GH007, private email protection), because commits carried the global git identity's personal email. Before anything was published, the 14 local commits were re-authored to the account's GitHub noreply address, and this repository's *local* git config now sets that address (the global config is untouched). File contents were verified identical before and after by comparing tree hashes. `main` was then pushed to `origin` for the first time. Anyone committing from another machine needs the same local setting, or a push will be declined the same way.

---

# Stage 3: role-scoped checklist, issue retrieval, and party workload

Stage 2 code was read and reused. Build order follows the prompt: 1 (checklist endpoint), 2 (consignment list), 3 (party workload), 4 (tests). Stage 1 and 2 suites (133 tests) were re-run after the shared refactors below and still pass.

## 2026-09-19, Stage 3, Step 1: `GET /consignments/:consignmentId/checklist`

**Built**
- `src/services/consignmentViews.ts`: `getConsignmentChecklist(consignmentId, actingUser)` plus the building blocks the next two steps reuse (`loadResolvedItems`, `loadUnresolvedIssues`, `isPartyTo`, visibility predicates).
- `src/http/views.ts`: the route. `src/http/actor.ts`: acting-user resolution moved out of `purchaseOrders.ts` so every route shares one implementation and one `ALLOW_DEV_ACTOR_HEADER` switch (401 without an acting user, as before).
- `src/permissions/engine.ts`: new `createPermissionResolver(user, db, documentTypeIds?)`, which loads the user's org type, role names, and matching rules once and returns a function that resolves any document type from memory. `resolveDocumentPermissions` is now a thin wrapper over it.

**Decisions not fully specified in the prompt**
- **Bulk resolver instead of calling `resolveDocumentPermissions` per item.** The prompt says to resolve each item via `resolveDocumentPermissions`. Doing that literally costs three queries per item, and the list and workload endpoints resolve many items across many consignments. The resolver factory does the identical lookup and the identical merge (`mergePermissionRules`) in a fixed three queries, and `resolveDocumentPermissions` itself now calls it, so there is one implementation, not two that could drift. Step 4 adds a test that the two agree across a matrix of rule combinations. Stage 1's 22 permission tests pass unchanged.
- **404 versus 403 (the prompt left it to me).** A user who is not superadmin and not on the importer or exporter org gets `404`, the same as for a consignment that does not exist. This model has no "related but wrong org" relationship beyond being a party, so a 403 would only confirm to a stranger that an id is real. A user who is not active gets `403` before any consignment is looked up; that reveals nothing about any consignment. A malformed id is also `404`.
- **Response shape follows the prompt** (`{ consignmentId, consignmentStatus, checklist }`; status_only and full item shapes as specified), with one addition: every item carries `checklistItemId`. Without an id a caller cannot act on an item. It is an opaque uuid, not content, so it does not weaken status_only.
- **`openIssue` is singular but an item can hold several unresolved issues (stage 2 allows it).** The checklist shows the longest-standing one (earliest created). The list and workload counts count items, not issues, so this ambiguity does not affect any number.
- **A source document you cannot see is not named.** The prompt says to resolve the source checklist item's document type name for display. If that source item is hidden from the viewer, naming it would reveal that a document they cannot see exists, so `sourceDocumentTypeName` is omitted in that case (as it is when there is no source). status_only sources are named, since a status_only viewer already sees that item's name in the checklist.
- **Known limit, not fixable here:** an issue's `expectedValue` and `foundValue` are free text and may be copied from a document the viewer cannot see. Nothing can detect that. It is a reason to keep issue authorship to trusted roles (see the stage 2 note about tightening).
- Items are ordered by creation time, then document type name, then `requiredBy`, so the order is stable.
- Reads run in one repeatable-read, read-only transaction, so a view never mixes two moments.

**Tests:** none yet for this stage (step 4). Stage 1 and 2 suites: 133 of 133 passing after the refactors. `tsc --noEmit` clean.

---

## 2026-09-19, Stage 3, Step 2: `GET /consignments`

**Built**
- `listConsignments(actingUser)` in `src/services/consignmentViews.ts`, and the route in `src/http/views.ts` returning `{ consignments: [...] }`.
- Shared helpers for step 3: `totalsFor` (the visibility-filtered counts for one consignment's items) and `groupByConsignment`.

**Behavior**
- Consignments where the viewer's org is the importer or the exporter, newest first; every consignment for superadmin. Access is by the viewer's stored org, and an inactive user is refused (403).
- Each summary: `id`, `commodity`, `status`, `counterpartOrgName`, `importerOrgName`, `exporterOrgName`, `checklistCompleteness: { verified, total }`, `openIssueCount`.
- **Completeness** uses the same set the checklist endpoint returns: every item the viewer can see (status_only and full), hidden items excluded from both numerator and denominator. A viewer never gets a count that references a document they cannot see.
- **openIssueCount** counts items (not issues) that have an open or correction_requested issue and that the viewer can see at **full** view. A status_only or hidden item's issue does not count.
- Data is fetched in a fixed number of queries regardless of how many consignments there are (consignments, org names, all items, all unresolved issues), with permissions resolved once through the bulk resolver from step 1.

**Decisions not fully specified in the prompt**
- `counterpartOrgName` is the org on the other side from the viewer. Superadmin has no side, so it is `null` for them, and `importerOrgName` and `exporterOrgName` are always included so their view is still readable.
- `openIssueCount` counts **items with an unresolved issue**, not issues. That matches the prompt's wording ("count of items with an open or correction_requested issue") and keeps the number consistent with the checklist, which shows one issue per item. Step 3 uses the same definition so the two endpoints never disagree.
- Not paginated: one org's consignments are expected to be few during the trial. Add paging before that stops being true.

**Tests:** none yet for this stage (step 4). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 3, Step 3: `GET /parties/workload`

**Built**
- `getPartyWorkload(actingUser, { orgId? })` in `src/services/consignmentViews.ts`, and the route in `src/http/views.ts`. Response: `{ orgId, counterparties: [{ counterpartyOrgId, counterpartyOrgName, activeConsignmentCount, documentsAwaitingUploadCount, openIssueCount }] }`.

**Behavior**
- Groups the viewer's org's consignments by the other party (exporter when the org is the importer, importer when it is the exporter), one row per counterparty, sorted by name.
- **Authorization:** any active user of an org sees their own org's workload (not superadmin-only, as the prompt requires). Superadmin has no org and must pass `?orgId=`; missing or malformed is a 400, an unknown org is a 404. For everyone else `orgId` is **ignored**, so it cannot be used to look at another org, and passing it changes nothing.
- **Permission filtering, same as the other two endpoints:** only checklist items the viewer can see at full view contribute to `documentsAwaitingUploadCount` and `openIssueCount`. Issues are counted per item (an item with two open issues counts once), the same definition as `openIssueCount` on `GET /consignments`, so the two endpoints cannot disagree.
- No "overdue" column, as the prompt directs; there is no deadline concept to base one on.

**Decisions not fully specified in the prompt**
- **Superadmin without `orgId` is a 400**, not "all orgs combined". "By counterparty" only means something relative to one org, and the prompt describes `orgId` as how superadmin views an org's workload.
- **The two counts cover active consignments only** (status not completed or cancelled), the same set as `activeConsignmentCount`. The prompt says both counts use the same permission-filtered visibility but does not say which consignments they span; a cancelled consignment's leftover awaiting uploads and open issues are not anyone's outstanding workload. `GET /consignments` still shows those issues per consignment. A counterparty whose consignments are all finished still gets a row, with zeros.
- Superadmin viewing an org resolves at full visibility on every item (superadmin's rule), so their figures are the org's unfiltered totals.

**Tests:** none yet for this stage (step 4). `tsc --noEmit` clean.

---

## 2026-09-19, Stage 3, Step 4: Tests

**Built**
- `tests/views.test.ts` (37 tests), driving the three endpoints through the real HTTP routes (`app.inject`) with the dev actor header enabled for the test app. A scenario builder creates a consignment with the stub's four documents (Commercial Invoice, Packing List, Bill of Lading, Export Health Certificate) so each test can set per-role rules, raise issues, and read exactly what each viewer sees.

**Coverage of the prompt's list**
- Exporter-side Compliance User with a `status_only` rule on Bill of Lading gets status only (asserted with exact equality and by absence of `requiredBy`, `category`, `openIssue`, and of any issue text anywhere in the body) even though an issue exists, while a full-visibility Packing List on the same checklist returns everything, including issue detail and the source document name.
- A hidden document is absent from the array (and its id and name appear nowhere in the response), and is excluded from both the completeness count and `openIssueCount`.
- An unrelated third org (and a logistics org that is a real participant but not a party) gets 404 on the checklist, and the body is identical to the 404 for a consignment that does not exist. A malformed id is 404 too.
- Superadmin sees every item at full visibility with full issue detail even when rules hide or restrict every document for every role.
- `GET /consignments` returns only consignments where the viewer's org is a party, and all of them for superadmin.
- A resolved issue is not shown as `openIssue` and does not count. A `correction_requested` issue is shown, with its status, and counts.
- An importer with consignments against two exporters gets two workload rows, each scoped to its own counterparty, with hand-computed counts.
- `status_only` and `hidden` items' issues do not contribute to `openIssueCount` on the workload row, and that figure equals the sum of the list endpoint's, so the endpoints cannot disagree.

**Beyond the list:** 401 without an acting user (all three endpoints) and 403 for invited or deactivated users; a hidden source document's name is not revealed while a `status_only` one is; several unresolved issues on one item show the longest-standing and count once; merged two-role permissions flow into the checklist; no rules configured means full view with no action rights; stable ordering; newest-first list; completeness total equals the checklist array length; awaiting-upload counts exclude `status_only` and hidden items even with no issue; workload counts cover active consignments only (finished counterparties still get a zero row); any active user, not only admins, can read workload; `?orgId=` is ignored for non-superadmins and never leaks another org's counterparties; superadmin must choose an org (400 missing or malformed, 404 unknown) and then sees unfiltered totals; the bulk permission resolver agrees with `resolveDocumentPermissions` across a rule matrix (multi-role merge, other-org-type rule, roleless user, superadmin, and with and without a document type filter).

**Verification**
- Full suite: **170 of 170 passing** (permissions 22, lifecycle 25, audit 9, purchaseOrders 29, webhook 31, issues 17, views 37), run from a freshly dropped and recreated test database. `tsc --noEmit` clean. No em dashes.
- Mutation check, each restored afterward. These each turned the views suite red at the expected tests: a `status_only` item leaking `requiredBy`; hidden items treated as visible; every user treated as a party; `?orgId=` honoured for ordinary users; resolved issues loaded as open; a hidden source document named anyway; finished consignments counted in workload; `status_only` items counted as awaiting upload; completeness total including hidden items; a non-party getting a 403 instead of a 404.
- One mutation survived on its own, then was shown to be an *equivalent mutant*, not a test gap: counting `status_only` items in `openIssueCount` changes nothing by itself, because issues are only ever loaded for full-view items, so a `status_only` item never has an issue to count. Two independent guards enforce the same rule. Breaking both together (load issues for `status_only` items and count them) is caught by three tests. The double guard is intentional.

**Open items carried forward**
- **Issue actions ignore document visibility (a stage 2 behavior that matters more now).** `raiseIssue`, `requestCorrection`, and `resolveIssue` check only that the actor is a party org user. A user whose role sees a document as `hidden` or `status_only` could still act on it if they knew its id. Ids of hidden items are never returned, and ids of `status_only` items are (as `checklistItemId`), so the practical exposure is a `status_only` viewer being able to raise or resolve an issue on a document they only see the status of. Tightening issue authority to a specific role (already noted) should include checking the item's view level.
- `canEdit`, `canDownload`, and `canApprove` are returned but not yet enforced anywhere, because document upload, download, and approval do not exist yet. When they are built they must call the permission engine.
- The list is not paginated. `expectedValue` and `foundValue` on an issue are free text and may carry content from a document the viewer cannot see (cannot be detected; see step 1).
- Real sign-in still replaces the `X-Acting-User-Id` stand-in. The three read endpoints now share that switch.
- The stage 2 items (unconfirmed contract with core, no automatic retry, `audit_log` not immutable, dev-only `npm audit` findings) are unchanged.

**Stage 3 status:** complete. The slice described in the prompt is built: an importer can submit a PO, the platform round-trips with VeriPura core (stubbed) for a checklist, discrepancies are first-class issues worked open, correction requested, resolved, every party sees the checklist and issues filtered by the permission matrix, and an importer running consignments across several exporters has a working per-counterparty view. Document upload, automated validation, and the messaging layer remain out of scope, as the prompt says.

---

# Project memory and restart tooling

Goal: Thomas can stop and restart the project at any time by having a fresh Claude session read the
project's own memory, and the memory cannot fall behind. Four steps: 1 (the memory itself), 2
(enforcement), 3 (restart and wrap-up commands), 4 (verify and push).

## 2026-09-19, Memory step 1: the memory itself

**Built**
- `CLAUDE.md` (repo root): imports `docs/PROJECT_MEMORY.md` so it loads automatically in every session run from this folder, plus a short session protocol.
- `docs/PROJECT_MEMORY.md`: restructured into the single source of truth. Now holds the standing rules (14 of them), status lines, a restart section, a description of the enforcement, the run instructions, code map, invariants, a dated history table, open items, next work, and gotchas. 133 lines, target under 250 because it loads every session.
- `docs/BUILD_PROMPTS.md`: Thomas's original three-prompt specification, the workflow section, and the Prompt 4 (Stripe) notes, saved verbatim so a cold restart has the source of truth. Only change: em dashes replaced with spaced hyphens (this project's no-em-dash rule). Not auto-loaded because of its size.

**Findings that shaped the design**
- Claude's built-in memory is keyed by working directory. The notes saved earlier live under the tower-demo project's folder, and no memory folder existed for this repo, so a session started here would have seen none of them. Only files inside the repo reliably carry over. The repo is therefore the single source of truth, and Claude's own memory becomes a thin pointer to it (step 3).
- The tower-demo project's `PROJECT_MEMORY.md` reached 5,198 lines and Thomas's own notes record that it "can fall a full session behind". A written rule alone did not prevent that, hence mechanical enforcement (step 2).

**Decisions**
- Standing rules carried over from the tower-demo project, chosen by Thomas: the general rules plus **ask-before-pattern-fix** (search the whole app for other instances of a found gap, present each, wait for a decision, only then fix). Tower-app-specific rules (deploy commands, Cloud Run, client naming) were left out.
- Correction made while writing: the History table first listed three commit hashes copied from a listing taken before the commits were re-authored, so they no longer existed. Replaced with hashes verified to exist (`git cat-file -e`). The table now says explicitly that hashes from earlier notes are stale.

**Tests:** no code changed in this step. Suite unchanged at 170 of 170.

---

## 2026-09-19, Memory step 2: enforcement

**Built**
- `scripts/memory-check.mjs`: one plain-Node script (runs on Windows) with three modes. `--staged` for the git pre-commit hook, `--hook` for the Claude Code Stop hook (answers with a JSON block decision), `--full` for an audit that also runs the suite and compares it to the facts stated in `docs/PROJECT_MEMORY.md`. `SKIP_MEMORY_CHECK=1` is the loud emergency bypass.
- `.githooks/pre-commit` runs it on every commit. `package.json` gains `prepare` (sets `core.hooksPath` to `.githooks` on `npm install`, so a fresh clone is protected) and `memory:check`. `.gitattributes` forces LF endings on hook scripts, since CRLF breaks shell scripts on Windows.
- `.claude/settings.json`: a `Stop` hook that runs the script when Claude finishes a turn, so Claude cannot end a turn with code changes and no memory update. It honours `stop_hook_active`, so it never blocks twice in a row and cannot loop.
- `tests/memoryCheck.test.ts`: 36 tests in throwaway git repositories, so the enforcement is part of the suite and cannot silently break.

**Rules enforced**
1. A change to code, tests, migrations, scripts, or config requires changes to both `docs/build-log.md` and `docs/PROJECT_MEMORY.md`.
2. `docs/build-log.md` is append-only: any removed or altered existing line blocks the commit.
3. No em dash in an added line of code or docs (also catches new untracked files, for the Stop hook).
4. `docs/PROJECT_MEMORY.md` stays valid: required sections, a "Last updated" date (must equal today when code changed), a "Tests passing" number, at most 250 lines.
5. `--full` only: the stated test count equals the real one, no test is failing, and the memory is not older than the newest commit.

**Decisions**
- "Code" is a positive list of paths, not "everything except docs". The untracked `UI Mockup/` folder (Thomas's HTML and PNG design files, a UI input) and the two design documents must never count as code, block a commit, or trigger the Stop hook. Tests cover this.
- Escape hatch exists because a hook that cannot be bypassed will eventually be disabled entirely. It prints a loud warning and the memory must be brought up to date straight afterward.
- Honest limit: the hooks prove the docs were touched and the checkable facts are true. They cannot judge whether the prose is complete. The standing rules and `/wrapup` cover that.
- A test-only seam: `MEMORY_CHECK_TEST_RESULT` lets the tests supply a canned suite result to `--full` instead of running the whole suite recursively.
- The tests set `CLAUDE_PROJECT_DIR` to the throwaway repo explicitly. Without that, running the suite inside a Claude session would make the script inspect the real repository instead of the test one.

**Defects found while building it (all fixed before commit)**
- The script's first live run flagged its own source: the `EM_DASH` constant had been written as the literal character. It now builds it from its code point. The check working on itself on its first run is a useful sign it works.
- A first version of the audit test failed because temp-repo commits carried today's real date while the test pinned "today" to 2026-01-15. Commit dates are now set deterministically.
- Patching source through Python heredocs twice corrupted backslash escapes (a `\n` became a raw newline inside a string literal). Both were caught immediately by the syntax check and type check and fixed by direct edit. Process note: do not patch backslash-heavy code through shell heredocs.

**Verification**
- Mutation check, each restored afterward. Each of these turned the enforcement tests red at the expected tests: code changes no longer requiring docs; build-log deletions undetected; em dashes undetected; the Stop hook's loop guard removed; untracked design inputs counted as code; "Last updated must be today" dropped; the bypass warning made silent; the test-count comparison removed.
- Enforcement tests: 36 of 36 passing. Full suite figure recorded in `docs/PROJECT_MEMORY.md`.

---

## 2026-09-19, Memory step 3: restart and wrap-up commands

**Built**
- `.claude/commands/pickup.md` (`/pickup`): reads the source material the memory points to, checks git (in sync with `origin/main`, local noreply email, hooks path), brings up Docker and the sandbox if needed, runs `typecheck` and `memory:check --full` (which runs the whole suite), looks for drift between the memory and reality, and reports with a recommended next step. It changes nothing except starting the sandbox. Named `pickup` because `/resume` is a built-in command.
- `.claude/commands/wrapup.md` (`/wrapup`): the end-of-session ritual. Append the build log, update the memory, verify with `memory:check --full`, commit explicit paths, push, confirm local equals remote.
- `resume.ps1` (repo root) and a `veripura` function in the PowerShell profile (`C:\Users\tomso\OneDrive\Documentos\WindowsPowerShell\profile.ps1`, all-hosts, a new file, added between marker comments so it is easy to find and remove). Typing `veripura` from any folder changes into the project and runs `claude '/pickup'`. The function is inline rather than calling `resume.ps1`, so it works even if script execution is restricted (the current policy is `RemoteSigned`, which would also allow it).
- README "Restarting the project" section.
- Claude's own memory reduced to thin pointers: a new one for this project's folder (none existed, which is why a session started here would have found nothing) and the two older notes in the tower-demo memory merged into one pointer. The repo is the single source of truth, so there is nothing to keep in sync.
- `docs/veripura-cli-ui-prompts.md` (Thomas's UI-1 and UI-2 prompts) is now a tracked specification and is referenced from `docs/PROJECT_MEMORY.md`. The mockup folders (`UI Mockup/`, `docs/ui-mockups/`) remain untracked design inputs, pending Thomas's say-so.

**Decisions**
- The `veripura` profile edit is the only change outside the repo and Claude's memory folders. The profile file did not exist, so nothing was overwritten or needed a backup; if it existed the installer copies it to `profile.ps1.bak-before-veripura` first and never adds the block twice.
- The `/pickup` step that checks the local git email exists because the first push to GitHub was refused over exactly that (see the earlier "commit identity" entry).

**Finding: the Stop hook works, and it hijacks a dirty tree**
- A first cold-start test (`claude -p` in this folder, asking memory-only questions) did not return the memory recital. It returned a `/wrapup` attempt. Cause: the session finished its answer while the tree held uncommitted new code and no doc updates, so the Stop hook blocked the stop and pushed the session into wrapping up (it had no tool permissions, so it stopped and reported). Nothing was changed, and HEAD was unaffected. This is the hook doing its job end to end, and it also means a test of a cold start must be run against a clean tree. Recorded in the memory's Gotchas.

**Tests:** no source changed in this step. Suite unchanged at 206 of 206 (verified by `memory:check --full` in step 2).
