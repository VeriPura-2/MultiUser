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

---

## 2026-09-19, Memory step 4: verification of the restart path

The point of this work is that a session with no history can restart the project from its memory, so it was tested that way rather than assumed.

**Cold-start test A (memory only).** A brand-new `claude -p` session in this folder, with no tools and no files read, recited from `CLAUDE.md` alone: standing rule 1, what the ask-before-pattern-fix rule requires, the test count (206) and date, the start and end commands, real open items, and the next work (UI-1, then UI-2). The memory loads automatically.

**Cold-start test B (`/pickup` end to end).** `claude -p "/pickup"` with read-only tools dispatched the command, read the spec and the last build-log entry, confirmed `main` equals `origin/main` (`c5aae93`), the local noreply email and the hooks path, brought up the sandbox, ran typecheck and `memory:check --full` (ok, so 206 tests passing and the memory's facts true), spot-checked three open items against the code, and recommended UI-1. The repository was untouched afterward. It also found genuine drift: two History rows still said "see git log" for commits that now exist. Fixed in this entry's commit, which is the routine working as intended.

**Live negative test of the git hook.** After the step 2 commit, a code-only change was staged and committed. The real pre-commit hook refused it (exit 1) with instructions naming both docs, and the scratch change was reverted with history intact.

**Also confirmed:** `veripura` is defined in a fresh PowerShell (`Get-Command veripura`) without launching a session. The interactive path (typing `veripura`) starts the same `/pickup` that test B exercised through `claude -p`.

**Known limit, stated plainly:** the hooks and `--full` audit prove the docs were touched and the checkable facts (test count, date, sections, append-only, no em dashes) are true. They cannot prove the prose is complete or that every open item is still open. `/pickup`'s drift step and the standing rules are what cover that, and only by sampling.

**Tests:** 206 of 206.

---

# UI-1: API surface for the UI

Source: `docs/veripura-cli-ui-prompts.md`, Prompt UI-1 (eight numbered items). Existing endpoint behavior and the permission model are not changed. Each step commits with its own tests; item 8 ("Tests") is satisfied by those per-step tests plus a final cross-cutting pass, recorded in the last entry.

## 2026-09-19, UI-1 step 1: dev-only acting user and `GET /me`

**Built**
- `AUTH_MODE=dev` is now the switch for the dev acting user, with an `X-Dev-User` header (a user id). `src/http/actor.ts` (`devActorEnabled`, `assertDevModeSafe`, header handling), `src/http/app.ts` (new `actor` option, the production guard, route registration).
- `GET /me` (`src/http/me.ts`, `src/services/me.ts`): `{ userId, name, email, organization: { id, name, orgType } | null, roleNames, isSuperadmin }`. 401 without an acting user, 403 for a user who is not active.
- `GET /dev/users`: every user with organization, roles, and status, for the UI-2 dev user switcher. **Not in the UI-1 list.** It exists because UI-2 requires a switcher "listing the seeded users" and no other route can supply that list. It answers 404 unless the dev mechanism is on, and needs no acting user (the switcher must list users before one is chosen).
- `.env.example` gains `AUTH_MODE=dev` (the sandbox default); the local `.env` was updated the same way. `vitest.config.ts` pins `AUTH_MODE` empty so the suite never depends on a local `.env`.

**Decisions**
- **Reconciling the two dev-actor mechanisms (flagged in the project memory).** The spec names `AUTH_MODE=dev` and `X-Dev-User`. Earlier stages used `ALLOW_DEV_ACTOR_HEADER=true` and `X-Acting-User-Id`, and about 15 existing tests rely on them. The prompt says not to change existing endpoint behavior, so the spec's names are now primary and the old ones remain as a **deprecated alias**: either env var switches the mechanism on, either header is accepted, and `X-Dev-User` wins if both are sent. No existing test was edited. The alias can be removed in a later cleanup.
- **The production guard covers every way of turning the mechanism on.** `buildApp` throws ("Refusing to start") if it is on under `NODE_ENV=production`, whether via `AUTH_MODE=dev`, the deprecated `ALLOW_DEV_ACTOR_HEADER=true`, or an explicit option. The spec only named `AUTH_MODE=dev`. Leaving the old switch unguarded would have kept exactly the hole the guard exists to close.
- Only `AUTH_MODE=dev` enables anything. Any other value (for example `google`, the eventual real mode) leaves the mechanism off, which is the safe default.
- `/me` `name` is nullable, because users created by invitation have no name until they set one. The UI should fall back to the email.
- `/me` lists only roles belonging to the user's own organization, the same rule the permission engine applies, so a stray cross-org role assignment cannot show up.
- The option name `purchaseOrders` on `AppOptions` was misleading (it configures actor resolution for every route). New name `actor`; the old one is kept as an alias so no caller changes.

**Tests:** 14 new in `tests/me.test.ts` (superadmin, normal user with sorted roles, org admin, cross-org role exclusion, 401 cases, 403 inactive, both headers and precedence, `AUTH_MODE` values, the deprecated switch, refusal to start under production for all three ways of enabling, normal production start, `/dev/users` on and off). Full suite: **220 of 220**.

---

## 2026-09-19, UI-1 step 2: `npm run seed:dev`

**Built**
- `src/dev/seedDev.ts` and `scripts/seed-dev.ts`, wired as `npm run seed:dev`. Everything is labelled "Sample". Refuses to run unless `DATABASE_URL` points at this machine. Idempotent: if the sample superadmin exists it says so and changes nothing.
- One superadmin; an importer, three exporters (Alpha, Bravo, Charlie), a logistics org, and a lab_cert org, all created through `proposeOrganization` and `approveOrganization`, so each has the five standard roles, an Organization Admin first user, and real audit rows. A second importer user holds only the Viewer role (made through `inviteUser`, then set active, since nothing yet performs the invited-to-active step).
- 100 `document_permission_rules` rows: every org type (all five, including `data_source`), every standard role, every document type, view level only, every grant false.
- Five consignments made through the real `submitPurchaseOrder` flow, in different states: `checklist_pending` (a core client that accepts but sends no checklist, as live core would), `checklist_received` with two unresolved issues (one `open`, one `correction_requested`), `active` with a resolved issue in its history, `completed`, and `cancelled`.
- `STUB_CHECKLIST_DOCUMENTS` is now exported from `src/core/client.ts` and used by both the stub client and the seed, so the seed cannot drift from the stub. Behavior of the stub is unchanged.

**Decisions**
- Document types are exactly the stub's four, with `category` null, as the prompt directs. A comment at the top of the seed says these are stub data pending the authoritative list.
- The permission matrix is illustrative, chosen so the UI meets full, status_only, and hidden (for example logistics sees the Bill of Lading in full and the Export Health Certificate not at all; the Viewer role is status_only). It is labelled as sample data; the real matrix comes from the pilot Scope of Work Section 7.
- `seed:dev` reports "already present" rather than resetting. If a seed fails halfway the sandbox should be reset. The services own their transactions, so the whole seed is not one transaction.
- The safety guard compares the parsed hostname exactly (`localhost`, `127.0.0.1`, `::1`), so a host that merely starts with "localhost" (such as `localhost.evil.com`) is refused.

**Found while running it: a conflict with an earlier script (recorded as an open item for Thomas, not changed).** The dev database was already seeded by `npm run db:seed` (stage 1), which gave the four document types the categories "Customs & logistics" and "Certifications". Those were never confirmed. UI-1 says not to invent categories and UI-2 groups the roadmap by category, so on this database the UI would present them as real. `seed:dev` deliberately leaves existing rows alone, so they remain. Choices for Thomas are in the open item in `docs/PROJECT_MEMORY.md`. Per the standing ask-before-pattern-fix rule this was not changed unasked.

**Test gap found by mutation and fixed.** Removing the local-only guard from `seedDev()` left every test green, because the guard was tested in isolation but not shown to be called. Added a test that `seedDev()` refuses a non-local `DATABASE_URL` before writing anything. The other mutations (grants set true, a category invented, the idempotency check removed) were caught.

**Verified:** seeded the real local dev database (1 user and 0 orgs before; 9 users, 6 orgs, 5 consignments, 3 issues, 100 rules after) and ran it a second time to confirm the idempotent message.

**Tests:** 13 new in `tests/seedDev.test.ts`. Full suite: **233 of 233**.

---

## 2026-09-19, UI-1 step 3: `GET /consignments/:consignmentId`

**Built**
- `getConsignmentDetail` in `src/services/consignmentViews.ts` and the route in `src/http/views.ts`. Returns `{ id, status, commodity, hsCode, originCountry, destinationCountry, importerOrg: { id, name }, exporterOrg: { id, name }, createdAt }`.

**Behavior and decisions**
- Same authorization and the same 404 choice as the checklist endpoint: superadmin, or an active user of the importer or exporter org. Anyone else gets a 404 whose body is identical to the one for a consignment that does not exist (so the two cannot be told apart). A malformed id is 404. No acting user is 401, an inactive user is 403.
- Only fields the schema has. There is no quantity, so none is offered (the mockup shows one; the prompt says the UI must not). A test asserts a list of tempting extra fields is absent. `hsCode` is null when there is none.
- The route `/consignments/:consignmentId` sits beside `/consignments/:consignmentId/checklist`. A test confirms both resolve.

**Tests:** 6 new in `tests/consignmentDetail.test.ts`. Mutation-checked: removing the party check (a stranger could read) and adding an extra field are each caught. Full suite: **239 of 239**.

---

## 2026-09-19, UI-1 step 4: `GET /action-queue`

**Built**
- `getActionQueue` in `src/services/consignmentViews.ts` and the route in `src/http/views.ts`. Returns `{ orgId, items: [{ consignmentId, consignmentLabel, documentTypeName, requiredBy, status, issueId, responsibleOrgType, actionableByMyOrg }] }`.
- A shared helper `resolveViewedOrg` (own org for ordinary users, `?orgId=` for superadmin), extracted from the workload endpoint so the two cannot diverge. The 37 existing view tests passed unchanged after the extraction.
- `scenario()` in `tests/helpers.ts`: a consignment with the stub's four documents addressable by name, shared by the new tests.

**Behavior**
- Items across the org's live consignments (not completed, not cancelled), with status `flagged` or `awaiting_upload` only. Pending and verified items are not action items.
- Visibility is the checklist's: hidden items are omitted; full items carry `issueId` (the longest-standing unresolved issue) and `responsibleOrgType`.
- `actionableByMyOrg`: for `awaiting_upload`, the viewed org's type equals `requiredBy`; for `flagged`, it equals the issue's `responsibleOrgType`. For superadmin viewing an org, "my org" is the org being viewed.
- Order: flagged first, then `awaiting_upload`, then newest consignment first, then document name. No due dates, no "overdue".

**Decisions the prompt left open**
- **`status_only` items have `requiredBy` null and are never actionable.** The prompt says status_only items appear "with status only and null issueId and null responsibleOrgType". `requiredBy` is not in that list, but the checklist endpoint withholds `requiredBy` from a status_only viewer, so returning it here would leak what the checklist hides. And `actionableByMyOrg` cannot be computed for such an item without using that hidden value, so it is false. A test asserts the item is sealed and its issue text appears nowhere in the response.
- **`consignmentLabel` is `"<commodity>, <origin> to <destination>"`** (for example "Frozen beef, BR to GB"). Consignments have no reference number or name to show, and the prompt does not define the label.
- **Superadmin must pass `?orgId=`** (400 if missing or malformed, 404 if unknown), consistent with the workload endpoint. An ordinary user's `orgId` is ignored so it cannot be used to look at another org.
- A `flagged` item with no unresolved issue (a data anomaly) is returned as flagged with a null issue and is not actionable, rather than being dropped.

**Tests:** 16 new in `tests/actionQueue.test.ts`. Mutation-checked, each caught: `requiredBy` leaking on a status_only item; hidden items included; the flagged actionable rule using `requiredBy`; wrong sort order; finished consignments included; status_only items marked actionable; an ordinary user's `orgId` honoured. Full suite: **255 of 255**.

---

## 2026-09-19, UI-1 step 5: issue detail and actions

**Built**
- `src/services/issueViews.ts`: `getIssueDetail`, and the two gates `assertCanActOnIssue` and `assertCanRaiseIssueOn`. `src/http/issues.ts`: the four routes. Registered in `src/http/app.ts`.
- `GET /issues/:issueId`: `id, consignmentId, status, problem, expectedValue, foundValue, responsibleOrgType, responsibleOrgName, checklistItem { id, documentTypeName, category, requiredBy }, sourceDocumentTypeName, createdAt, resolvedAt, availableActions, activity[]`.
- `POST /issues/:issueId/request-correction` (body `{ message }`), `POST /issues/:issueId/resolve`, `POST /consignments/:consignmentId/checklist/:itemId/issues` (body `{ problem, expectedValue?, foundValue?, sourceChecklistItemId?, responsibleOrgType }`, 201). Thin wrappers over `requestCorrection`, `resolveIssue`, and `raiseIssue`, each answering with the refreshed issue so the UI can update in place. No comment endpoint, as the prompt says.

**The one access rule.** You can see or act on an issue only if you are a party to its consignment AND your role sees the parent document at **full** view. Anything else is a 404 identical to an issue that does not exist. This is exactly what the prompt specifies for the GET ("otherwise 404"); it is applied to all four endpoints.

**Decisions the prompt left open**
- **The action endpoints apply the same gate as the GET.** The prompt says the actions are "thin wrappers" and states the visibility rule only for the GET. Without the gate on the actions, a `status_only` viewer (who is shown an item's id in the checklist) could use the API to raise, resolve, or request correction on a document they may only see the status of, and could learn an issue exists from the differing response. So a rejected attempt is a 404, changes nothing, and writes no audit row (tested).
- **The gate lives at the HTTP boundary; the services are unchanged.** `raiseIssue`, `requestCorrection`, and `resolveIssue` still check only that the actor's org is a party. That is the open item from stage 3 and it is deliberately not changed here (the prompt says not to alter existing behavior, and the standing rule is to ask before fixing). The gate is documented in `issueViews.ts` and any new caller must apply it. `docs/PROJECT_MEMORY.md` now describes exactly this split.
- **`availableActions: { requestCorrection, resolve }` was added to the GET.** The UI-2 prompt says to show those buttons "only to users the API allows to act". Since the gate already guarantees the viewer is a permitted actor, both are true exactly when the issue is unresolved.
- **`responsibleOrgName`** is the party org whose type equals `responsibleOrgType` on that consignment (the importer or the exporter). It is null when the responsible type is neither (for example `logistics`). The prompt calls it nullable without defining it.
- **`sourceDocumentTypeName` is null when the source document is hidden from the viewer** (the same rule as the checklist endpoint), and named when it is only `status_only`.
- **Activity actor names.** The prompt says "actor display name or 'System'". A user with no name is shown by email only to colleagues in the same organization; to the other party they appear as "A user at <organization>", so one party never receives the other's contact details. A superadmin with no name shows as "VeriPura". `metadata.message` is included only when it is a non-empty string.
- `checklistItem.id` and `consignmentId` were added so the UI can link back; they are opaque ids.

**Tests:** 21 new in `tests/issueApi.test.ts`, covering every item in the prompt's list for this step (404 when the parent item is status_only or hidden, the action endpoints' audit rows with the right actor and metadata) plus validation, 401/403, the activity list, and agreement with the checklist and action queue. Mutation-checked, each caught: the gate ignoring the view level; ignoring party membership; each of the three action endpoints skipping the gate; another org's email leaking into the activity list; a hidden source document being named; actions always offered. One assertion of mine was a tautology and was replaced with the plain expectation. Full suite: **276 of 276**.

---

## 2026-09-19, UI-1 step 6: organization directory and superadmin endpoints

**Built**
- `src/services/adminOrgs.ts`, `src/http/admin.ts`, and `src/http/emptyBody.ts`; routes registered in `src/http/app.ts`.
- `GET /organizations/exporters`: active exporter-type organizations as `{ id, name }`, sorted by name, answered as `{ organizations: [...] }`. Available to any active user of an importer organization and to superadmin; everyone else gets 403.
- Superadmin only (403 for anyone else, 401 with no user): `GET /admin/organizations?status=...`, `GET /admin/organizations/:id`, `POST /admin/organizations/:id/approve`, `POST /admin/organizations/:id/reject`. Approve and reject wrap `approveOrganization` and `rejectOrganization` and answer with the refreshed organization. No applicant country, because the schema has none.

**Decisions the prompt left open**
- **Roles on a pending organization.** The prompt asks for "the five standard roles with the default permission summary", but a pending organization has no `org_roles` rows (they are created on approval). So the roles come from the standard role set (`STANDARD_ROLES`, with `isOrgAdmin`), and each role's permissions come from `document_permission_rules` for that organization's type. For every document type with no rule the entry is `{ configured: false, viewLevel: null, canEdit: false, canDownload: false, canApprove: false }`, so the UI can show "not configured". Nothing is defaulted or invented (tested: an unconfigured cell is never `full`). All document types are listed, so a gap is visible.
- `createdAt`, not `created_at`, to match the rest of the API's camelCase (the prompt mixes styles).
- The list is oldest first, so the approval queue is first come, first served. `?status` is optional (no filter returns every organization) and an unknown value is a 400, not an empty list.
- `applicant` is the organization's first (earliest created) user, the same rule `approveOrganization` uses to pick the first user.
- A malformed organization id is a 404, like an unknown one. The tests caught that approve or reject with a malformed id returned a 500 (the id reached Postgres); fixed in the new route before commit.

**A second finding: body-less POSTs (fixed for the new endpoints).** Probing with `POST /issues/nope/resolve` (a JSON content type and no body) returned 400 from Fastify before the handler ran. A UI calling `resolve`, `approve`, or `reject` with a plain `fetch` and a JSON content type does exactly that. `ignoreEmptyJsonBody` drops the content type of a genuinely empty request so those endpoints work. Fastify's own JSON parser is deliberately left in place because it guards against prototype-poisoning payloads and a replacement would lose that. Applied to the issue and admin plugins (so `src/http/issues.ts` from step 5 changed in this commit); a malformed body is still a 400, and endpoints that need a body still refuse an empty one.

**A pattern check, as the standing rule requires (recorded as an open item, not fixed).** After the malformed-id 500, every existing route was probed. The checklist, consignment detail, issue, workload, and admin routes are fine. `POST /purchase-orders` (stage 2) returns 500 when only `exporterOrgId` is malformed. It was left unchanged and is listed in `docs/PROJECT_MEMORY.md` with the small fix and its implication for Thomas to decide.

**Tests:** 19 new in `tests/adminApi.test.ts`, 2 added to `tests/issueApi.test.ts` (body-less requests). Mutation-checked: non-importers listing exporters; non-active exporters listed; an unconfigured permission invented; rules of other org types used; an unknown status accepted; the admin list open to non-superadmins; the empty-body tolerance removed. Each caught. One survived and is an equivalent mutant: removing the route's superadmin check on approve changes nothing observable because `approveOrganization` refuses non-superadmins itself (two independent guards); the "403 on every /admin route" test covers the behavior. Full suite: **297 of 297**.

---

## 2026-09-19, UI-1 step 7: `POST /consignments` (multipart)

**Built**
- `src/http/consignments.ts` (registered in `src/http/app.ts`) and the dependency `@fastify/multipart` 10.1.1 (compatible with the installed Fastify 5; `npm audit` shows the same 4 dev-only drizzle-kit findings as before and nothing from the new package).
- `POST /consignments` accepts `multipart/form-data` with `exporterOrgId`, `commodity`, `originCountry`, `destinationCountry`, optional `hsCode`, and one file in a field named `file`. It is a thin wrapper over `submitPurchaseOrder` and answers 201 with `{ consignment }` in the consignment detail shape, so the UI can go straight to the roadmap.

**Behavior and decisions**
- **The importer is derived from the acting user's organization.** A submitted `importerOrgId` is ignored for ordinary users (tested: they cannot submit for another importer). Superadmin has no organization, so must name the importer with `importerOrgId` (400 if missing or malformed).
- **Only importer-organization users (and superadmin) may submit: 403 otherwise.** Without this explicit check an exporter user would pass `submitPurchaseOrder`'s authorization (their own org id equals the derived importer id) and be turned away later with a 400, which is the wrong signal.
- **Every id is validated up front** (a malformed `exporterOrgId` is a 400, never the 500 that the older `POST /purchase-orders` gives; that older route is listed as an open item, unchanged). Blank text fields, a missing or empty file, a file in a differently named field, and a non-multipart request are each a 400. A file over 15 MB is a 413. The stored file name is sanitized by the existing storage layer (tested with `../../etc/passwd`).
- Core failure behaves exactly as on the JSON route: the PO and consignment are kept in `po_submitted` and the response is 502 with the saved consignment id.
- The older `POST /purchase-orders` (JSON, base64) is untouched and tested beside the new route. The prompt says to add the endpoint only "if it does not already wrap `submitPurchaseOrder`"; the existing route does, but as JSON with an explicit `importerOrgId`, not multipart with the importer derived, which is what UI-2's upload form needs.

**Tests:** 19 new in `tests/consignmentCreate.test.ts`, using hand-built multipart bodies. Mutation-checked, each caught: the importer taken from the request body; the importer-organization check removed; the exporter id unvalidated; superadmin not required to name the importer; no size limit; any file field name accepted; non-multipart requests not refused. One survived and is an equivalent mutant: removing the route's empty-file check changes nothing because `submitPurchaseOrder` rejects an empty file too (two independent guards). A test-helper bug of mine (an `undefined` argument falling back to the default file, so the "no file" case sent a file) was caught by the tests and fixed. Full suite: **316 of 316**.

---

## 2026-09-19, UI-1 step 8: tests, and verification of the whole stage

**Coverage of the prompt's list.** Each item was checked against a specific test rather than assumed:
- `/me` for a superadmin, a normal user, and an unauthenticated request: `tests/me.test.ts`.
- The server refusing to start with `AUTH_MODE=dev` and `NODE_ENV=production`: `tests/me.test.ts` (also for the deprecated switch and for an explicit option).
- `/action-queue` omitting hidden items, hiding issue detail for status_only items, `actionableByMyOrg`, and flagged before awaiting_upload: `tests/actionQueue.test.ts`.
- `/issues/:id` returning 404 when the parent item is status_only or hidden: `tests/issueApi.test.ts`.
- The issue action endpoints writing the expected audit rows: `tests/issueApi.test.ts`.
- Admin endpoints returning 403 for a non-superadmin, and approval creating the five roles: `tests/adminApi.test.ts`.
- `/organizations/exporters` excluding non-active and non-exporter organizations: `tests/adminApi.test.ts`.
- Consignment detail following the checklist's 404/403 rules: `tests/consignmentDetail.test.ts`.

**Added in this step:** `tests/uiJourney.test.ts` (8 tests), which walks the API the way the UI will, over the seeded sample data: the dev switcher and `/me`; the importer's dashboard (five consignments, an action queue whose flagged items open as issues); working an issue open, correction requested, resolved with the queue following, including a body-less POST; the exporter's side; the importer's Viewer sealed to status only with issues a 404; the logistics org shut out; a purchase order submitted through the multipart form appearing everywhere it should; and a superadmin approving a new organization that then appears in the importer's exporter list. `multipartForm` moved into `tests/helpers.ts` and is shared with `tests/consignmentCreate.test.ts`.

**Verified against the real server, not only `inject`.** With the seeded dev database, the server was started on a real port and called over HTTP: `/dev/users` (9 users), `/me`, five consignments, an action queue whose first item is flagged, an issue with its activity and available actions, the exporter list for the PO form, the Viewer's queue with nothing exposed, the superadmin list, 403 for an importer on `/admin/organizations`, 401 with no user, and real multipart parsing over the socket (two deliberately invalid submissions returned 400 and created nothing). No server errors were logged.

**Finding from that run: port 3000 is taken on this machine.** The first attempt returned an HTML page, because a Next.js dev server (the tower demo) already listens on port 3000 and the requests were reaching it. Even the first `/health` "success" was from the wrong server. The default port is now **3100** (`src/server.ts`, `.env.example`, README, `docs/PROJECT_MEMORY.md`, and the local `.env`), the same way Postgres uses 5433. UI-2's dev proxy should target 3100.

**Repository hygiene found and fixed.** `.vitest/json/output.json` (a 19 KB test-report file) had been committed and pushed since stage 1. It was written when a JSON reporter was first tried for counting tests per file, in a commit made before explicit-path staging became the rule. Contents are only test names and results (no secrets). It is now untracked and `.vitest/` is gitignored. It remains in pushed history; rewriting shared history for that was judged not worth it.

**Open items raised by this stage (also in `docs/PROJECT_MEMORY.md`)**
- Decision for Thomas: `db:seed` invented document categories that `seed:dev` (correctly) leaves alone, so the dev database still carries them.
- Decision for Thomas: `POST /purchase-orders` returns 500 for a malformed `exporterOrgId`; a small fix, not made unasked.
- The issue-visibility gate lives at the HTTP boundary, and the service functions beneath it still check only party membership.
- `GET /dev/users` and the `AUTH_MODE=dev` header must not exist in production. The server refuses to start with the mechanism on under `NODE_ENV=production`, but real sign-in is still needed before any real user.

**Equivalent mutants recorded during the stage** (two independent guards enforce the same rule, so removing one changes nothing observable; the behavior is covered by the tests): status_only items in `openIssueCount` (issues are never loaded for them), the route-level superadmin check on approve (the service checks too), and the route-level empty-file check (the service checks too).

**Verification**
- Full suite from a freshly dropped and recreated test database: see the count in `docs/PROJECT_MEMORY.md` (324), confirmed by `npm run memory:check -- --full`, which runs the whole suite and compares.
- `tsc --noEmit` clean. No em dashes in any file. `npm audit`: the same 4 dev-only drizzle-kit findings as before, nothing new.

**UI-1 status:** complete. The eight items are built, each mutation-checked, and verified against the real server. UI-2 (the web app) is next and has not been started.

---

# UI-2: the web app

Source: `docs/veripura-cli-ui-prompts.md`, Prompt UI-2 (seven numbered steps). The app lives in `web/`, its own package with its own tests, so the backend's dependencies and suite are untouched. The backend suite and the web suite are counted together in `docs/PROJECT_MEMORY.md`.

**The spec changed while this stage was being built.** The UI-2 prompt I was given said to build the dashboard map as a self-contained SVG with "no tile server, no external map service", projecting land data with d3-geo at build time. Partway through step 1 the prompts file on disk was rewritten (14:43): "of 2" became "of 3", a UI-3 vessel-tracking prompt was added, and the UI-2 map section now asks for Leaflet from npm with CARTO basemap tiles, an offline Natural Earth fallback layer, required attribution, and a `web/src/map/tiles.ts` file so the provider can be swapped. The Dashboard mockup and its two PNGs were regenerated to match. The two instructions contradict each other on the map only. The rewritten file is the newer and more specific statement, with its own reasoning and licensing notes, so the **map follows the newer file**. Steps 1 and 3 to 6 are identical in both. If the SVG approach was still wanted, only step 2 changes.

## 2026-09-19, UI-2 step 1: app shell and theme

**Built**
- `web/`: Vite 8, React 19, TypeScript, React Router 7, TanStack Query 5, Vitest 5 and Testing Library. Plain CSS, no component library or framework. The dev server runs on 5173 and proxies `/api` to the backend on 3100 (the prefix is stripped, so the backend needed no change).
- `web/src/styles/tokens.css`: the mockups' token block, extracted **by script from the mockup file**, not retyped. All five mockups carry a byte-identical block (checked by hash). The six dark values the prompt names match exactly. Three extras that the mockup writes as literals are now tokens so no component needs a hard-coded colour: `--on-solid` (white), `--avatar-blue`, and `--scrim` (the modal's dimmed backdrop). Font stacks are tokens too.
- Theme: `vp-theme` in localStorage, every access in try/catch, applied before first paint by a small inline script in `index.html` (no flash), and shared across every toggle on a page. Label is what it will switch to, as in the mockups.
- Fonts are **bundled** (`@fontsource/dm-serif-display`, `@fontsource-variable/source-serif-4`), not loaded from Google as the mockups do. No outside request, works offline, no privacy leak. The mockup's `IBM Plex Mono` for organization tags was named but never loaded, so it always rendered as the system monospace; the app uses that stack.
- Shared components: Badge, OrgTypeTag, Card, StatCard, ThemeToggle, EmptyState, ErrorState, LoadingSkeleton, plus Modal and DisabledAction (a natively disabled button whose tooltip lives on a wrapper, since browsers do not reliably show a tooltip on a disabled button).
- Layout: the left sidebar (name and organization from `GET /me`) and the top bar for the superadmin console. Routes: `/` (a superadmin is redirected to `/admin`), `/admin` (a non-superadmin is redirected to `/`).
- API layer: a small client (`/api`, an `ApiError` with the status), types copied from the backend's read models, and query hooks. Retries are skipped for answers the server already gave.
- Development user switching: a picker when nobody is chosen (a 401 from `/me`), then a corner select. `X-Dev-User` is sent on every request in development. All of it is lazy and behind `import.meta.env.DEV`.

**Decisions the prompt left open**
- **Sidebar entries.** Dashboard and Consignments (a link to the dashboard's consignment list) lead somewhere. Parties, Issues, Documents, and Settings have no screen and no spec, so they are shown **disabled with a reason** rather than linking to a page that does not exist, the same treatment the prompt gives Upload and Nudge. Say if you would rather have real pages for Parties (the workload endpoint exists) and Issues.
- **A superadmin lands on the console.** The backend refuses the dashboard's data without an organization (`/action-queue` and `/parties/workload` need `?orgId=`), so there is nothing to show them there.
- **Sizes under 14px raised to 14px.** The mockups use 12px (the placeholder flag) and 13px (table headers, org chips). The prompt says nothing under 14px, and a test enforces it, including inline styles.
- **Production with no sign-in** says "Sign-in is not available yet" instead of offering sample users, because real sign-in is a later stage.

**Findings while building**
- **A production build under the test runner is not a production build.** Vite decides "production" from `NODE_ENV`, and Vitest sets it to `test`, so an in-process `vite build` kept the dev switcher in the bundle. The test that a production bundle has no dev tooling initially failed for that reason. Its positive control (a development build must contain the markers) is what made the cause clear. The test now runs `vite build` in a child process with `NODE_ENV` set, and with default minification, since an unminified build keeps comments that mention the very names being searched for. A real `vite build` was checked separately and is clean.
- **A focus bug in my own Modal, fixed before commit.** The effect depended on `onClose`, so a parent passing an inline function would re-run it on every keystroke and pull focus away while typing. `onClose` is now held in a ref. The first test did not catch the regression (focus returns within the same render, so the end state looks fine); the test now watches for the `blur` event itself.
- **Mistakes of mine caught by the checks:** a fixture that returned an object my mock layer does not understand; a comment containing a hex-like example that tripped the no-hard-coded-colour guard; a sidebar CSS selector that targeted the wrong element. All fixed.

**Repository tooling changed to match**
- `scripts/memory-check.mjs` now counts `web/` as code (so a web change needs the docs updated) and its `--full` audit runs both suites and sums them. `tests/memoryCheck.test.ts` gained three cases for it. New root scripts: `web:install`, `web:dev`, `web:build`, `web:test`, `typecheck:web`, `test:all`.
- `docs/veripura-cli-ui-prompts.md` (Thomas's edited spec) is committed as the specification of record.

**Tests:** 66 web tests in seven files (theme toggle, shell and routing, the superadmin guard, the dev switcher in development and production, shared components, design tokens, the grep-style hygiene guards, and a real production build with a positive control). Mutation-checked: theme not persisting, the toggle label reversed, the superadmin guard removed, the switcher rendering outside development, the dev header sent outside development, production offering the picker, the sidebar hiding the organization, a superadmin not redirected, the Modal focus regression, a dark token drifting toward brown, a disabled action becoming clickable, and a hard-coded hex in a component. Eleven were caught first time; the Modal one survived until the test watched for `blur`, then was caught. Backend suite: 327 (three new memory-check cases). **Total: 393.**

## 2026-09-19, UI-2 step 2: dashboard

**Built**
- **Backend, additive:** `GET /consignments` now also returns `originCountry` and `destinationCountry` (data the row already held), for the dashboard's route column. Two new tests in `tests/webFields.test.ts`, including one that pins the summary's exact set of keys so nothing else slips in. The roadmap step will need one more small addition (`issueId` on a checklist item's open issue, so a flagged row can link to its issue); the action queue already carries `issueId`.
- **Dashboard** (`web/src/screens/Dashboard.tsx` and `web/src/screens/dashboard/`): the attention band (only when a live consignment has open issues; links to the first flagged issue from the queue, else to the first consignment with an issue), four stat cards, the action queue with All / Needs my org / Waiting on others chips and a live count, and the consignment list. Stat cards come from the consignment list (active, open issues, average completeness) and `GET /parties/workload` (the parties card, worded from the viewer's organization type: exporter parties for an importer, importer parties for an exporter). Finished consignments are left out of every figure and listed under their own heading. Average completeness is the mean of each live consignment's own share, and consignments with no checklist yet are left out of it rather than counted as 0%. Each section handles loading, empty and error on its own, so a failing queue does not take the page down.
- **Upload and Nudge party** are rendered natively disabled with a tooltip and a screen-reader reason. A flagged row has "View issue" only. Document names come from the API, never from the app.
- **Map** (`web/src/map/`, `web/src/sample/mapSample.ts`), following the newer prompt: Leaflet 1.9 from npm with its CSS imported, CARTO tiles chosen by the theme and swapped by a `MutationObserver` on `<html class>`, all provider details in `tiles.ts`, an offline Natural Earth 110m land layer (world-atlas, bundled) in a pane under the tiles, scroll-wheel zoom off, zoom buttons on, minimum zoom 2, vessel markers as `divIcon`s (open issue, on track, cleared, and a hollow dashed one for a position older than three hours), route arcs between sample ports drawn as great circles, no Leaflet default marker image, no key. The map is a separate chunk (Leaflet is about 70 KB gzipped) loaded only when the dashboard shows.
- **The credit is drawn by the app, not by Leaflet**, so no Leaflet option can drop it: "OpenStreetMap contributors, CARTO" as links, always visible in the corner of the map. The tile layer also carries the same text in its own `attribution` option. "Sample positions" is always shown while the data comes from the sample file, and the info line adds "(sample)".
- Tokens added for map furniture (`--map-ring-shadow`, `--map-stale-fill`, `--attr-bg`, `--attr-ink`, `--attr-link`) so the map has no hard-coded colour; the zoom buttons are themed with tokens too.

**Deliberate differences from the mockup**
- "Live consignment map" with a blinking green dot and "Live view" is now **"Consignment map"** with no dot. Nothing is live: the positions are illustrative, and a blinking "live" indicator next to made-up positions says the opposite of the flag beside it.
- No "Open roadmap" link on the map's info line. The map's vessels are samples, not consignments, so there is nothing to open. Sample ids read "Sample A" to "Sample D" so nobody mistakes one for a consignment reference.
- The "Sample positions" flag is 14px, not the mockup's 12px (nothing under 14px).
- The map's zoom buttons take the theme (paper, charcoal) instead of Leaflet's white in both themes.
- "+ New Consignment" is absent for now; it arrives with the intake screen (step 5). The rows are links to `/consignments/:id` and the queue links to `/issues/:id`, which are routed in steps 3 and 4.
- The queue rows also show each consignment's label ("Chilled beef, BR to GB"), because consignments have no human-readable number and a row of "#AE8192AC . Packing List" alone does not say which shipment it is.

**Finding: CARTO now watermarks the spec'd tiles.** In the real browser both themes drew "API KEY REQUIRED carto.com/basemaps/apikey" across the map. A direct download of one tile from `rastertiles/voyager` (HTTP 200, 7 KB) shows the same watermark, so it is the provider, not the app; `dark_all` does the same. The prompt says no paid key. I did not change provider unasked. It is a decision for Thomas, recorded in `docs/PROJECT_MEMORY.md`, and because everything provider-specific is in `web/src/map/tiles.ts` any choice is a one-file change: get a CARTO key, use another provider, or run on the bundled land layer alone (which is already there underneath, and would show as soon as the tiles were removed).

**Verified in a real browser** (Vite dev server proxying the real backend on the seeded database, importer admin): the dashboard renders in light and dark; the theme toggle swaps to `dark_all@2x` tiles and back and persists `vp-theme`; the queue, attention band, stat cards, markers, labels, legend and credit all render; the proxy returns the new `originCountry` fields. The browser session then began timing out on screenshots (the machine was short of memory), so the consignment list at the foot of the page was checked only in the test suite and in a partial screenshot, and the mobile width was not checked in a browser.

**Findings while building**
- Leaflet's own markers carry `role="button"` and the vessel's title, so a chip and a marker share an accessible name; tests scope to the chip group.
- Leaflet decides at import time whether it can draw vector lines, and jsdom cannot, so the test setup gives `SVGElement` a `createSVGRect`. The tile layer is replaced in tests by a recorder that returns an empty layer group, so no test touches the network. The map chunk is slow to transform the first time, so the Testing Library async timeout is raised to 8 s.
- A stray literal no-break space, from writing a unicode escape through a file tool, was replaced by a `min-height` on the subtitle.

**Tests:** 63 new web tests (129 web in ten files): the dashboard's figures, attention band, queue filters and count, disabled actions, list rows, empty, loading and error states; the map's credit, sample flag, tile swap on theme toggle, removal of the old tile layer, markers, routes, fallback land, selection and legend; the great-circle helpers; the sample data's honesty; and the pure model. Backend 329 (two new). **Total: 458**, confirmed by `node scripts/memory-check.mjs --full`.

**Mutation check: incomplete, and stated as such.** A 28-mutant run was started (tiles swapped by theme, theme observer removed, old tile layer kept, credit dropped, flag dropped, "live" wording returned, default marker, hollow marker never drawn, selection not styled, stale threshold off by one, mine filter inverted, finished counted as active, pooled average, zero-checklist counted as 0%, attention band always shown or counting finished, Upload or Nudge enabled, count ignoring the filter, wrong issue link, no plural, raw country code, issue badge always red, counterparty noun fixed, sample ids looking real, scroll to hash removed). The system stopped it for low memory partway through, its results were not saved, and it left one mutant in place (the attention band's zero guard). That was found by checking every mutated pattern afterwards and restored, and the full suite was re-run green. **The tests' ability to catch those faults is therefore not yet demonstrated.** The run was not restarted, on the system's advice; it should be re-run when memory allows.

**Not staged:** `docs/veripura-cli-ui-prompts.md` has a new edit from Thomas (the UI-3 section now specifies VesselAPI with a 150-call monthly budget). It changes nothing for UI-2 and is left for Thomas to commit.

## 2026-09-19, UI-2 step 3: roadmap

**Built**
- **Backend, additive:** a checklist item's `openIssue` now carries `issueId`, so a flagged row can link to its issue (the action queue already did). Two new tests in `tests/webFields.test.ts`: the id names the right issue and opens it through `GET /issues/:id`, an item with no open issue has none, and a status_only viewer's item has no `openIssue` and no `issueId` anywhere in its JSON.
- **Roadmap** at `/consignments/:consignmentId` (`web/src/screens/Roadmap.tsx`, `web/src/screens/roadmap/`), standalone with no sidebar, as in the mockup. Header from `GET /consignments/:id`: the reference, commodity and route, seller, buyer, HS code (left out when the consignment has none), product, status, created date. No quantity, since none exists. One tab, Compliance Roadmap. The checklist comes from `GET /consignments/:id/checklist`.
- **Grouping is by the category the API returns**, never by a list in the app. Named categories are sorted alphabetically (so the order does not depend on how the server returns rows), then **Uncategorised** for a full item with no category, then **Limited access** for status_only items. Each heading shows its count.
- **Rendered strictly from the flags.** A status_only item shows its name and status and nothing else: no tag, no category, no issue text, no buttons. A full item shows its name, who provides it (the tag), and its status. Upload appears only with `canEdit` and only for a document that is awaited or flagged; Download only with `canDownload` and only once there is a document; Approve only with `canApprove` and only for a document under review. All three are rendered disabled with a tooltip and a screen-reader reason, since upload, download and approval are later stages. A flagged document with an open issue is one link to `/issues/:issueId` (the whole row, as in the mockup) showing what is wrong, with no button nested inside it.
- Each part handles its own loading, empty and error state: a consignment the user cannot see shows "Not found" with a way back and no tabs; a checklist that fails leaves the header standing and offers a retry; an empty checklist says it has not arrived yet.

**Decisions the prompt left open**
- **Limited access** as the label for status_only items. The prompt says such items show no category, and "Uncategorised" would claim they have none, when in fact the viewer is not allowed to know.
- **Download and Approve as disabled seams**, because the prompt says the flags decide which buttons appear, and names only Upload. Their conditions are the smallest sensible ones (a document exists; a document is under review). If you would rather show only Upload until those stages, it is a two-line change in `web/src/screens/roadmap/model.ts`.
- **Omitted from the mockup**, per the prompt: the Guardian panel, the forensic view and its cryptographic-proof line, the ledger, registry and passport tabs, the "Document list pending" banner, the "Mandatory" badge (the schema has no such field), and every "Document name TBC" and "Category (name TBC)" placeholder. A test asserts none of them appear.

**Verification**
- 27 new web tests (156 web in eleven files): the header, the one tab and the excluded features, grouping and ordering, blank categories, tags and badges, the status_only view, every button's rule in both directions, flagged rows with and without an issue, loading, empty, 404 and retry.
- **Mutation check, complete this time:** 21 mutants, one at a time, in the foreground. Twenty were caught first time. One survived (Approve shown for any status once the flag is set) and a test was added that caught it. The mutants: each button ignoring its flag or its status rule, status_only items filed as uncategorised, categories unsorted, Uncategorised first, a blank category kept, a wrong issue link, a link for a flagged row with no issue, the problem text hidden, a tag on a status_only row, the status badge dropped, HS code always shown, an extra tab, each error and the empty state swallowed, raw country codes.
- Backend 331 (two new), web 156. **Total: 487**, confirmed by `node scripts/memory-check.mjs --full`. `vite build` is clean.
- **Not yet checked in a real browser.** The dev servers were stopped after step 2 because the machine was short of memory; the visual comparison of every screen against the PNGs, in both themes, is step 7.

**Step 2's mutation check is still incomplete** (see that entry). The dashboard's tests are unchanged since.

## 2026-09-19, UI-2 step 4: issue

**Built** (`web/src/screens/IssueScreen.tsx`, `web/src/screens/issue/`; no backend change this step)
- The issue at `/issues/:issueId`, standalone as in the mockup, from `GET /issues/:id`: the document in the title, a status pill, a back link to the consignment's roadmap, the three-stage stepper (Open, Correction requested, Resolved), the Problem card with Expected and Found boxes and the source document, the Activity list, the responsible-party card, and the checklist-item card. Every value comes from the API.
- **Buttons follow `availableActions` and nothing else.** Request Correction opens a dialog with a message field; an empty or blank message is refused on the screen (and the server refuses it too), and the message is trimmed before it is sent. Mark Resolved asks first in a dialog ("This closes the issue. It cannot be reopened."), because a resolved issue cannot be reopened, and it uses the app's own dialog because a native `confirm()` cannot be driven by browser automation. A resolved issue shows "This issue is resolved." and no buttons.
- **After an action** the answer (the issue as it now stands) goes straight into the cache, so the stepper, the pill, the buttons and the activity change at once, and everything that depends on the issue is marked stale: that consignment's checklist, the consignment list, the action queue, and party workload. Queries not on screen refetch the next time the dashboard or roadmap mounts, so those screens never show a stale count. Another consignment's checklist is left alone (a test pins that).
- While a request is in flight the send button and Cancel are disabled and Escape or a backdrop click cannot dismiss the dialog, so a request cannot be sent twice or abandoned half-way. A server refusal keeps the dialog open with the reason and the typed text; cancelling forgets the draft.
- **The comment box is not rendered** (messaging is deferred), and a test asserts there is no textbox on the page until a dialog opens.

**Deliberate differences from the mockup**
- "raised by VeriPura AI cross-check" is gone. Nothing records who or what raised an issue apart from the activity list, and AI extraction is out of scope, so the line now says "Attached to a checklist item, opened 2026-09-16" (and "and resolved ..." once it is).
- No "Guardian Assistant" author or AI avatar; every actor is an initials avatar in the app's blue token. Activity wording is plain ("Raised the issue", "Requested a correction", "Marked the issue resolved"); an action the app does not know is made readable rather than hidden.
- The responsible-party card shows the organization's name when the responsible type is one of the two trading parties; otherwise it shows the type ("Lab / Cert") and "Not one of the two trading parties". The mockup's "Coordinated via exporter" line is dropped, since nothing in the data says who coordinates.
- The checklist-item card shows the category (or "Uncategorised") and who it is required from, not "Mandatory".
- Expected or Found shows "Not stated" if only one of the two exists, and the pair is left out if neither does.

**Verification**
- 33 new web tests (189 web in twelve files): the header and back link, problem and values in every combination, both cards, the stepper in each status, activity (order, actor, time, message, empty), each button's rule, both dialogs (validation, trimming, success, server refusal, no double send, cancel), the cache and stale-marking after an action, loading, 404 and retry, and the exclusions.
- **Mutation check, complete:** 29 mutants, one at a time, in the foreground. Twenty-seven were caught first time. Two survived and were closed by tests: the correction button shown when only Resolve is allowed (no test had that combination), and an empty message being sent (the test mocked no route, so a stray call went unrecorded; the route is now mocked and the assertion also checks the field is flagged invalid). Both were re-run and caught.
- Backend 331, web 189. **Total: 520**, confirmed by `node scripts/memory-check.mjs --full`. `vite build` is clean.
- Not yet checked in a real browser (step 7 does the visual comparison of every screen).

**Still open from step 2:** its mutation check did not complete (see that entry) and the map tiles carry CARTO's "API KEY REQUIRED" watermark, a decision for Thomas.

## 2026-09-19, UI-2 step 5: intake

**Built** (`web/src/screens/Intake.tsx`, `web/src/screens/intake/`, `web/src/countries.ts`; no backend change this step)
- The purchase order form at `/consignments/new`, in the mockup's two-step layout: step 1 is the upload zone (drag and drop, or browse; one file), step 2 is the details card, and the gold submit button sits at the foot. Step 1 turns into the green "ready" card once a file is chosen, showing its name and size, with a button to choose a different one.
- Fields: the exporter (a select filled from `GET /organizations/exporters`), product description, origin and destination (selects), and an optional HS code. Submitted as multipart to `POST /consignments` with exactly the field names the backend reads; text is trimmed and a blank HS code is left out. On success the app opens the new consignment's roadmap, and the consignment lists (dashboard, action queue, party workload) are marked stale so they show it.
- **Checked before sending, with reasons in words:** every missing required field is named, focus goes to the first one that needs fixing, nothing is sent, and once the user has tried the messages update as they fix things. An empty file, or one over the backend's 15 MB limit, is reported the moment it is chosen (a bug in my first draft: that message was computed but never shown until a submit; a test caught it). The send button is disabled while a request is in flight.
- **A server refusal keeps everything typed** and shows why in plain words, so the user can fix and resend.
- **Only importers can start a consignment**, as the backend enforces: an exporter, or anyone else, sees "Only importers can start a consignment" and the page asks the API for nothing. The dashboard shows "+ New Consignment" only to importer organizations.
- Not present, per the prompt: any "AI-extracted" pill, the IOTA Tangle line, any claim that fields were filled automatically, the mockup's seller and quantity fields (the buyer is the user's own organization, shown in the heading; there is no quantity in the schema), and the "Continue to Compliance Roadmap" step (submitting does that). A test asserts none of those strings appear.

**A case worth knowing about: the purchase order can be saved and the request still fail.** `POST /consignments` answers 502 with the new consignment's id when the checklist service (VeriPura Core) cannot be reached: the order and consignment are kept, but no checklist arrived. Treating that as an ordinary error would invite the user to resubmit and create a second consignment, and no retry endpoint exists. So the screen recognises a 502 that names a consignment, says "Your purchase order was saved", warns not to submit again, links to the consignment, and removes the submit button; the lists are marked stale because the consignment exists. A 502 without an id is an ordinary error and the form stays. The roadmap for that consignment shows "No checklist yet".

**Decisions the prompt left open**
- **Countries are selects, not free text,** and store the ISO code, because the seeded data and the dashboard's route column already use codes. Only the 249 codes are in the app (`web/src/countries.ts`); the names come from the browser (`Intl.DisplayNames`), so no country name is written in the app. If free text was wanted (the backend accepts any text), it is a small change.
- **No file-type restriction.** The backend states none, so the app states none; it checks only that the file is not empty and not over the size limit.
- **The importer's own organization is shown, not asked for.** The backend derives it from the user; a submitted importer id is ignored.

**Verification**
- 27 new web tests (216 web in thirteen files): who can use it, what is not claimed, the option lists, exporter loading, empty and error states, the file step (chosen, dropped, several dropped, empty, oversized, the size limits), validation and focus order, the exact form sent and the redirect, the HS code left out, the lists marked stale, no double send, an ordinary refusal with the form kept, the 502 case in all three ways, the dashboard link for an importer and its absence for an exporter, and the country list and form helpers.
- Backend 331, web 216. **Total: 547**, confirmed by `node scripts/memory-check.mjs --full`. `vite build` is clean.
- **Mutation check: partly complete, and stated as such.** A 33-mutant run was started: each required field, the file size limits (both directions), each form field's name, trimming, the HS code rules, focus, live re-checking, sending despite errors, the importer-only guard, the redirect, the disabled button, several files at once, the 502 recognition and link, the error alert, immediate file errors, the empty and error exporter states, cache staleness, and the dashboard link. The system stopped the run for low memory after the first 31 (**all 31 caught, none survived**), and it left one mutant in place in `web/src/api/hooks.ts` (the one that skips marking lists stale after a successful submit). That was found by checking every mutated pattern and restored, and the full suite is green. **Three mutants were not run** (lists not stale on success, lists not stale on a 502, the dashboard link shown to everyone), so the tests' ability to catch those three is **not demonstrated**, though a test for each exists. As before, the run was not restarted on the system's advice.
- **Not yet checked in a real browser**: the drag-and-drop feel, the focus ring on the hidden file input, and the layout at narrow widths are for the step 7 visual pass.

**Still open from step 2:** its mutation check is incomplete and the map tiles carry CARTO's "API KEY REQUIRED" watermark, a decision for Thomas.

## 2026-09-19, UI-2 step 6: superadmin org approval

**Built** (`web/src/screens/AdminConsole.tsx`, `web/src/screens/admin/`, `web/src/layout/AdminLayout.tsx`; no backend change this step)
- The console at `/admin` (a superadmin lands here from the front page; anyone else is sent to the dashboard and never asks for the queue). The pending queue comes from `GET /admin/organizations?status=pending_approval`: organization, type as the coloured chip, the applicant's email, the submitted date, and a Review button. The first application is selected on arrival and the selection follows the list, so once an application is decided the next one appears.
- The detail panel comes from `GET /admin/organizations/:id`: name, application reference, type, contact, email, submitted date, status. **The permission table shows exactly what the API returns.** One row per role and document type, grouped under the role's name: the view level, and Yes or No for edit, download and approve. Where the view level is anything but full, the three grants do not apply and read **n/a** (never a dash; a test checks no cell is only a dash). Where the API says no rule is configured, the row says **Not configured** across the grant columns, and the panel says how many of the rules have none. A rule with no view level is treated as not configured however its flag reads, and nothing is defaulted or guessed. If there are no document types at all it says so instead of drawing an empty table.
- **Approve organization** and **Reject** each open a confirmation dialog first, with plain wording of what will happen (approval activates the organization and its first user and gives it the five standard roles with the permissions shown; rejection marks the application rejected). After the decision the panel announces it ("Applicant One was approved."), the organization leaves the queue, the top bar's "queue: N pending" count drops, and the list of exporters on the purchase order form is marked stale, because an approved exporter becomes choosable there. The dialog cannot be sent twice or dismissed while the request is in flight, and a refusal keeps it open with the reason and announces nothing as done.
- The top bar's pending count now comes from the same query as the queue, so it is always what the queue holds.

**Deliberate differences from the mockup**
- **No sample permission values**: the mockup's five role names and its Yes/No grid are not shown; every role, document and value comes from the API. The API returns rules per document type rather than one row per role, so the table has a row for each, grouped by role.
- **No "Country" field**: the organization has none in the schema. "Application #ORG-8842" is the organization's short reference ("Application #A1B2C3D4"), since no application number exists.
- The "Reviewing" and "Review" links are buttons with `aria-pressed`.

**Verification**
- 27 new web tests (243 web in fourteen files): the queue and its columns, the status filter, the top bar count, selection and switching, empty, loading and error states with retry, the applicant facts and n/a, the permission table cell by cell (including status only, not configured, no dashes, the count note, no document types, and no mockup sample values), the confirmations, approve and reject end to end (selection moving on, the notice, the count, the empty state after the last one), stale-marking of the pending list and the exporter directory, refusal, no double send, and who may see the page.
- **Mutation check, complete:** 25 mutants, one at a time, in the foreground (the permission grants shown for non-full views, each grant's n/a, unconfigured rules ignored or misjudged, a mislabelled view, n/a written as a dash, the count, the wrong queue, no first-application fallback, swapped or missing notice, the contact fallback, the not-configured colspan, the count note, the reject text, dismissal or sending while working, the admin suffix, the empty state, always calling approve, the pending list or exporters not marked stale, and the top bar count hidden or wrong). Twenty-four were caught first time. One survived (a rule with no view level not counted as unconfigured; my fixtures never had that combination) and a test now covers it; it was re-run and caught.
- **A flaky test, fixed:** in one full parallel run an intake test failed once and then passed in the audit and in ten further runs. The only unguarded ordering assumption in it was that the roadmap's own read had already been issued when the heading (rendered from the cache after submit) appeared, so under load the recorded call could be missing. That assertion now waits for the call. The cause is inferred from the code, not reproduced.
- Backend 331, web 243. **Total: 574**, confirmed by `node scripts/memory-check.mjs --full`. `vite build` is clean.
- Not yet checked in a real browser (step 7).

**Still open:** step 2's and step 5's mutation checks are incomplete (see those entries), and the map tiles carry CARTO's "API KEY REQUIRED" watermark, a decision for Thomas.
