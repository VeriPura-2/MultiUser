<!--
This is Thomas's original build specification for the VeriPura platform, saved verbatim so a cold
restart can read the source of truth. The only change from the original is punctuation: em dashes
were replaced with spaced hyphens, because this project has a no-em-dash rule. Do not edit the
content. If a later decision supersedes something here, record it in docs/PROJECT_MEMORY.md and
docs/build-log.md instead. Prompts 1 to 3 are built (see PROJECT_MEMORY.md). Prompt 4 (Stripe) is
described in the notes at the end and has not been started.
-->

# VeriPura Platform - Build Prompts for Claude Code

**Scope of this slice:** purchase-order intake through document-checklist and party-workload
retrieval, with the full org/permission model in place. Fresh standalone spec - not tied to VeriPura's existing
`sam2` core, concierge system, or IOTA identity work, but deliberately shaped so joining that
core later is a swap, not a rewrite (see "Built with future integration in mind" below). Also
incorporates the Trade Compliance Control Tower design doc and its reconciliation with the
Product Sitemap & Role Architecture doc (see "Control Tower alignment" below). Stack:
TypeScript/Node, Postgres.

**This is meant to run as a real MVP trial with real businesses who may convert to paying
customers** - not a disposable prototype. That doesn't mean building billing, a partner
workspace, or portfolio analytics now; it means not building the parts that ARE in scope in a way
that blocks or requires rework for those things later. Every "seam, not a feature" item below
(external_core_id, billing_status, the wide org_type enum, the merged permission model) exists
for that reason specifically.

Run the three prompts below in order. Each is self-contained (states its own context) so it can
be pasted into a fresh Claude Code session, but assumes the previous stage's code already exists
in the repo. Review the diff after each stage before moving to the next.

---

## Built with future integration in mind

This spec isn't tied to VeriPura core yet, but it will be, and this trial's participating
businesses may convert to paying customers on this same data. Four choices below exist
specifically to make those two transitions (core integration, trial-to-paid) cheap later instead
of requiring rework on live customer data:

- **"Consignment," not "shipment" or "transaction."** VeriPura core and the pilot simulation both
  use "consignment." The Control Tower design doc uses "shipment" for the same concept - same
  object, different name. Keeping "consignment" avoids a second rename; if the terminology needs
  to change later, do it once, deliberately, not by drifting between documents.
- **`external_core_id` on the consignment.** Nullable, unused by the stub core client, but
  present from Prompt 2 onward so linking to core's own ID for the same consignment doesn't
  require a migration when the real integration lands.
- **`billing_status`, `stripe_customer_id`, `stripe_subscription_id` on the organization.**
  Nullable/defaulted, no billing logic or Stripe API calls wired up yet. Exists because Stripe
  integration is expected fairly early, as a near-term follow-on prompt, not a someday-maybe - so
  a real trial organization converting to paying doesn't require a migration touching that org's
  (by then live) data - see Prompt 1.
- **A wider `org_type` enum than the pilot needs today.** Onno's team already has an independent
  9-role model (Farmer, Processor, Exporter, Importer, Retailer, Logistics, Lab, Certifier, Data
  Source). Rather than build for three org types and rename later, start with the five this
  pilot's trade lane actually needs - `importer`, `exporter`, `logistics` (freight forwarder, in
  this pilot), `lab_cert` (laboratory / certification body), `data_source` (third-party
  registries and validators) - and fold in the remaining roles (Farmer, Processor, Retailer) once
  a trade lane needs them. Extending an enum later is trivial; renaming one after data exists in
  it is not.

The `VeriPuraCoreClient` interface in Prompt 2 (real implementation behind an interface, stub
wired in by default) is the same idea applied to the webhook contract itself: the seam is decided
now, the actual contract is filled in once Onno's team confirms it.

---

## Control Tower alignment

Two design documents were reviewed against this plan: a Trade Compliance Control Tower product
design (operational model: shipments/consignments as the central object, documents as evidence
rather than the primary object, issues as first-class work, party-and-relationship-based
permissions, an audit trail as system of record) and a comparison of that against a Product
Sitemap & Role Architecture document (broader SaaS layer: superadmin, client administration,
explicit internal roles, partner workspace). The two are consistent with each other and with the
plan already in progress. Three changes below fold in the operational model's strongest ideas
where they materially affect this slice; the SaaS-administration layer (subscriptions, billing,
service levels, partner workspace) is out of scope for this slice and belongs in a later pass.

- **Audit trail as a cross-cutting system of record.** Added to Prompt 1: a general `audit_log`
  table, and a `recordAudit(...)` helper used by every mutating action across all three prompts
  (org approval, user invite, PO submission, issue raised/resolved, etc.), not just the webhook
  traffic `webhook_events` already logs.
- **Named internal roles.** The five default roles a newly approved organization gets are now
  Organization Admin, Compliance Manager, Compliance User, Reviewer, and Viewer (matching the
  Product Sitemap doc), replacing the earlier generic "admin / standard_user / viewer" placeholder
  names.
- **Issues as first-class objects.** Added to Prompt 2: an `issues` table modeling a flagged
  discrepancy properly - problem statement, expected vs. found value, the document it was found
  against, the responsible party, and a status lifecycle - instead of a bare `flagged` status
  value on the checklist item. This is exactly the SISBOV animal-ID mismatch pattern from the
  pilot simulation, modeled the way the Control Tower doc's "exception-first validation UX"
  describes it, rather than retrofitted once document upload/validation exists.

One more change is a genuine reconciliation, not a straightforward adoption, and is called out
explicitly rather than folded in silently:

- **Permissions: merged, not replaced.** The Control Tower doc proposes a 4-action matrix (View /
  Edit / Download / Approve) per document per party. But it has no "status-only" tier, and the
  pilot's actual visibility matrix (Scope of Work, Section 7 - e.g. the exporter sees ENS,
  vessel manifest, CHED-P, and CDS as status-only, not full detail) depends on one. Adopting the
  4-action matrix literally would regress something already proven in the simulation. So this
  slice keeps `view_level` (`full` / `status_only` / `hidden`) from the original design and adds
  `can_edit` / `can_download` / `can_approve` as additional per-rule booleans alongside it, with
  edit/download/approve forced to `false` whenever `view_level` isn't `full` (you can't be granted
  edit rights on something you can't fully see). See Prompt 1, section 1, for the exact schema.

---

## Environment, testing, build log, and version control (applies to every prompt)

Each of the three prompts below ends with a line telling Claude Code to follow this section. Do
not skip it, and do not treat it as optional cleanup at the end - it's how each stage stays
reviewable and resumable.

- **Sandbox first.** Before writing application code, set up (or confirm, if it already exists
  from a prior stage) a local sandbox: a `docker-compose.yml` running Postgres, an `.env.example`
  with every required env var documented, and a README section on how to bring the sandbox up
  and run the app and test suite against it. All work in these three prompts runs against this
  local sandbox. Nothing gets deployed anywhere.
- **No cloud deployment in this stage.** Do not provision, configure, or push to Google Cloud,
  or any other hosting provider. Views/APIs run in localhost/sandbox mode only. Deployment is a
  deliberate later decision, once this slice has real UI and/or joins VeriPura core, not
  something to set up speculatively now.
- **Test suite, not just tests.** Pick one test runner (Vitest recommended for a TypeScript/Node
  stack) in Prompt 1 and keep using it in every later stage. Each stage's TESTS step must be run,
  not just written, and the stage is not complete until the full suite passes. A failing test
  blocks moving to the next prompt, it doesn't get skipped or commented out.
- **Build log.** Maintain an append-only `docs/build-log.md` in the repo. After each numbered
  build step in a prompt (schema, permission engine, lifecycle functions, webhook contract, API
  endpoint, etc.), append a dated entry: what was built, any decision made that wasn't fully
  specified in the prompt (and why), and the test suite's pass/fail state at that point. This is
  a project artifact, not a personal one: it's how a later stage, a different engineer, or a
  fresh Claude Code session with no memory of this one picks up full context by reading the repo,
  not by being re-briefed. Never overwrite prior entries, only append.
- **Git, committed as you go.** If no git repo exists yet, `git init` at the start of Prompt 1
  and make an initial commit. Commit after each numbered build step, not once at the end of the
  stage, with a message describing that step specifically. At the end of each stage, check
  `git remote -v`; if a remote named `origin` is already configured, push to it. If none is
  configured, stop and say so rather than guessing a remote URL, since that's an operator setup
  step, not something to invent.

---

## Shared context (recap this in your own head before each stage, already embedded in each prompt below)

- **Actors:** VeriPura (superadmin, platform-level, not scoped to an org), and client
  Organizations of type `importer`, `exporter`, `logistics`, `lab_cert`, or `data_source`. Each
  User belongs to exactly one Organization (VeriPura superadmins belong to none).
- **Consignment model:** everything starts with a Purchase Order (PO) uploaded by an importer,
  addressed to a specific exporter org. The PO file itself is never generated by this system,
  only uploaded and stored. On submission, the platform sends the PO (plus structured metadata)
  to VeriPura core via webhook; core responds with the list of documents required for that
  consignment (the "document checklist"), which this system persists and exposes.
- **Permission model:** per document TYPE, org-role-level default, set by VeriPura superadmin.
  For a given document type (e.g. "Bill of Lading") and a given org role (e.g. "Compliance User"
  in an exporter org), the rule grants a `view_level` (`full` / `status_only` / `hidden`) plus
  `can_edit` / `can_download` / `can_approve` booleans (each forced false unless `view_level` is
  `full`). Org admins assign their own org's users into roles within their org; they do not set
  cross-org visibility/permission rules themselves - that stays superadmin-only.
- **Issues:** a flagged discrepancy on a document is a first-class object (problem, expected vs.
  found value, source document, responsible party, status), not just a status flag - see Prompt 2.
- **Audit trail:** every mutating action across the system is recorded via a shared
  `recordAudit(...)` helper into a general `audit_log` table - see Prompt 1.

---

## Prompt 1 of 3 - Data model, organizations, users, permission engine, and audit log

```
You are building the foundational data model, permission engine, and audit trail for a
multi-tenant compliance platform (VeriPura) used by importers, exporters, freight
forwarders/logistics providers, laboratories/certification bodies, and third-party data sources
to manage import/export document compliance for cross-border trade consignments. This is a fresh
TypeScript/Node backend with a Postgres database. Do not assume any existing codebase.

Build the following:

1. DATABASE SCHEMA (Postgres, via a migration tool of your choice - Prisma or Drizzle preferred)

   - `organizations`: id, name, org_type (enum: importer | exporter | logistics | lab_cert |
     data_source - this list is deliberately wider than the current pilot needs; see note below),
     status (enum: pending_approval | active | suspended | rejected), billing_status (enum: trial
     | active | past_due | cancelled, default 'trial'), stripe_customer_id (nullable string),
     stripe_subscription_id (nullable string), created_at. billing_status, stripe_customer_id, and
     stripe_subscription_id are a seam, not a feature in this prompt: no billing logic, no Stripe
     API calls, nothing reads or enforces these fields yet. They exist because Stripe integration
     is expected fairly early in this platform's life, as its own follow-on prompt (see the notes
     at the end of this document) - once that prompt runs, billing_status becomes Stripe-webhook-
     driven rather than hand-set, and stripe_customer_id/stripe_subscription_id are how it links
     an organization to Stripe's records. Building these columns in now means that prompt is an
     addition, not a migration touching by-then-live customer data. Same pattern as
     external_core_id in Prompt 2.
   - `users`: id, organization_id (nullable - null means VeriPura superadmin), email, name,
     status (enum: invited | active | deactivated), created_at.
   - `org_roles`: id, organization_id, name (free text, but see the standard set below),
     is_org_admin (boolean - can this role invite/manage other users in the org and assign
     roles within it).
   - `user_role_assignments`: user_id, org_role_id (a user can hold more than one role).
   - `document_types`: id, name (e.g. "Bill of Lading", "Export Health Certificate"),
     category (free text, e.g. "Customs & logistics", "Certifications"), description.
   - `document_permission_rules`: document_type_id, org_type (enum, matches
     organizations.org_type, plus a special value for VeriPura superadmin which always resolves
     to full/all-true elsewhere in code rather than being stored here), org_role_name (free text
     matching org_roles.name convention, e.g. "Compliance User"), view_level (enum: full |
     status_only | hidden), can_edit (boolean), can_download (boolean), can_approve (boolean).
     This is the superadmin-configured default matrix - one row per (document type, org type,
     role name) combination. Enforce at the DB or application-validation layer that can_edit,
     can_download, and can_approve cannot be true when view_level is not 'full' - reject or clamp
     such a row rather than silently allowing a nonsensical grant.
   - `audit_log`: id, actor_user_id (nullable - null means system-initiated, e.g. a webhook),
     action (text, a dotted event name like "org.approved", "user.invited", "issue.raised"),
     target_type (text, e.g. "organization", "user", "consignment", "issue"), target_id (uuid),
     metadata (jsonb, action-specific details), created_at.

   Note on org_type: only `importer`, `exporter`, and `logistics` are used by the current pilot
   (Brazil-to-GB beef, with the freight forwarder modeled as `logistics`). `lab_cert` and
   `data_source` are included now because VeriPura's independent 9-role model treats laboratories
   and third-party registries as first-class org types, and this platform will need to represent
   them once it integrates with that core. Don't build UI or workflow specific to them yet, just
   don't make the enum narrower than this.

   Standard org_role names to use consistently across this stage's lifecycle functions, tests,
   and seed data: "Organization Admin" (is_org_admin = true), "Compliance Manager",
   "Compliance User", "Reviewer", "Viewer" (all is_org_admin = false). These replace any generic
   "admin/standard_user/viewer" naming - use the real names throughout.

2. PERMISSION ENGINE (a TypeScript module, not tied to any web framework yet)

   Export a function `resolveDocumentPermissions(user, documentType): { viewLevel: 'full' |
   'status_only' | 'hidden', canEdit: boolean, canDownload: boolean, canApprove: boolean }` that:
   - Returns { viewLevel: 'full', canEdit: true, canDownload: true, canApprove: true }
     immediately if the user has no organization_id (VeriPura superadmin).
   - Otherwise looks up the user's org's org_type and the user's assigned role name(s), checks
     document_permission_rules for matches, and resolves the most permissive result across all
     matching rules if the user holds multiple roles: view_level takes the most permissive value
     (full > status_only > hidden), and each boolean is true if any matching rule grants it.
   - After combining, re-apply the constraint that canEdit/canDownload/canApprove are false
     whenever the resolved viewLevel isn't 'full', even if some individual rule granted them
     before the merge - the merged result must stay internally consistent.
   - Defaults to { viewLevel: 'full', canEdit: false, canDownload: false, canApprove: false } if
     no rule row exists for that combination (document types with no configured rule are visible
     by default - opt-out on view restriction - but editing/downloading/approving stay opt-in
     even by default, since granting write or sign-off authority should never happen by omission).

   Also export `canManageOrgUsers(user): boolean` (true if superadmin, or if user holds a role
   with is_org_admin = true) and `canConfigureVisibilityRules(user): boolean` (true only for
   superadmin).

3. ORGANIZATION AND USER LIFECYCLE (service-layer functions, framework-agnostic)

   - `proposeOrganization(name, org_type, requestedByEmail)`: creates an organization row with
     status pending_approval, and a first user row (status invited) for the requester. Calls
     recordAudit for "organization.proposed".
   - `approveOrganization(orgId, actingUser)`: only if actingUser is superadmin. Sets org status
     to active, first user's status to active, and auto-creates the five standard org_roles
     (Organization Admin, Compliance Manager, Compliance User, Reviewer, Viewer) for that org,
     assigning Organization Admin to the first user. Calls recordAudit for "organization.approved".
   - `rejectOrganization(orgId, actingUser)`: superadmin only, sets status to rejected. Calls
     recordAudit for "organization.rejected".
   - `inviteUser(orgId, email, roleIds, actingUser)`: requires canManageOrgUsers(actingUser) AND
     actingUser.organization_id === orgId (superadmin can also do this for any org). Creates a
     user row (status invited) and role assignments. Calls recordAudit for "user.invited".
   - `deactivateUser(userId, actingUser)`: same permission check as inviteUser, scoped to the
     target user's org. Calls recordAudit for "user.deactivated".

4. AUDIT HELPER

   Export `recordAudit({ actorUser, action, targetType, targetId, metadata }): Promise<void>`
   that inserts an audit_log row, with actorUser possibly null for system-initiated actions.
   Every service function above (and every service function in Prompts 2 and 3) must call this
   on every mutation - treat a missing recordAudit call on a mutating action as a bug, not an
   optional nicety.

5. TESTS

   Write unit tests covering: a Compliance User with a status_only rule cannot see full document
   detail; a user with two roles where one grants full+can_approve and one grants hidden resolves
   to full view with can_approve true, and any role that individually granted can_edit/can_approve
   under a hidden or status_only rule does NOT leak that grant into the merged result once
   view_level resolves below full; an org_admin can invite users in their own org but not in
   another org; a document type with zero configured rules resolves to full view but no
   edit/download/approve rights; superadmin always resolves to full/all-true regardless of rules;
   approving an organization creates all five standard roles and assigns Organization Admin
   correctly; every lifecycle function under test produces a corresponding audit_log row with the
   right action name and target.

Do not build any HTTP API or webhook handling in this prompt - that's the next stage. Focus
entirely on schema, migrations, the permission engine, the audit helper, and the lifecycle
service functions, with tests passing.

Follow the "Environment, testing, build log, and version control" workflow throughout: set up
the local sandbox first (no cloud deployment), run the full test suite (not just write it) before
considering this stage done, append your progress to docs/build-log.md after each numbered step
above, and commit to git after each step (git init this stage, since it's the first).
```

---

## Prompt 2 of 3 - PO intake, consignment creation, issues, and the VeriPura core webhook contract

```
You are extending the VeriPura platform backend built in the previous stage (organizations,
users, org_roles, document_types, document_permission_rules, the permission engine in
resolveDocumentPermissions / canManageOrgUsers / canConfigureVisibilityRules, and the
recordAudit helper / audit_log table - assume that code exists in the repo; read it before
starting). This stage adds purchase-order intake, an issues model for flagged discrepancies, and
the webhook contract with VeriPura core.

Build the following:

1. DATABASE SCHEMA ADDITIONS

   - `consignments`: id, external_core_id (nullable string - VeriPura core's own identifier for
     this consignment once a live integration exists; unused/null while running against the stub
     client, but present now so linking it later doesn't require a migration), importer_org_id,
     exporter_org_id, status (enum: po_submitted | checklist_pending | checklist_received |
     active | completed | cancelled), commodity (free text), hs_code (free text, nullable),
     origin_country, destination_country, created_by_user_id, created_at.
   - `purchase_orders`: id, consignment_id, file_url (or storage key - assume an existing file
     storage abstraction, stub it with a simple interface `uploadFile(buffer, filename): Promise<string>`
     that you can swap for S3/GCS later), uploaded_by_user_id, uploaded_at.
   - `document_checklist_items`: id, consignment_id, document_type_id, required_by (enum:
     importer | exporter | logistics - which org type is responsible for supplying it),
     status (enum: awaiting_upload | pending | verified | flagged), created_at. This table is
     populated from VeriPura core's webhook response, not invented locally. `flagged` is a
     derived convenience value kept in sync with whether the item has an open issue (see below) -
     the issues table is the source of truth, this status is for cheap filtering/display.
   - `issues`: id, document_checklist_item_id, consignment_id, problem (text - a human-readable
     description of what's wrong), expected_value (text, nullable), found_value (text, nullable),
     source_document_checklist_item_id (nullable, self-referential FK to document_checklist_items
     - the other document the discrepancy was found against, e.g. a Certificate of Origin issue
     whose found_value came from the Commercial Invoice), responsible_org_type (enum, matches
     organizations.org_type - which party needs to act), status (enum: open |
     correction_requested | resolved), created_by_user_id (nullable - null if system/AI-raised),
     created_at, resolved_at (nullable).
   - `webhook_events`: id, consignment_id, direction (enum: outbound | inbound), payload (jsonb),
     status (enum: sent | received | failed), created_at. An audit log of every webhook call in
     and out (this stays separate from the general audit_log - webhook_events carries full raw
     payloads for replay/debugging, audit_log is the human-readable action trail).

2. PO SUBMISSION FLOW (service-layer, then a thin HTTP layer using Express or Fastify, your
   choice - keep the service functions callable independent of the HTTP layer for testability)

   - `submitPurchaseOrder({ importerOrgId, exporterOrgId, commodity, originCountry,
     destinationCountry, fileBuffer, fileName, actingUser })`:
     - Authorization: actingUser must belong to importerOrgId (or be superadmin), and must hold
       a role permitted to create consignments - for this stage, treat any active user in the
       importer org as permitted; a finer per-action permission grant is out of scope here.
     - Creates the consignment row (status po_submitted), uploads the PO file, creates the
       purchase_orders row.
     - Calls `sendToVeriPuraCore(consignment)` (see below), sets consignment status to
       checklist_pending, logs the outbound webhook_events row.
     - Calls recordAudit for "consignment.po_submitted".
     - Returns the created consignment.

3. VERIPURA CORE WEBHOOK CONTRACT (outbound)

   Define and implement `sendToVeriPuraCore(consignment)`:
   - POSTs to an env-configured `VERIPURA_CORE_WEBHOOK_URL` with a JSON payload:
     `{ consignmentId, externalCoreId, commodity, hsCode, originCountry, destinationCountry,
     importerOrgId, exporterOrgId, poFileUrl }`.
   - Since no real core endpoint exists yet, implement this behind an interface
     (`VeriPuraCoreClient`) with a real HTTP implementation AND a mock/stub implementation that
     returns a hardcoded plausible checklist (e.g. commercial invoice, packing list, bill of
     lading, export health certificate) after a simulated delay, so the rest of the system is
     testable without a live core. Wire the stub in by default via env var
     `VERIPURA_CORE_MODE=stub|live`.

4. VERIPURA CORE WEBHOOK CONTRACT (inbound - core calling back)

   Build an HTTP endpoint `POST /webhooks/veripura-core/checklist` that:
   - Accepts `{ consignmentId, externalCoreId, requiredDocuments: [{ documentTypeName,
     requiredBy }] }`. If externalCoreId is present and the consignment's own external_core_id is
     still null, persist it (first write wins; don't overwrite an existing value).
   - Verifies a shared-secret signature header (`X-VeriPura-Signature`, HMAC-SHA256 over the raw
     body using an env-configured secret) and rejects with 401 if invalid - stub the secret via
     env var for now, but implement real verification, not a bypass.
   - For each entry: looks up or creates the document_type by name, creates a
     document_checklist_items row (status awaiting_upload).
   - Sets consignment status to checklist_received.
   - Logs the inbound webhook_events row and calls recordAudit for "consignment.checklist_received".
   - This endpoint should be idempotent: replaying the same payload for a consignment that
     already has a received checklist should not create duplicate checklist items.

5. ISSUES SERVICE LAYER

   Since document upload and automated validation are out of scope for this slice, provide the
   issue lifecycle as directly callable service functions (a manual/internal path today, the same
   functions an automated validator or a human reviewer would call once that exists later):
   - `raiseIssue({ documentChecklistItemId, problem, expectedValue, foundValue,
     sourceChecklistItemId, responsibleOrgType, actingUser })`: creates an issues row (status
     open), sets the parent document_checklist_items.status to 'flagged', calls recordAudit for
     "issue.raised". Permission: superadmin, or any active user belonging to an org that is a
     party (importer or exporter) to the issue's consignment - there's no automated validator or
     dedicated reviewer role wired up yet, so keep this permission check simple and note in
     docs/build-log.md that it should be tightened once a real validation engine exists.
   - `requestCorrection({ issueId, message, actingUser })`: sets issue status to
     correction_requested, calls recordAudit for "issue.correction_requested" with the message in
     metadata. Same permission check as raiseIssue.
   - `resolveIssue({ issueId, actingUser })`: sets issue status to resolved, resolved_at to now,
     sets the parent document_checklist_items.status back to 'pending' (needs re-verification,
     not automatically re-verified), calls recordAudit for "issue.resolved".

6. TESTS

   Cover: submitting a PO as a user outside the importer org is rejected; submitting a PO
   with the stub core client results in a checklist being created and consignment status moving
   to checklist_received end to end; the inbound webhook endpoint rejects an invalid signature;
   replaying the same inbound webhook payload twice does not duplicate checklist items; a webhook
   payload carrying externalCoreId populates it on the consignment, and a second payload with a
   different externalCoreId does not overwrite the first; raising an issue sets the parent
   checklist item to flagged; resolving an issue sets the parent checklist item back to pending
   (not verified); every issue lifecycle transition produces the corresponding audit_log row.

Do not build document upload (parties uploading the actual compliance documents against the
checklist) or automated AI/third-party validation in this stage - that's stage 3 and beyond. The
issues model above exists so discrepancies can be represented and worked correctly once
validation exists; it deliberately doesn't build the validator itself.

Follow the "Environment, testing, build log, and version control" workflow throughout: confirm
the local sandbox still runs (no cloud deployment), run the full test suite before considering
this stage done, append your progress to docs/build-log.md after each numbered step above, and
commit to git after each step, pushing to origin at the end if a remote is already configured.
```

---

## Prompt 3 of 3 - Role-scoped checklist, issue retrieval, and party workload

```
You are extending the VeriPura platform backend built in the previous two stages (org/user/
permission model and audit log from stage 1; consignments, purchase orders,
document_checklist_items, issues, and the VeriPura core webhook contract from stage 2 - assume
that code exists in the repo; read it before starting). This stage exposes the document
checklist and any open issues to end users, filtered through the permission engine, so each role
sees only what it's entitled to see and only the actions it's entitled to take. It also adds a
party-workload view: an importer running this platform is expected to have more than one
concurrent consignment, likely with more than one exporter, from the start of the trial - this
isn't a future-scale feature, it's the normal usage pattern, so a basic cross-consignment
counterparty rollup belongs in this slice, not a later one.

Build the following:

1. API ENDPOINT: `GET /consignments/:consignmentId/checklist`

   - Authorization: actingUser must belong to the consignment's importer_org_id or
     exporter_org_id, or be superadmin. Return 403 otherwise (do not leak that the consignment
     exists - return 404 for a consignment the user has no relationship to at all, 403 only if
     they're in a related-but-wrong org, your call, document the choice in a comment).
   - For each document_checklist_items row on the consignment, resolve permissions for
     actingUser via `resolveDocumentPermissions(actingUser, documentType)` from stage 1:
     - `viewLevel: 'hidden'`: omit the item from the response entirely.
     - `viewLevel: 'status_only'`: return { documentTypeName, status, canEdit: false,
       canDownload: false, canApprove: false } - no requiredBy, no category, no issue detail
       even if one exists (a status_only viewer sees that something is flagged via the status
       value, not the issue's contents).
     - `viewLevel: 'full'`: return { documentTypeName, requiredBy, status, category, canEdit,
       canDownload, canApprove, openIssue }, where openIssue is null unless the item has an issue
       with status open or correction_requested, in which case include { problem, expectedValue,
       foundValue, responsibleOrgType, status, sourceDocumentTypeName } (resolve the source
       checklist item's document type name for display; omit sourceDocumentTypeName if there's no
       source item).
   - Response shape: `{ consignmentId, consignmentStatus, checklist: [...] }`.

2. API ENDPOINT: `GET /consignments` (list, scoped to the acting user's org)

   - Returns consignments where actingUser's org is either importer or exporter (or all
     consignments, if superadmin), each with a summary: id, commodity, counterpart org name,
     status, checklist completeness (count of items with status verified vs. total visible-to-
     this-user items - compute completeness using the SAME visibility filtering as endpoint 1, so
     a user never sees a completeness count that references documents they can't see), and an
     openIssueCount (count of items with an open or correction_requested issue that are visible
     to this user at viewLevel full - a status_only or hidden item's issue doesn't count).

3. API ENDPOINT: `GET /parties/workload` (aggregated by counterparty, scoped to the acting user's
   own org)

   - Authorization: any active user belonging to an org (not superadmin-only - an importer
     running several exporter relationships needs this as a working operator view, not an admin
     report). Superadmin gets an optional `?orgId=` query param to view any org's workload; other
     users always see their own org's.
   - Groups the acting user's org's consignments by counterparty org (the other party on each
     consignment - exporter, if acting org is the importer, and vice versa), and returns one row
     per counterparty: { counterpartyOrgId, counterpartyOrgName, activeConsignmentCount (status
     not in completed/cancelled), documentsAwaitingUploadCount, openIssueCount }.
   - Both count fields must use the SAME permission-filtered visibility as endpoint 1: count only
     document_checklist_items and issues the acting user can see at viewLevel full (a status_only
     or hidden item never contributes to these counts, same rule as the /consignments list
     endpoint's openIssueCount). This is the same principle as endpoint 2, applied across
     consignments instead of within one.
   - This deliberately does not include an "overdue" column - there's no due-date/deadline
     concept on a consignment or checklist item yet. Leave it out rather than inventing one; add
     it once a real deadline field exists (e.g. tied to ETA or a regulatory filing window).

4. TESTS

   Cover: an exporter-side Compliance User with a status_only rule on "Bill of Lading" gets status
   but not requiredBy/category/openIssue for that item even when an issue exists on it, while a
   full-visibility item on the same checklist returns everything including issue detail when
   present; a user with a hidden rule on a document type doesn't see it in the checklist array at
   all, and it's excluded from both the completeness count and openIssueCount; a user from an
   unrelated third org gets 404 on GET /consignments/:id/checklist; superadmin sees every item at
   full visibility with full issue detail regardless of configured rules; the /consignments list
   endpoint only returns consignments where the acting user's org is a party, except for
   superadmin who sees all; a resolved issue does not appear as openIssue on a full-visibility
   item, and does not count toward openIssueCount; an importer with consignments against two
   different exporters gets two rows from /parties/workload, each correctly scoped to that
   counterparty's consignments only; a status_only or hidden item's issue does not contribute to
   openIssueCount on the /parties/workload row it belongs to, matching the same rule as the
   /consignments list endpoint.

After this stage, the slice is complete: an importer can submit a PO, the platform round-trips
with VeriPura core (stubbed) to get a document checklist, discrepancies can be represented as
first-class issues and worked through open → correction_requested → resolved, every party sees
the checklist and any issues filtered correctly by the org-role permission matrix a superadmin
configured, and an importer running multiple concurrent consignments across multiple exporters
gets a basic working view of where each relationship stands. Document upload, automated
AI/third-party validation, and the collaboration/messaging layer (e.g. a real correction-request
conversation with the responsible party, rather than a single service-layer call) are explicitly
out of scope for this slice and should be scoped separately.

Follow the "Environment, testing, build log, and version control" workflow throughout: confirm
the local sandbox still runs (no cloud deployment), run the full test suite before considering
this stage done, append your progress to docs/build-log.md after each numbered step above, and
commit to git after each step, pushing to origin at the end if a remote is already configured.
```

---

## Notes for whoever runs these

- The stub `VeriPuraCoreClient` in Prompt 2 is a deliberate placeholder. Before Phase 1 of the
  broader platform scope of work can go live against the real pilot, this needs to be swapped
  for a live integration once the actual core webhook contract is confirmed with Onno's team.
  `external_core_id` is already in the schema for that day; nothing else about the consignment
  model should need to change.
- The document-permission default matrix (superadmin-configured `document_permission_rules` rows)
  is empty after Prompt 1 - seed it from the pilot's known visibility matrix (see the platform
  Scope of Work document, Section 7) as a follow-up data-seeding step, not part of these build
  prompts. The Scope of Work's matrix only specifies view_level (full/status_only/hidden); leave
  can_edit/can_download/can_approve false in that seed data until real per-party editing rights
  for the pilot are decided.
- `org_type` is deliberately wider than this pilot needs (`lab_cert`, `data_source` included
  alongside `importer`/`exporter`/`logistics`) so it can absorb VeriPura core's 9-role model
  later without a schema change. Fold in the remaining roles (Farmer, Processor, Retailer) as
  additional enum values only once a trade lane actually needs them.
- The `issues` service functions in Prompt 2 are intentionally permissive (any party-org user, or
  superadmin, can raise/resolve an issue) because no automated validator or dedicated reviewer
  role exists yet. Tighten this - likely to a specific role such as Compliance Manager, or to a
  system actor once VeriPura core's AI validation is wired in - as part of whatever later slice
  builds document upload and validation.
- None of these three prompts touch authentication/sign-in. They assume `actingUser` is already
  resolved by upstream middleware. Wiring real sign-in (Google Sign-In, per Onno's team's
  existing decision) is a separate, parallel prompt.
- **Deployment stays local for now.** All three stages run against the local sandbox only; no
  cloud provisioning happens in this build. Before running Prompt 1, create an empty repo (e.g.
  under the `VeriPura-2` GitHub org used for the pilot simulation) and configure it as `origin`
  so each stage's push has somewhere to land - otherwise the workflow above will stop and wait
  rather than guess a remote. Revisit Google Cloud once there's UI and/or a real core integration
  worth putting in front of people; until then, hosting it would be infrastructure with nothing
  yet depending on it.
- **UI is a separate conversation.** These prompts are backend-only (schema, permission engine,
  API endpoints). The document-checklist UI, role-scoped views, the Control Tower home screen and
  shipment/consignment workspace, and the portfolio-wide party-workload view are already covered
  across the pilot simulation, the platform Scope of Work, and the Control Tower design doc -
  worth a dedicated pass once this backend slice is running, rather than folding UI decisions in
  here.
- **Stripe billing integration is expected as an early follow-on, not this slice.** Prompt 1
  adds `billing_status`, `stripe_customer_id`, and `stripe_subscription_id` to organizations as
  seams (see "Built with future integration in mind"), but no Stripe API calls, checkout flow, or
  webhook handling are part of these three prompts. Treat that as Prompt 4, run once Prompts 1-3
  are stable: create a Stripe customer on org approval, a checkout/subscription flow, a webhook
  handler that keeps `billing_status` in sync with Stripe's subscription state, and - deliberately
  not yet - whatever enforcement (blocking access on `past_due`/`cancelled`) the business decides
  it wants once there's a real paying customer to test that against.
- **Portfolio-wide party workload is now in scope** (Prompt 3, `GET /parties/workload`), not
  deferred as earlier notes in this document said. That was based on treating it as a
  future-scale reporting feature; the real usage pattern is an importer running several
  concurrent consignments across multiple exporters from the start of the trial, so a basic
  counterparty rollup belongs in this slice. What's still deferred is the *richer* version implied
  by the Control Tower doc's example (overdue tracking, SLA-style aging) - that needs a due-date
  concept this slice doesn't have yet.
- **Out of scope for this slice, still genuinely deferred - and why that's compatible with
  running a real MVP trial that converts to paying customers, not just a prototype:**
  - **Partner Workspace** (a dedicated, purpose-built surface for parties who don't get a full
    org account). Not needed to get a real freight forwarder working in this trial: a `logistics`
    org already gets a standard Viewer role on approval, and a superadmin can already grant that
    role `status_only` or `full` view per document type via `document_permission_rules`. That's
    the Viewer-role middle ground already usable today. What's deferred is a nicer, purpose-built
    surface for that access pattern, not the access itself - and building it now would mean
    picking an answer to the still-open forwarder/broker question (Scope of Work, Section 9)
    implicitly, through code, before it's actually been decided.
  - **Superadmin SaaS-administration layer beyond billing** (service levels, platform-wide
    support tooling, plan-based feature gating). The Stripe seam above covers the billing
    identity piece; enforcement and support tooling have nothing to gate yet while there's no
    live paying customer to test them against. Add it when the first trial org is ready to
    actually convert, not before.
