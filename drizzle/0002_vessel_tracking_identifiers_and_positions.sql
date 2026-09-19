CREATE TABLE "vessel_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vessel_imo" text,
	"vessel_mmsi" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"speed_knots" double precision,
	"heading_deg" double precision,
	"nav_status" integer,
	"position_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "vessel_positions_has_identifier" CHECK ("vessel_positions"."vessel_imo" IS NOT NULL OR "vessel_positions"."vessel_mmsi" IS NOT NULL),
	CONSTRAINT "vessel_positions_lat_range" CHECK ("vessel_positions"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "vessel_positions_lng_range" CHECK ("vessel_positions"."lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "vessel_imo" text;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "vessel_mmsi" text;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "vessel_name" text;--> statement-breakpoint
CREATE INDEX "vessel_positions_mmsi_time_idx" ON "vessel_positions" USING btree ("vessel_mmsi","position_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vessel_positions_imo_time_idx" ON "vessel_positions" USING btree ("vessel_imo","position_time" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "vessel_positions_mmsi_time_uniq" ON "vessel_positions" USING btree ("vessel_mmsi","position_time") WHERE "vessel_positions"."vessel_mmsi" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vessel_positions_imo_time_uniq" ON "vessel_positions" USING btree ("vessel_imo","position_time") WHERE "vessel_positions"."vessel_mmsi" IS NULL AND "vessel_positions"."vessel_imo" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_vessel_imo_format" CHECK ("consignments"."vessel_imo" IS NULL OR "consignments"."vessel_imo" ~ '^[0-9]{7}$');--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_vessel_mmsi_format" CHECK ("consignments"."vessel_mmsi" IS NULL OR "consignments"."vessel_mmsi" ~ '^[0-9]{9}$');