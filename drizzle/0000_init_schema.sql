CREATE TYPE "public"."billing_status" AS ENUM('trial', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('pending_approval', 'active', 'suspended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('importer', 'exporter', 'logistics', 'lab_cert', 'data_source');--> statement-breakpoint
CREATE TYPE "public"."rule_org_type" AS ENUM('importer', 'exporter', 'logistics', 'lab_cert', 'data_source', 'veripura_superadmin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."view_level" AS ENUM('full', 'status_only', 'hidden');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_permission_rules" (
	"document_type_id" uuid NOT NULL,
	"org_type" "rule_org_type" NOT NULL,
	"org_role_name" text NOT NULL,
	"view_level" "view_level" NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_download" boolean DEFAULT false NOT NULL,
	"can_approve" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_permission_rules_document_type_id_org_type_org_role_name_pk" PRIMARY KEY("document_type_id","org_type","org_role_name"),
	CONSTRAINT "dpr_grants_require_full_view" CHECK ("document_permission_rules"."view_level" = 'full' OR (NOT "document_permission_rules"."can_edit" AND NOT "document_permission_rules"."can_download" AND NOT "document_permission_rules"."can_approve")),
	CONSTRAINT "dpr_no_superadmin_rows" CHECK ("document_permission_rules"."org_type" <> 'veripura_superadmin')
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "org_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_org_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"org_type" "org_type" NOT NULL,
	"status" "org_status" DEFAULT 'pending_approval' NOT NULL,
	"billing_status" "billing_status" DEFAULT 'trial' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role_assignments" (
	"user_id" uuid NOT NULL,
	"org_role_id" uuid NOT NULL,
	CONSTRAINT "user_role_assignments_user_id_org_role_id_pk" PRIMARY KEY("user_id","org_role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permission_rules" ADD CONSTRAINT "document_permission_rules_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_org_role_id_org_roles_id_fk" FOREIGN KEY ("org_role_id") REFERENCES "public"."org_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_name_uniq" ON "document_types" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_org_name_uniq" ON "org_roles" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "ura_org_role_id_idx" ON "user_role_assignments" USING btree ("org_role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uniq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_organization_id_idx" ON "users" USING btree ("organization_id");