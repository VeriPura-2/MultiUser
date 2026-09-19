import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
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
  (t) => [uniqueIndex("document_types_name_uniq").on(t.name)],
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
// Row types
// ---------------------------------------------------------------------------

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type OrgRole = typeof org_roles.$inferSelect;
export type DocumentType = typeof document_types.$inferSelect;
export type DocumentPermissionRule = typeof document_permission_rules.$inferSelect;
export type AuditLogRow = typeof audit_log.$inferSelect;
