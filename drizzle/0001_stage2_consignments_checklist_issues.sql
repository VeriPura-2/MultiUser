CREATE TYPE "public"."checklist_item_status" AS ENUM('awaiting_upload', 'pending', 'verified', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."checklist_required_by" AS ENUM('importer', 'exporter', 'logistics');--> statement-breakpoint
CREATE TYPE "public"."consignment_status" AS ENUM('po_submitted', 'checklist_pending', 'checklist_received', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'correction_requested', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."webhook_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('sent', 'received', 'failed');--> statement-breakpoint
CREATE TABLE "consignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_core_id" text,
	"importer_org_id" uuid NOT NULL,
	"exporter_org_id" uuid NOT NULL,
	"status" "consignment_status" DEFAULT 'po_submitted' NOT NULL,
	"commodity" text NOT NULL,
	"hs_code" text,
	"origin_country" text NOT NULL,
	"destination_country" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignments_distinct_parties" CHECK ("consignments"."importer_org_id" <> "consignments"."exporter_org_id")
);
--> statement-breakpoint
CREATE TABLE "document_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consignment_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"required_by" "checklist_required_by" NOT NULL,
	"status" "checklist_item_status" DEFAULT 'awaiting_upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_checklist_item_id" uuid NOT NULL,
	"consignment_id" uuid NOT NULL,
	"problem" text NOT NULL,
	"expected_value" text,
	"found_value" text,
	"source_document_checklist_item_id" uuid,
	"responsible_org_type" "org_type" NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "issues_resolved_at_matches_status" CHECK (("issues"."status" = 'resolved') = ("issues"."resolved_at" IS NOT NULL)),
	CONSTRAINT "issues_source_differs_from_item" CHECK ("issues"."source_document_checklist_item_id" IS NULL OR "issues"."source_document_checklist_item_id" <> "issues"."document_checklist_item_id")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consignment_id" uuid NOT NULL,
	"file_url" text NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consignment_id" uuid,
	"direction" "webhook_direction" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "document_types_name_uniq";--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_importer_org_id_organizations_id_fk" FOREIGN KEY ("importer_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_exporter_org_id_organizations_id_fk" FOREIGN KEY ("exporter_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_checklist_items" ADD CONSTRAINT "document_checklist_items_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_checklist_items" ADD CONSTRAINT "document_checklist_items_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_document_checklist_item_id_document_checklist_items_id_fk" FOREIGN KEY ("document_checklist_item_id") REFERENCES "public"."document_checklist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_source_document_checklist_item_id_document_checklist_items_id_fk" FOREIGN KEY ("source_document_checklist_item_id") REFERENCES "public"."document_checklist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consignments_importer_idx" ON "consignments" USING btree ("importer_org_id");--> statement-breakpoint
CREATE INDEX "consignments_exporter_idx" ON "consignments" USING btree ("exporter_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_items_consignment_doctype_reqby_uniq" ON "document_checklist_items" USING btree ("consignment_id","document_type_id","required_by");--> statement-breakpoint
CREATE INDEX "issues_item_idx" ON "issues" USING btree ("document_checklist_item_id");--> statement-breakpoint
CREATE INDEX "issues_consignment_status_idx" ON "issues" USING btree ("consignment_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_consignment_idx" ON "purchase_orders" USING btree ("consignment_id");--> statement-breakpoint
CREATE INDEX "webhook_events_consignment_idx" ON "webhook_events" USING btree ("consignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_name_uniq" ON "document_types" USING btree (lower("name"));