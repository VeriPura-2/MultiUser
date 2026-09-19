CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"vessels_requested" integer NOT NULL,
	"retry_after_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "tracking_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"provider" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"vessels_selected" integer DEFAULT 0 NOT NULL,
	"calls_made" integer DEFAULT 0 NOT NULL,
	"positions_stored" integer DEFAULT 0 NOT NULL,
	"stopped_reason" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "provider_calls_provider_time_idx" ON "provider_calls" USING btree ("provider","called_at");--> statement-breakpoint
CREATE INDEX "tracking_runs_started_idx" ON "tracking_runs" USING btree ("started_at");