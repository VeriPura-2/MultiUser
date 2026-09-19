import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Column keys are snake_case on purpose: the service layer and the spec talk about
// `user.organization_id`, `actingUser.organization_id`, and so on, so the TypeScript
// property names match the SQL column names one to one.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Deliberately wider than the pilot needs (importer, exporter, logistics). lab_cert and
 * data_source are here so the platform can absorb VeriPura core's 9-role model later.
 * Extending an enum is cheap, renaming a value once data exists is not.
 */
export const ORG_TYPES = ["importer", "exporter", "logistics", "lab_cert", "data_source"] as const;
export type OrgType = (typeof ORG_TYPES)[number];
export const orgTypeEnum = pgEnum("org_type", ORG_TYPES);

/**
 * org_type as used by document_permission_rules: the five real org types plus a marker for
 * VeriPura superadmin. Superadmin always resolves to full/all-true in code, so the marker
 * exists to keep the vocabulary complete, but a rule row may not use it (see the CHECK below).
 */
export const RULE_ORG_TYPES = [...ORG_TYPES, "veripura_superadmin"] as const;
export type RuleOrgType = (typeof RULE_ORG_TYPES)[number];
export const ruleOrgTypeEnum = pgEnum("rule_org_type", RULE_ORG_TYPES);

export const ORG_STATUSES = ["pending_approval", "active", "suspended", "rejected"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
export const orgStatusEnum = pgEnum("org_status", ORG_STATUSES);

export const BILLING_STATUSES = ["trial", "active", "past_due", "cancelled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];
export const billingStatusEnum = pgEnum("billing_status", BILLING_STATUSES);

export const USER_STATUSES = ["invited", "active", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);

export const VIEW_LEVELS = ["full", "status_only", "hidden"] as const;
export type ViewLevel = (typeof VIEW_LEVELS)[number];
export const viewLevelEnum = pgEnum("view_level", VIEW_LEVELS);

export const CONSIGNMENT_STATUSES = [
  "po_submitted",
  "checklist_pending",
  "checklist_received",
  "active",
  "completed",
  "cancelled",
] as const;
export type ConsignmentStatus = (typeof CONSIGNMENT_STATUSES)[number];
export const consignmentStatusEnum = pgEnum("consignment_status", CONSIGNMENT_STATUSES);

/** Which org type is responsible for supplying a required document. */
export const CHECKLIST_REQUIRED_BY = ["importer", "exporter", "logistics"] as const;
export type ChecklistRequiredBy = (typeof CHECKLIST_REQUIRED_BY)[number];
export const checklistRequiredByEnum = pgEnum("checklist_required_by", CHECKLIST_REQUIRED_BY);

export const CHECKLIST_ITEM_STATUSES = ["awaiting_upload", "pending", "verified", "flagged"] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];
export const checklistItemStatusEnum = pgEnum("checklist_item_status", CHECKLIST_ITEM_STATUSES);

export const ISSUE_STATUSES = ["open", "correction_requested", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const issueStatusEnum = pgEnum("issue_status", ISSUE_STATUSES);

export const WEBHOOK_DIRECTIONS = ["outbound", "inbound"] as const;
export type WebhookDirection = (typeof WEBHOOK_DIRECTIONS)[number];
export const webhookDirectionEnum = pgEnum("webhook_direction", WEBHOOK_DIRECTIONS);

export const WEBHOOK_STATUSES = ["sent", "received", "failed"] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];
export const webhookStatusEnum = pgEnum("webhook_status", WEBHOOK_STATUSES);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  org_type: orgTypeEnum("org_type").notNull(),
  status: orgStatusEnum("status").notNull().default("pending_approval"),
  // Seam, not a feature: no billing logic reads or enforces these yet. They exist so the
  // Stripe follow-on is an addition, not a migration over live customer data.
  billing_status: billingStatusEnum("billing_status").notNull().default("trial"),
  stripe_customer_id: text("stripe_customer_id"),
  stripe_subscription_id: text("stripe_subscription_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null means VeriPura superadmin.
    organization_id: uuid("organization_id").references(() => organizations.id),
    email: text("email").notNull(),
    name: text("name"),
    status: userStatusEnum("status").notNull().default("invited"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A person belongs to exactly one organization, so an email identifies one user, globally.
    uniqueIndex("users_email_lower_uniq").on(sql`lower(${t.email})`),
    index("users_organization_id_idx").on(t.organization_id),
  ],
);

export const org_roles = pgTable(
  "org_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    // Can this role invite/manage other users in the org and assign roles within it.
    is_org_admin: boolean("is_org_admin").notNull().default(false),
  },
  (t) => [uniqueIndex("org_roles_org_name_uniq").on(t.organization_id, t.name)],
);

export const user_role_assignments = pgTable(
  "user_role_assignments",
  {
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id),
    org_role_id: uuid("org_role_id")
      .notNull()
      .references(() => org_roles.id),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.org_role_id] }), index("ura_org_role_id_idx").on(t.org_role_id)],
);

export const document_types = pgTable(
  "document_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    category: text("category"),
    description: text("description"),
  },
  // Case-insensitive: core may say "bill of lading" where a superadmin created "Bill of Lading",
  // and those must resolve to one document type, not two.
  (t) => [uniqueIndex("document_types_name_uniq").on(sql`lower(${t.name})`)],
);

/**
 * The superadmin-configured default matrix: one row per (document type, org type, role name).
 *
 * The CHECK constraints reject a nonsensical grant (edit/download/approve on something the
 * role cannot fully see) at the database layer rather than clamping silently, so a bad row
 * fails loudly at write time instead of being quietly rewritten.
 */
export const document_permission_rules = pgTable(
  "document_permission_rules",
  {
    document_type_id: uuid("document_type_id")
      .notNull()
      .references(() => document_types.id),
    org_type: ruleOrgTypeEnum("org_type").notNull(),
    org_role_name: text("org_role_name").notNull(),
    view_level: viewLevelEnum("view_level").notNull(),
    can_edit: boolean("can_edit").notNull().default(false),
    can_download: boolean("can_download").notNull().default(false),
    can_approve: boolean("can_approve").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.document_type_id, t.org_type, t.org_role_name] }),
    check(
      "dpr_grants_require_full_view",
      sql`${t.view_level} = 'full' OR (NOT ${t.can_edit} AND NOT ${t.can_download} AND NOT ${t.can_approve})`,
    ),
    check("dpr_no_superadmin_rows", sql`${t.org_type} <> 'veripura_superadmin'`),
  ],
);

export const audit_log = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null means system-initiated (for example a webhook).
    actor_user_id: uuid("actor_user_id").references(() => users.id),
    // Dotted event name, for example "organization.approved" or "user.invited".
    action: text("action").notNull(),
    target_type: text("target_type").notNull(),
    target_id: uuid("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_target_idx").on(t.target_type, t.target_id),
    index("audit_log_actor_idx").on(t.actor_user_id),
    index("audit_log_created_at_idx").on(t.created_at),
  ],
);

// ---------------------------------------------------------------------------
// Stage 2: consignments, purchase orders, checklist, issues, webhook log
// ---------------------------------------------------------------------------

export const consignments = pgTable(
  "consignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // VeriPura core's own identifier for this consignment. Null until a live integration
    // reports one (first write wins); unused by the stub client.
    external_core_id: text("external_core_id"),
    importer_org_id: uuid("importer_org_id")
      .notNull()
      .references(() => organizations.id),
    exporter_org_id: uuid("exporter_org_id")
      .notNull()
      .references(() => organizations.id),
    status: consignmentStatusEnum("status").notNull().default("po_submitted"),
    commodity: text("commodity").notNull(),
    hs_code: text("hs_code"),
    origin_country: text("origin_country").notNull(),
    destination_country: text("destination_country").notNull(),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The ship carrying the goods, entered by hand for now. All three are optional and independent.
    // The database only checks the shape; the IMO check digit is verified in src/tracking/identifiers.ts.
    vessel_imo: text("vessel_imo"),
    vessel_mmsi: text("vessel_mmsi"),
    vessel_name: text("vessel_name"),
  },
  (t) => [
    check("consignments_distinct_parties", sql`${t.importer_org_id} <> ${t.exporter_org_id}`),
    check("consignments_vessel_imo_format", sql`${t.vessel_imo} IS NULL OR ${t.vessel_imo} ~ '^[0-9]{7}$'`),
    check("consignments_vessel_mmsi_format", sql`${t.vessel_mmsi} IS NULL OR ${t.vessel_mmsi} ~ '^[0-9]{9}$'`),
    index("consignments_importer_idx").on(t.importer_org_id),
    index("consignments_exporter_idx").on(t.exporter_org_id),
  ],
);

export const purchase_orders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consignment_id: uuid("consignment_id")
      .notNull()
      .references(() => consignments.id),
    // Storage key or URL returned by the file storage abstraction.
    file_url: text("file_url").notNull(),
    uploaded_by_user_id: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("purchase_orders_consignment_idx").on(t.consignment_id)],
);

/**
 * Populated from VeriPura core's checklist callback, never invented locally. The unique index
 * is what makes replaying the same callback idempotent. `flagged` is a convenience mirror of
 * "has an unresolved issue"; the issues table is the source of truth.
 */
export const document_checklist_items = pgTable(
  "document_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consignment_id: uuid("consignment_id")
      .notNull()
      .references(() => consignments.id),
    document_type_id: uuid("document_type_id")
      .notNull()
      .references(() => document_types.id),
    required_by: checklistRequiredByEnum("required_by").notNull(),
    status: checklistItemStatusEnum("status").notNull().default("awaiting_upload"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checklist_items_consignment_doctype_reqby_uniq").on(
      t.consignment_id,
      t.document_type_id,
      t.required_by,
    ),
  ],
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    document_checklist_item_id: uuid("document_checklist_item_id")
      .notNull()
      .references(() => document_checklist_items.id),
    // Denormalized from the checklist item so party-scoped queries need no join.
    consignment_id: uuid("consignment_id")
      .notNull()
      .references(() => consignments.id),
    problem: text("problem").notNull(),
    expected_value: text("expected_value"),
    found_value: text("found_value"),
    // The other document the discrepancy was found against, for example the Commercial
    // Invoice behind a Certificate of Origin mismatch.
    source_document_checklist_item_id: uuid("source_document_checklist_item_id").references(
      (): AnyPgColumn => document_checklist_items.id,
    ),
    responsible_org_type: orgTypeEnum("responsible_org_type").notNull(),
    status: issueStatusEnum("status").notNull().default("open"),
    // null means system- or AI-raised.
    created_by_user_id: uuid("created_by_user_id").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    check("issues_resolved_at_matches_status", sql`(${t.status} = 'resolved') = (${t.resolved_at} IS NOT NULL)`),
    check(
      "issues_source_differs_from_item",
      sql`${t.source_document_checklist_item_id} IS NULL OR ${t.source_document_checklist_item_id} <> ${t.document_checklist_item_id}`,
    ),
    index("issues_item_idx").on(t.document_checklist_item_id),
    index("issues_consignment_status_idx").on(t.consignment_id, t.status),
  ],
);

/**
 * Raw payloads for every webhook call in and out, for replay and debugging. Separate from
 * audit_log, which is the human-readable action trail. consignment_id is null only for an
 * inbound call that could not be tied to a known consignment.
 */
export const webhook_events = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consignment_id: uuid("consignment_id").references(() => consignments.id),
    direction: webhookDirectionEnum("direction").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookStatusEnum("status").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_events_consignment_idx").on(t.consignment_id)],
);

/**
 * Where a vessel was, as reported by a position source. Rows are keyed by the vessel's own
 * identifiers (not by consignment), so two consignments on one ship share them. At most 72 hours
 * are kept per vessel (see src/tracking/ingest.ts). A position is only ever stored if it passed
 * validation, and `source` says where it came from ("sample" for generated demo positions).
 */
export const vessel_positions = pgTable(
  "vessel_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vessel_imo: text("vessel_imo"),
    vessel_mmsi: text("vessel_mmsi"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    speed_knots: doublePrecision("speed_knots"),
    heading_deg: doublePrecision("heading_deg"),
    // The source's navigational status code, as reported. Not interpreted here.
    nav_status: integer("nav_status"),
    // When the source says the position was reported, not when we received it.
    position_time: timestamp("position_time", { withTimezone: true }).notNull(),
    received_at: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull(),
  },
  (t) => [
    check("vessel_positions_has_identifier", sql`${t.vessel_imo} IS NOT NULL OR ${t.vessel_mmsi} IS NOT NULL`),
    check("vessel_positions_lat_range", sql`${t.lat} BETWEEN -90 AND 90`),
    check("vessel_positions_lng_range", sql`${t.lng} BETWEEN -180 AND 180`),
    index("vessel_positions_mmsi_time_idx").on(t.vessel_mmsi, t.position_time.desc()),
    index("vessel_positions_imo_time_idx").on(t.vessel_imo, t.position_time.desc()),
    // One row per vessel and reported time, so re-fetching the same position is harmless. A vessel
    // is identified by its MMSI when we have one, by its IMO otherwise.
    uniqueIndex("vessel_positions_mmsi_time_uniq")
      .on(t.vessel_mmsi, t.position_time)
      .where(sql`${t.vessel_mmsi} IS NOT NULL`),
    uniqueIndex("vessel_positions_imo_time_uniq")
      .on(t.vessel_imo, t.position_time)
      .where(sql`${t.vessel_mmsi} IS NULL AND ${t.vessel_imo} IS NOT NULL`),
  ],
);

/**
 * Every call made to a position provider that has a call allowance (VesselAPI's free plan is 150 a
 * month). A row is written BEFORE the request is sent, with status "started", and completed
 * afterwards with the HTTP status, "timeout" or "network_error", so a crash cannot lose a call that
 * may already have been counted by the provider. Failed calls are counted in the budget too, since
 * the provider's own rule for them is not certain. `retry_after_seconds` is what a 429 asked for.
 */
export const provider_calls = pgTable(
  "provider_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    called_at: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    // For example "scheduled_refresh" or "manual_refresh".
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    vessels_requested: integer("vessels_requested").notNull(),
    retry_after_seconds: integer("retry_after_seconds"),
  },
  (t) => [index("provider_calls_provider_time_idx").on(t.provider, t.called_at)],
);

/** One run of the position refresh job, scheduled or manual, including runs that found nothing to do. */
export const tracking_runs = pgTable(
  "tracking_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: text("trigger").notNull(),
    provider: text("provider").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    vessels_selected: integer("vessels_selected").notNull().default(0),
    calls_made: integer("calls_made").notNull().default(0),
    positions_stored: integer("positions_stored").notNull().default(0),
    // Why the run stopped early or did nothing, for example "no_vessels" or "budget". Null when it ran to the end.
    stopped_reason: text("stopped_reason"),
    error: text("error"),
  },
  (t) => [index("tracking_runs_started_idx").on(t.started_at)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type OrgRole = typeof org_roles.$inferSelect;
export type DocumentType = typeof document_types.$inferSelect;
export type DocumentPermissionRule = typeof document_permission_rules.$inferSelect;
export type AuditLogRow = typeof audit_log.$inferSelect;
export type Consignment = typeof consignments.$inferSelect;
export type PurchaseOrder = typeof purchase_orders.$inferSelect;
export type DocumentChecklistItem = typeof document_checklist_items.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type WebhookEvent = typeof webhook_events.$inferSelect;
export type VesselPosition = typeof vessel_positions.$inferSelect;
export type ProviderCall = typeof provider_calls.$inferSelect;
export type TrackingRun = typeof tracking_runs.$inferSelect;
