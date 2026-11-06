ALTER TABLE "turns" ADD CONSTRAINT "turns_company_id" UNIQUE("company_id","id");
--> statement-breakpoint
CREATE TABLE "staging_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_generation" bigint NOT NULL,
	"base_sha" text NOT NULL,
	"submission_ids" uuid[] NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"phase" text DEFAULT 'preparing' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "staging_batches_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "staging_batches_idempotent" UNIQUE("company_id","idempotency_key"),
	CONSTRAINT "staging_batches_counts" CHECK ("staging_batches"."version" BETWEEN 0 AND 9007199254740991 AND "staging_batches"."plan_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "staging_batches_members" CHECK (cardinality("staging_batches"."submission_ids") > 0 AND array_position("staging_batches"."submission_ids", NULL) IS NULL),
	CONSTRAINT "staging_batches_snapshot" CHECK (jsonb_typeof("staging_batches"."source_snapshot") = 'array' AND jsonb_array_length("staging_batches"."source_snapshot") > 0 AND octet_length("staging_batches"."source_snapshot"::text) <= 65536),
	CONSTRAINT "staging_batches_pin" CHECK ("staging_batches"."base_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "staging_batches_key" CHECK (length("staging_batches"."idempotency_key") BETWEEN 1 AND 512),
	CONSTRAINT "staging_batches_phase" CHECK ("staging_batches"."phase" IN ('preparing','checking','splitting','ready','publishing','published','blocked','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "staging_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"trial_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"expected_ref" text,
	"expected_before_sha" text,
	"expected_after_sha" text,
	"run_id" uuid,
	"source_node" jsonb,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "staging_operations_idempotent" UNIQUE("company_id","idempotency_key"),
	CONSTRAINT "staging_operations_kind" CHECK ("staging_operations"."kind" IN ('prepare','publish_trial','publish_staging','publish_turn')),
	CONSTRAINT "staging_operations_phase" CHECK ("staging_operations"."phase" IN ('queued','sent','confirmed','conflict','unavailable','cancelled')),
	CONSTRAINT "staging_operations_version" CHECK ("staging_operations"."version" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "staging_operations_key" CHECK (length("staging_operations"."idempotency_key") BETWEEN 1 AND 512),
	CONSTRAINT "staging_operations_pins" CHECK ("staging_operations"."expected_before_sha" ~ '^[0-9a-f]{40}$' AND "staging_operations"."expected_after_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "staging_operations_payload" CHECK (jsonb_typeof("staging_operations"."payload") = 'object' AND octet_length("staging_operations"."payload"::text) <= 1048576),
	CONSTRAINT "staging_operations_confirmed" CHECK ("staging_operations"."phase" <> 'confirmed' OR ("staging_operations"."result" IS NOT NULL AND "staging_operations"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "staging_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"required_integrations" jsonb NOT NULL,
	"health_run_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_batch_size" integer DEFAULT 4 NOT NULL,
	"max_wait_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staging_plans_generation" UNIQUE("company_id","id","generation"),
	CONSTRAINT "staging_plans_counts" CHECK ("staging_plans"."generation" BETWEEN 1 AND 9007199254740991 AND "staging_plans"."max_batch_size" BETWEEN 1 AND 9007199254740991 AND "staging_plans"."max_wait_ms" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "staging_plans_pin" CHECK ("staging_plans"."base_sha" ~ '^[0-9a-f]{40}$' AND length("staging_plans"."base_ref") BETWEEN 1 AND 240),
	CONSTRAINT "staging_plans_targets" CHECK (jsonb_typeof("staging_plans"."required_integrations") = 'array' AND jsonb_array_length("staging_plans"."required_integrations") > 0 AND octet_length("staging_plans"."required_integrations"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "staging_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"submission_ids" uuid[] NOT NULL,
	"candidate_sha" text,
	"candidate_ref" text,
	"tree_sha" text,
	"test_run_id" uuid,
	"part_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"failure" jsonb,
	"phase" text DEFAULT 'preparing' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staging_trials_batch_identity" UNIQUE("company_id","batch_id","id"),
	CONSTRAINT "staging_trials_ordinal" UNIQUE("company_id","batch_id","ordinal"),
	CONSTRAINT "staging_trials_counts" CHECK ("staging_trials"."ordinal" BETWEEN 1 AND 9007199254740991 AND "staging_trials"."version" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "staging_trials_members" CHECK (cardinality("staging_trials"."submission_ids") > 0 AND array_position("staging_trials"."submission_ids", NULL) IS NULL),
	CONSTRAINT "staging_trials_pins" CHECK ("staging_trials"."candidate_sha" ~ '^[0-9a-f]{40}$' AND "staging_trials"."tree_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "staging_trials_phase" CHECK ("staging_trials"."phase" IN ('preparing','prepared','checking','passed','failed','unattributed','conflict','publishing','published','stale','cancelled')),
	CONSTRAINT "staging_trials_checked" CHECK ("staging_trials"."phase" NOT IN ('passed','failed','unattributed','publishing','published') OR ("staging_trials"."candidate_sha" IS NOT NULL AND "staging_trials"."test_run_id" IS NOT NULL AND cardinality("staging_trials"."part_ids") > 0))
);
--> statement-breakpoint
ALTER TABLE "staging_batches" ADD CONSTRAINT "staging_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_batches" ADD CONSTRAINT "staging_batches_plan_fk" FOREIGN KEY ("company_id","plan_id","plan_generation") REFERENCES "public"."staging_plans"("company_id","id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_operations" ADD CONSTRAINT "staging_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_operations" ADD CONSTRAINT "staging_operations_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_operations" ADD CONSTRAINT "staging_operations_trial_fk" FOREIGN KEY ("company_id","batch_id","trial_id") REFERENCES "public"."staging_trials"("company_id","batch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_plans" ADD CONSTRAINT "staging_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_plans" ADD CONSTRAINT "staging_plans_health_run_id_test_runs_id_fk" FOREIGN KEY ("health_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_plans" ADD CONSTRAINT "staging_plans_repository_fk" FOREIGN KEY ("company_id","repository_id") REFERENCES "public"."workspace_repositories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_plans" ADD CONSTRAINT "staging_plans_turn_fk" FOREIGN KEY ("company_id","turn_id") REFERENCES "public"."turns"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_trials" ADD CONSTRAINT "staging_trials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_trials" ADD CONSTRAINT "staging_trials_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging_trials" ADD CONSTRAINT "staging_trials_batch_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."staging_batches"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staging_batches_plan_phase" ON "staging_batches" USING btree ("company_id","plan_id","phase");--> statement-breakpoint
CREATE INDEX "staging_operations_pending" ON "staging_operations" USING btree ("company_id","phase","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staging_plans_current_root" ON "staging_plans" USING btree ("company_id","repository_id","turn_id") WHERE "staging_plans"."is_current";--> statement-breakpoint
