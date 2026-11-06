CREATE TABLE "model_check_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"jsonl_enc" text NOT NULL,
	"cases" integer NOT NULL,
	"holdout_cases" integer NOT NULL,
	"must_block_cases" integer NOT NULL,
	"added_by_kind" text NOT NULL,
	"added_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_check_datasets_version" UNIQUE("check_id","version"),
	CONSTRAINT "model_check_datasets_added_by" CHECK ("model_check_datasets"."added_by_kind" IN ('person', 'agent')),
	CONSTRAINT "model_check_datasets_counts" CHECK ("model_check_datasets"."cases" > 0 AND "model_check_datasets"."holdout_cases" >= 0 AND "model_check_datasets"."must_block_cases" >= 0 AND "model_check_datasets"."holdout_cases" <= "model_check_datasets"."cases" AND "model_check_datasets"."must_block_cases" <= "model_check_datasets"."cases")
);
--> statement-breakpoint
CREATE TABLE "model_check_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"binding" jsonb NOT NULL,
	"binding_digest" text NOT NULL,
	"trigger" text NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"infra_errors" integer DEFAULT 0 NOT NULL,
	"must_block_misses" integer DEFAULT 0 NOT NULL,
	"metrics" jsonb,
	"holdout_metrics" jsonb,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missed_dev_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_check_evaluations_dedup" UNIQUE("check_id","dedup_key"),
	CONSTRAINT "model_check_evaluations_trigger" CHECK ("model_check_evaluations"."trigger" IN ('change', 'weekly')),
	CONSTRAINT "model_check_evaluations_status" CHECK ("model_check_evaluations"."status" IN ('queued', 'running', 'passed', 'failed', 'incomplete')),
	CONSTRAINT "model_check_evaluations_ended" CHECK (("model_check_evaluations"."status" IN ('queued', 'running')) = ("model_check_evaluations"."finished_at" IS NULL)),
	CONSTRAINT "model_check_evaluations_clean_pass" CHECK ("model_check_evaluations"."status" <> 'passed' OR ("model_check_evaluations"."complete" AND "model_check_evaluations"."infra_errors" = 0 AND "model_check_evaluations"."must_block_misses" = 0 AND "model_check_evaluations"."metrics" IS NOT NULL AND "model_check_evaluations"."holdout_metrics" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "model_check_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"checker_code_hash" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"output_schema_hash" text NOT NULL,
	"source_list_hash" text NOT NULL,
	"taxonomy_hash" text,
	"model" jsonb NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_check_revisions_version" UNIQUE("check_id","definition_version"),
	CONSTRAINT "model_check_revisions_author" CHECK ("model_check_revisions"."author_kind" IN ('person', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "model_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"product_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'off' NOT NULL,
	"off_reason" text,
	"binding_digest" text,
	"valid_until" timestamp with time zone,
	"thresholds" jsonb,
	"thresholds_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_checks_place" UNIQUE NULLS NOT DISTINCT("department_id","product_id","kind"),
	CONSTRAINT "model_checks_status" CHECK ("model_checks"."status" IN ('off', 'on')),
	CONSTRAINT "model_checks_on_is_bound" CHECK ("model_checks"."status" = 'off' OR ("model_checks"."binding_digest" IS NOT NULL AND "model_checks"."valid_until" IS NOT NULL AND "model_checks"."thresholds" IS NOT NULL AND "model_checks"."off_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "model_check_datasets" ADD CONSTRAINT "model_check_datasets_check_id_model_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."model_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_check_evaluations" ADD CONSTRAINT "model_check_evaluations_check_id_model_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."model_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_check_evaluations" ADD CONSTRAINT "model_check_evaluations_revision_id_model_check_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."model_check_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_check_evaluations" ADD CONSTRAINT "model_check_evaluations_dataset_id_model_check_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."model_check_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_check_revisions" ADD CONSTRAINT "model_check_revisions_check_id_model_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."model_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_product_id_departments_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_thresholds_by_people_id_fk" FOREIGN KEY ("thresholds_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_check_evaluations_pending" ON "model_check_evaluations" USING btree ("created_at") WHERE "model_check_evaluations"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "model_check_evaluations_finished" ON "model_check_evaluations" USING btree ("check_id","finished_at");--> statement-breakpoint
CREATE INDEX "model_checks_company_id" ON "model_checks" USING btree ("company_id");