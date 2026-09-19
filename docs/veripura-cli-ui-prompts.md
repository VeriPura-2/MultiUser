# VeriPura Platform: UI Build Prompts for Claude Code

**Scope of this slice:** the web UI for the backend slice built by Prompts 1 to 3 (organizations, permission engine, audit log, PO intake, consignments, checklist, issues, party workload). Three prompts, run in order: UI-1 adds the small API surface the screens need, UI-2 builds the frontend against it, and UI-3 adds vessel tracking (vessel identifiers, a position provider, and live positions on the dashboard map). They are named UI-1, UI-2 and UI-3 so they do not clash with the "Prompt 4" reserved for Stripe billing in the notes of the backend build prompts.

Run these only after Prompts 1 to 3 are complete, the full test suite passes, and the repo has a working local sandbox. Each prompt is self-contained so it can be pasted into a fresh Claude Code session, but assumes the earlier code exists in the repo. Review the diff after each stage before moving to the next.

---

## Visual reference: the v2 mockups

Five standalone HTML screens (Dashboard, Roadmap, Issue, Intake, SuperadminOrgApproval), each with light and dark PNG previews, live at:

`C:\Users\tomso\OneDrive\Desktop\Veripura\Control Tower\UI Mockup\v2-revised`

**Before running UI-2, copy that whole folder into the repo at `docs/ui-mockups/v2-revised/`** so the CLI can read the files and previews directly. The mockups are a visual and layout specification. They are not code to ship, and their sample data is not real data.

What in the mockups is deliberate, and what is not:

- **Deliberate:** layout, spacing, type sizes (nothing under 14px), the light "paper and gold" theme, the neutral charcoal dark theme, badge and tag styles, the org-type colour coding, the action-queue pattern, the map-plus-queue arrangement on the dashboard.
- **Placeholder:** every "Document name TBC" and "Category (name TBC)" string. The authoritative document list has not been confirmed. The real UI must never hard-code document names or categories, it must render whatever `document_types` holds (see UI-2). Only "Purchase Order" is a confirmed document.
- **Sample data:** all consignment ids, party names, counts, batch numbers, and the vessel positions and "last position" times on the map.
- **The map:** the HTML mockup uses Leaflet 1.9.4 with CARTO basemap tiles (dark_all for the dark theme, rastertiles/voyager for the light theme), built on OpenStreetMap data, the same approach as the reference control-tower dashboard. The tiles need internet access. The PNG previews were rendered without it, so they show the offline land fallback layer (Natural Earth) instead of tiles. Open `Dashboard.html` online to see the real basemap. The attribution line under the map ("OpenStreetMap contributors, CARTO") is required and must ship.
- **Deliberately excluded from the build:** any VERI wallet or token-pricing panel (do not build it anywhere), the Guardian Assistant panel and its "50+ agents" claim, the forensic view, the Trust Verification Ledger and Consignment Passport tabs, and the IOTA Tangle security line. These depend on VeriPura core and are outside this slice.

---

## Environment, testing, build log, and version control (applies to all three prompts)

Same rules as the backend prompts, restated so each prompt stands alone:

- **Local sandbox only.** No cloud provisioning, no deployment. Everything runs on localhost against the docker-compose Postgres from earlier stages.
- **Tests are run, not just written.** Keep Vitest as the test runner for both the API and the web app. A stage is not done until the full suite passes. A failing test blocks the next prompt.
- **Build log.** Append a dated entry to `docs/build-log.md` after each numbered step: what was built, any decision the prompt did not specify (and why), and the suite's pass or fail state. Append only, never overwrite.
- **Git, committed as you go.** Commit after each numbered step with a message describing that step. At the end of the stage, check `git remote -v` and push to `origin` if it exists. If none is configured, stop and say so, do not guess a remote.
- **Writing rule for all UI copy, comments, and docs:** no em dashes anywhere. Use commas, periods, or parentheses.

---

## Prompt UI-1 of 3: API surface for the UI

```
You are extending the VeriPura platform backend (Prompts 1 to 3: organizations, users, org_roles,
document_types, document_permission_rules, the permission engine, audit_log/recordAudit,
consignments, purchase_orders, document_checklist_items, issues, webhook_events, the checklist /
consignments / parties-workload endpoints). Assume that code exists; read it before starting.
This stage adds only what the web UI needs and does not yet have. Do not change existing
endpoint behaviour or the permission model.

Build the following:

1. DEV-ONLY ACTING USER
   The earlier prompts assume actingUser is resolved by upstream middleware and left real
   sign-in out of scope. For local UI development add a dev-only middleware, enabled only when
   AUTH_MODE=dev (never in any other mode, and refuse to start if AUTH_MODE=dev and
   NODE_ENV=production). It reads an `X-Dev-User` header (a user id) and loads that user.
   Add `GET /me` returning { userId, name, email, organization: { id, name, orgType } | null,
   roleNames: string[], isSuperadmin: boolean }. Real sign-in remains a separate parallel prompt.

2. LOCAL SEED SCRIPT
   `npm run seed:dev`, local sandbox only, clearly labelled sample data. It creates: one
   superadmin; an importer org, three exporter orgs, one logistics org, one lab_cert org, all
   active with the five standard roles and one user per org (plus a second user in the importer
   org holding only the Viewer role); document_permission_rules for the document types below
   covering every org_type and role name (view_level only, can_edit/can_download/can_approve
   false, per the notes in the backend prompts); a few consignments in different states with
   checklist items, and at least two open issues (one open, one correction_requested).
   Use the document types the stub VeriPuraCoreClient already returns. These are stub data
   pending the authoritative document list, so do not add more names, do not invent
   categories, and put a comment in the seed file saying so. Leave document_types.category null
   unless the stub already sets one.

3. CONSIGNMENT DETAIL
   `GET /consignments/:consignmentId`: id, status, commodity, hsCode, originCountry,
   destinationCountry, importerOrg { id, name }, exporterOrg { id, name }, createdAt. Same
   authorization and 404/403 choice as the checklist endpoint. Do not add fields that are not in
   the schema (for example there is no quantity field, so the UI must not show one).

4. ACTION QUEUE
   `GET /action-queue`, scoped to the acting user's org (superadmin may pass ?orgId=). Returns
   items across all of that org's non-completed, non-cancelled consignments:
   { consignmentId, consignmentLabel, documentTypeName, requiredBy, status ('flagged' |
   'awaiting_upload'), issueId (nullable), responsibleOrgType (nullable),
   actionableByMyOrg (boolean, true when requiredBy equals the acting org's type for
   awaiting_upload, or when the acting org's type equals responsibleOrgType for a flagged item) }.
   Use the SAME permission-filtered visibility as the checklist endpoint: hidden items are
   omitted, status_only items appear with status only and null issueId and null
   responsibleOrgType, full items carry issue fields. Sort: flagged first, then awaiting_upload,
   then by consignment created_at descending. No due dates and no "overdue", there is no
   deadline concept yet.

5. ISSUE DETAIL AND ACTIONS
   - `GET /issues/:issueId`: problem, expectedValue, foundValue, status, responsibleOrgType,
     responsibleOrgName (nullable), the checklist item summary (documentTypeName, category,
     requiredBy), sourceDocumentTypeName (nullable), createdAt, resolvedAt, and an `activity`
     array built from audit_log rows for that issue (action, actor display name or "System",
     created_at, metadata.message if present). Only visible to a user who can see the parent
     item at view_level full, otherwise 404.
   - `POST /issues/:issueId/request-correction` body { message } and
     `POST /issues/:issueId/resolve`, thin wrappers over requestCorrection and resolveIssue.
   - `POST /consignments/:consignmentId/checklist/:itemId/issues`, a thin wrapper over
     raiseIssue.
   Free-text comment threads are out of scope for this slice (the messaging layer is
   deliberately deferred), so do not add a comment endpoint. The correction message is stored in
   audit_log metadata as before.

6. ORGANIZATION DIRECTORY AND SUPERADMIN ENDPOINTS
   - `GET /organizations/exporters`: active exporter-type orgs as { id, name }, available to any
     active importer-org user (needed by the PO form to choose the counterparty).
   - Superadmin only, 403 otherwise: `GET /admin/organizations?status=pending_approval` (id,
     name, orgType, status, created_at, applicant contact name and email from the first user),
     `GET /admin/organizations/:id` (the same plus the five standard roles with the default
     permission summary to display: resolved from document_permission_rules where a rule
     exists, otherwise shown as "not configured", never invented), and
     `POST /admin/organizations/:id/approve` and `/reject` wrapping approveOrganization and
     rejectOrganization. The mockup shows a country field for the applicant, but the schema has
     none, so omit it rather than adding a column.

7. PO SUBMISSION ENDPOINT
   If a `POST /consignments` HTTP endpoint (multipart: importerOrgId derived from the acting
   user, exporterOrgId, commodity, originCountry, destinationCountry, file) does not already
   wrap submitPurchaseOrder, add it.

8. TESTS
   Cover: /me for a superadmin, a normal user, and an unauthenticated request; the dev
   middleware refuses to start with AUTH_MODE=dev and NODE_ENV=production; /action-queue omits
   hidden items, hides issue detail for status_only items, marks actionableByMyOrg correctly,
   and orders flagged before awaiting_upload; /issues/:id returns 404 when the parent item is
   status_only or hidden for that user; the issue action endpoints write the expected audit_log
   rows; admin endpoints return 403 for a non-superadmin and approval creates the five roles;
   /organizations/exporters excludes non-active and non-exporter orgs; consignment detail
   respects the same 404/403 rules as the checklist.

Follow the "Environment, testing, build log, and version control" workflow: sandbox only,
full suite passing, build-log entry and a commit after each numbered step, push to origin at the
end if one is configured.
```

---

## Prompt UI-2 of 3: The web app

```
You are building the web UI for the VeriPura platform. The backend (Prompts 1 to 3 and UI-1) is
already in the repo and running against the local sandbox. Read the backend code and API
routes first. The visual specification is in docs/ui-mockups/v2-revised/: five HTML screens
(Dashboard, Roadmap, Issue, Intake, SuperadminOrgApproval) and light and dark PNG previews of
each. Open every file and every PNG before writing code. Match the mockups' layout, spacing,
type scale, and behaviour, but treat all data in them as sample data.

Stack: React with Vite and TypeScript in a new `web/` directory, React Router, TanStack Query
for data fetching, Vitest and Testing Library for tests. Plain CSS with custom properties (no
component library, no CSS framework). Dev server proxies /api to the local backend. The app
sends `X-Dev-User: <userId>` on every request in dev mode, with a small dev-only user switcher
(a select in the corner listing the seeded users) so each role and org can be tried. The
switcher must not render in a production build.

Build the following, in this order, committing after each step:

1. APP SHELL AND THEME
   - Extract the design tokens from the mockups into `web/src/styles/tokens.css` (light values
     in :root, dark values in `html.dark`). Use the mockups' values exactly. The dark theme is a
     neutral charcoal that was deliberately lightened off near-black and must not drift toward
     brown: --ivory #303338, --paper #3B3E44, --recess #454850, --charcoal (text) #EEEFF1,
     --charcoal-soft #B9BDC4, --line #565A62, with the semantic badge colours, map colours, and
     sidebar colours as in the mockups' `html.dark` block.
   - Theme toggle: toggles the `dark` class on <html>, persists to localStorage key `vp-theme`
     (wrapped in try/catch), and updates its label. Every colour in the app comes from a token,
     no hard-coded hex values in components.
   - Fonts: DM Serif Display for headings, Source Serif 4 for body serif text, system-ui for UI
     text, as in the mockups. Nothing under 14px. Visible focus states. Respect
     prefers-reduced-motion.
   - Layout: the left sidebar (Dashboard, Consignments, Parties, Issues, Documents, Settings)
     shows the acting user's name and organization from GET /me. The Superadmin screen uses the
     top-bar layout from its mockup and is reachable only when /me says isSuperadmin.
   - Shared components: Badge, OrgTypeTag, Card, StatCard, ThemeToggle, EmptyState, ErrorState,
     LoadingSkeleton. Every screen handles loading, empty, and error states.

2. DASHBOARD  (mockup: Dashboard.html)
   - Consignment list from GET /consignments; stat cards derived client-side from that list and
     GET /parties/workload (active consignments, open issues, average completeness, exporter
     parties). The attention band appears only when open issues exist and links to the first
     one. Do not add a new endpoint for these.
   - Required-documents action queue from GET /action-queue, with the All / Needs my org /
     Waiting on others filter chips (filter on actionableByMyOrg) and the item count. Actions:
     "View issue" links to the issue screen. "Upload" is rendered disabled with a tooltip, since
     document upload is a later stage. "Nudge party" is rendered disabled with the same
     treatment, since messaging is deferred.
   - Live consignment map: there is no tracking or position data in the backend yet (UI-3 adds
     it), so this stage builds the map component against a clearly named sample-data module
     `web/src/sample/mapSample.ts` (lat/lng positions, route arcs between sample ports, and
     "last position" ages). Use Leaflet from npm (leaflet 1.9.x, import its CSS, no CDN) with
     CARTO basemap tiles: dark_all when `html.dark` is set and rastertiles/voyager otherwise,
     subdomains abcd, swapping the tile layer when the theme toggles (MutationObserver on the
     class). Put the tile URLs, attribution string and max zoom in one file,
     `web/src/map/tiles.ts`, so a licensed or self-hosted tile provider can replace them later
     without touching components.
     Required: (1) the attribution "OpenStreetMap contributors, CARTO" (with links) is always
     visible on the map; (2) an offline fallback layer underneath the tiles, drawn from the
     Natural Earth 110m land GeoJSON in the `world-atlas` npm package, in a pane below the tile
     pane, so the map still shows land if tiles fail to load; (3) scroll-wheel zoom off, zoom
     buttons on (so the page still scrolls), minimum zoom 2; (4) vessel markers as divIcons with
     the same colour semantics as the mockup (open issue, on track, cleared) and a hollow dashed
     marker for "no recent position"; (5) the "Sample positions" flag stays visible whenever the
     data comes from `mapSample.ts`, and positions are never presented as real tracking. Vessel
     selection, the consignment chips under the map, and the info line (including the last
     position age) work as in the mockup. Do not use a Leaflet default marker image. The tile
     provider's terms and any usage limits must be checked before launch (see the notes at the
     end), so do not add a paid key or account in this stage.

3. ROADMAP  (mockup: Roadmap.html)
   - Header from GET /consignments/:id (only fields that exist: no quantity), checklist from
     GET /consignments/:id/checklist.
   - Group items by document_types.category. A null category goes in a group labelled
     "Uncategorised". Never hard-code document names or category names anywhere in the
     frontend. The "Document name TBC" and "Category (name TBC)" strings in the mockup are visual
     placeholders and must not ship.
   - Render strictly from the permission flags the API returns: status_only items show name and
     status only, no requiredBy, category, or issue text; canEdit / canDownload / canApprove
     decide which buttons appear; the Upload button is rendered disabled with a tooltip
     (upload is a later stage). Flagged items with openIssue link to the issue screen.
   - Omit the Guardian Assistant panel, forensic view, ledger and passport tabs, and the
     cryptographic-proof line. Keep only the Compliance Roadmap tab, and do not show
     non-functional tabs.

4. ISSUE  (mockup: Issue.html)
   - From GET /issues/:id: problem, expected and found boxes, responsible party, checklist
     item card, status stepper (open, correction requested, resolved), and the activity list
     from the `activity` array.
   - "Request Correction" opens a small dialog with a message field and calls the endpoint;
     "Mark Resolved" calls the resolve endpoint. Show these buttons only to users the API
     allows to act, and refresh the data after each action.
   - The mockup's comment box has no backend (messaging is deferred). Do not render it.

5. INTAKE  (mockup: Intake.html)
   - The mockup shows AI field extraction, which is not part of this slice. Build the real
     flow instead: a PO file upload (drag and drop or browse), an exporter select from
     GET /organizations/exporters, and commodity, origin country, and destination country
     fields, submitted to POST /consignments. On success go to the new consignment's roadmap.
     Keep the step layout, the upload zone styling, and the field styling from the mockup.
   - Do not show "AI-extracted" pills, the IOTA Tangle line, or any claim that fields were
     extracted automatically. If field extraction is added later, that is a separate stage.

6. SUPERADMIN ORG APPROVAL  (mockup: SuperadminOrgApproval.html)
   - Pending list from GET /admin/organizations?status=pending_approval, detail panel from
     GET /admin/organizations/:id, and Approve / Reject buttons with a confirm step. The default
     permission table shows exactly what the API returns, including "not configured" where no
     rule exists. Do not display the mockup's sample permission values as if they were real.
   - Show "n/a" (not a dash character) for cells that do not apply.

7. TESTS
   Vitest and Testing Library, run against a mocked API layer: a status_only checklist item
   renders no requiredBy, category, or issue text; a hidden item is absent; a null category
   renders under "Uncategorised"; the action queue filter chips change the visible items and the
   count; Upload buttons are disabled; theme toggle adds and removes the `dark` class and
   persists; the map shows the OpenStreetMap and CARTO attribution and the "Sample positions" flag, and swaps the tile URL when the theme toggles (mock Leaflet's tile layer, no real network requests in tests); the superadmin route is inaccessible to a non-superadmin; the dev user switcher is
   absent in a production build; and a grep-style test that fails if the strings "Document name
   TBC", "wallet", "VERI token", or an em dash appear anywhere in web/src. Also run a build
   (`vite build`) as part of the suite, and do a manual visual comparison of each screen against
   its PNG preview in both themes, noting any deliberate differences in docs/build-log.md.

Explicit exclusions for this stage (do not build, do not stub in the UI): any VERI wallet or
token-pricing or agent-settings panel, the Guardian Assistant panel, forensic view, ledger and
passport tabs, document upload, messaging and comment threads, AI extraction, live vessel or
container tracking (that is UI-3), real sign-in, and any billing or Stripe UI.

Follow the "Environment, testing, build log, and version control" workflow: local sandbox only,
full suite passing, build-log entry and a commit after each numbered step, push to origin at the
end if one is configured.
```

---

## Prompt UI-3 of 3: Vessel tracking

Run after UI-2 is complete and merged. This is the first stage that touches real position data, so it changes the schema and adds an external data dependency. Read the notes at the end first.

```
You are adding vessel tracking to the VeriPura platform. The backend (Prompts 1 to 3, UI-1) and
the web app (UI-2) are already in the repo. The dashboard map currently runs on sample data from
web/src/sample/mapSample.ts. This stage lets a consignment carry a vessel identifier, fetches
vessel positions through a provider interface, stores them, and feeds the map. Read the existing
consignment routes, the permission engine, the audit log, and the map component before writing
code. Follow the "Environment, testing, build log, and version control" workflow: local sandbox
only, no real network calls in tests, full suite passing, build-log entry and a commit after
each numbered step.

Ground rules:
- The browser never calls an AIS provider. Only the backend does, and provider keys live in
  environment variables, never in the frontend, the repo, or logs.
- Never draw a position that is not real. If a vessel has no recent position, say so.
- Do not guess a provider's message format or terms. Read its official documentation and
  record what you relied on in docs/build-log.md.
- No em dash characters in any code, comment, or UI string. No hard-coded document names.

1. SCHEMA AND VESSEL IDENTIFIERS
   - Migration adding nullable columns to consignments: vessel_imo (text, 7 digits),
     vessel_mmsi (text, 9 digits), vessel_name (text). Existing rows stay valid.
   - Validate on write: IMO must be 7 digits and pass the IMO check digit (multiply the first
     six digits by 7, 6, 5, 4, 3, 2, sum them, the last digit of the sum must equal the seventh
     digit). MMSI must be exactly 9 digits. Either or both may be set. Reject anything else
     with a 422 and a clear message.
   - POST /consignments accepts the three optional fields. Add PATCH /consignments/:id/vessel to
     set or clear them, using the existing permission engine (only an org that may edit the
     consignment) and writing an audit_log entry with the old and new values.
   - GET /consignments and GET /consignments/:id return the fields (null when unset).
   - Vessel identifiers are entered by hand in this stage. Extracting them from a bill of
     lading is a later stage that depends on AI extraction and the confirmed document list.
   - New table vessel_positions: id, vessel_imo (nullable), vessel_mmsi (nullable), lat, lng,
     speed_knots, heading_deg, nav_status, position_time (from the provider), received_at,
     source (text). Index on (vessel_mmsi, position_time desc) and (vessel_imo, position_time
     desc). Keep at most 72 hours of history per vessel and prune older rows on a schedule.

2. POSITION PROVIDER INTERFACE
   - Define `VesselPositionProvider` in `src/tracking/provider.ts`: given a list of
     { imo?, mmsi? } identifiers it yields normalised positions
     { imo?, mmsi?, lat, lng, speedKnots?, headingDeg?, navStatus?, positionTime, source }.
     Validate every position (lat -90..90, lng -180..180, time not in the future by more than
     a minute) and drop bad ones with a logged count.
   - `SampleProvider` (default, env AIS_PROVIDER=sample): deterministic positions along
     great-circle routes for seeded vessels, every position tagged source "sample".
   - `AisStreamProvider` (env AIS_PROVIDER=aisstream): a server-side WebSocket client for the
     AISStream.io service (https://aisstream.io, free API key in AISSTREAM_API_KEY). Subscribe
     with a filter on the MMSIs of vessels that active consignments reference, resubscribe when
     that set changes, reconnect with exponential backoff and jitter, respect the documented
     limit of three connections, and keep up with the stream (do not block the message
     handler, because the service drops messages for slow consumers). It only ever runs on a
     server, since browsers are not allowed to connect. Read the official docs for the exact
     subscription and message format. Unit-test it against a fake WebSocket, never the real
     service.
   - Guard: the live provider refuses to start unless AIS_LIVE_ALLOWED=true. Default false.
     Document in the code and in docs/build-log.md that AISStream's terms on commercial use
     have not been confirmed, and that this flag exists so nobody enables live data in a paid
     product by accident.
   - Leave a documented extension point for a REST provider (a licensed source such as
     VesselAPI, Datalastic or VesselFinder, polled on an interval and rate limited). Do not
     implement it in this stage.
   - Ingestion service: writes normalised positions to vessel_positions, deduplicating on
     (vessel, position_time). A failure in the provider must never break the API.

3. POSITION ENDPOINTS
   - GET /consignments/:id/position and GET /positions (all consignments visible to the acting
     user, same visibility rules as GET /consignments). A consignment the user cannot see must
     never leak a position.
   - Each item: consignmentId, lat, lng, speedKnots, headingDeg, positionTime, ageSeconds,
     freshness ("recent" if at most 2 hours old, "stale" if older, "unavailable" if there is no
     position or no vessel identifier), isSample (true when source is "sample"), and an optional
     `trail` of the last 24 hours of positions (max 100 points, thinned). The 2 hour threshold
     is a config value, not a literal.
   - Consignments with no vessel identifier return freshness "unavailable" with a reason
     "no_vessel_identifier". Do not omit them, the UI needs to say why there is no dot.

4. FRONTEND WIRING
   - The dashboard map loads GET /positions (TanStack Query, refetch every 60 seconds while the
     tab is visible) and replaces mapSample.ts as the data source when the API returns real or
     sample-provider data. Keep mapSample.ts only as the storybook and test fixture.
   - Markers: "recent" is a normal marker, "stale" is the hollow dashed marker, "unavailable"
     has no marker and instead appears in the info line ("No vessel identifier on this
     consignment" or "No position received yet"). The info line shows the last position age,
     speed and heading when known.
   - Flags: show "Sample positions" whenever any shown position has isSample true, otherwise
     show "Live AIS". Never show "Live" for stale data.
   - No planned-route line: the backend has no port or route data. Draw the recent `trail`
     as a thin line instead. Do not fake an origin to destination arc for real positions.
   - Roadmap header shows vessel name and IMO when present. The Intake form gets three optional
     fields (vessel name, IMO, MMSI) with the same validation messages as the API.
   - Keep the attribution line on the map.

5. TESTS
   IMO check digit and MMSI validation (valid, invalid, blank); PATCH writes an audit entry and
   is permission scoped; GET /positions never returns a consignment the user cannot see;
   freshness classification at the threshold boundaries; provider validation drops bad
   positions; the AIS provider refuses to start when AIS_LIVE_ALLOWED is not true; reconnect
   backoff with a fake timer; the ingestion service deduplicates; the frontend renders a hollow
   marker for stale, no marker for unavailable, and the correct flag for sample and live data.
   No test may touch the network.

Explicit exclusions for this stage: buying or configuring satellite AIS, ETA prediction, port
geofencing and arrival alerts, container-level tracking, AI extraction of vessel details from
documents, and any paid provider integration.

Finish with a short docs/tracking.md covering the provider interface, the env variables
(AIS_PROVIDER, AIS_LIVE_ALLOWED, AISSTREAM_API_KEY, the freshness threshold), the coverage
limits described below, and what must be decided before live data is turned on for customers.
```

---

## Notes for whoever runs these

- **The document list is the one open dependency.** The UI is built to render whatever `document_types` contains, so confirming the authoritative list means loading it into the database (and setting `category` if categories are wanted). No frontend change is needed. Until then the seed uses the stub core client's example documents.
- **Map tiles and licence.** The basemap is CARTO tiles built on OpenStreetMap data, with the attribution shown on the map. Before customers use it, confirm CARTO's current terms for commercial use and any usage limits on free tiles, and decide whether to move to a paid or self-hosted tile provider. Because the tile URLs live in one file (`web/src/map/tiles.ts`), that swap does not touch components. The Natural Earth land fallback is public domain.
- **The map is illustrative until UI-3.** Until then the positions come from `mapSample.ts` and are flagged "Sample positions". UI-3 adds the vessel identifier fields, the provider interface, and the position endpoints.
- **AIS coverage has a hard limit.** Free and low-cost AIS feeds mostly come from land-based receivers, which reach roughly 40 to 60 km offshore, so a ship in mid-ocean will often have no position. Satellite AIS fills the gap and is where the cost is. The UI is built to say "no recent position" instead of drawing a guess. Decide before launch whether customers need satellite coverage.
- **AISStream's commercial terms are unconfirmed.** It is a free service suited to prototyping, and a public question about commercial use was unanswered when checked. Ask them directly, or use a licensed provider (VesselAPI, Datalastic, VesselFinder, or a larger vendor), before live data is enabled for paying customers. UI-3 keeps live data off unless AIS_LIVE_ALLOWED=true.
- **Vessel identifiers are manual for now.** The IMO or MMSI is typed in. Reading it from a bill of lading needs the extraction stage and the confirmed document list.
- **Quantity, applicant country, and due dates are absent on purpose.** The mockups show a quantity on the consignment header and a country on the applicant. Neither is in the schema, and the UI-1 and UI-2 prompts tell the CLI to omit them rather than add columns silently. Add them as a deliberate schema change if you want them.
- **Deferred and still open:** document upload, the messaging and comment layer, AI extraction on intake, Guardian and forensic features, real sign-in, and Stripe billing. Each is a separate stage.
