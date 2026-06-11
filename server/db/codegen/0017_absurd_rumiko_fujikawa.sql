CREATE TABLE "tentix"."issue_canonical" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(254) NOT NULL,
	"summary" text NOT NULL,
	"primary_module" varchar(50) DEFAULT '' NOT NULL,
	"first_seen_week" date NOT NULL,
	"last_seen_week" date NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"merged_into" integer,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tentix"."issue_cluster_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"run_type" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"run_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"ticket_count" integer DEFAULT 0 NOT NULL,
	"cluster_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tentix"."weekly_issue_cluster" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"week_start" date NOT NULL,
	"run_type" varchar(20) NOT NULL,
	"run_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"canonical_id" integer,
	"stable_key" varchar(254) NOT NULL,
	"summary" text NOT NULL,
	"count" integer NOT NULL,
	"ticket_ids" char(13)[] NOT NULL,
	"representative_ticket_id" char(13) NOT NULL,
	"avg_confidence" real DEFAULT 0 NOT NULL,
	"module" varchar(50) DEFAULT '' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tentix"."weekly_issue_cluster" ADD CONSTRAINT "weekly_issue_cluster_run_id_issue_cluster_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "tentix"."issue_cluster_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tentix"."weekly_issue_cluster" ADD CONSTRAINT "weekly_issue_cluster_canonical_id_issue_canonical_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "tentix"."issue_canonical"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_canonical_status" ON "tentix"."issue_canonical" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_issue_canonical_last_seen_week" ON "tentix"."issue_canonical" USING btree ("last_seen_week" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_issue_canonical_primary_module" ON "tentix"."issue_canonical" USING btree ("primary_module");--> statement-breakpoint
CREATE INDEX "idx_issue_cluster_run_type_week" ON "tentix"."issue_cluster_run" USING btree ("run_type","week_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_issue_cluster_run_status" ON "tentix"."issue_cluster_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_issue_cluster_run_run_at" ON "tentix"."issue_cluster_run" USING btree ("run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_weekly_issue_cluster_run_id" ON "tentix"."weekly_issue_cluster" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_weekly_issue_cluster_week_start" ON "tentix"."weekly_issue_cluster" USING btree ("week_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_weekly_issue_cluster_canonical_id" ON "tentix"."weekly_issue_cluster" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "idx_weekly_issue_cluster_week_canonical" ON "tentix"."weekly_issue_cluster" USING btree ("week_start","canonical_id");--> statement-breakpoint
CREATE INDEX "idx_weekly_issue_cluster_run_type_week" ON "tentix"."weekly_issue_cluster" USING btree ("run_type","week_start" DESC NULLS LAST);