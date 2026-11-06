CREATE TABLE "author_workspace_slots" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"held_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"execution_task_id" uuid,
	"execution_job_id" uuid,
	"review_task_id" uuid,
	"paused_task_id" uuid,
	"switch_generation" bigint DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "author_workspace_slots_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id"),
	CONSTRAINT "author_workspace_slots_held" CHECK (cardinality("author_workspace_slots"."held_task_ids") <= 2 AND array_position("author_workspace_slots"."held_task_ids", NULL) IS NULL AND (cardinality("author_workspace_slots"."held_task_ids") < 2 OR "author_workspace_slots"."held_task_ids"[1] <> "author_workspace_slots"."held_task_ids"[2])),
	CONSTRAINT "author_workspace_slots_execution" CHECK (("author_workspace_slots"."execution_task_id" IS NULL OR "author_workspace_slots"."execution_task_id" = ANY("author_workspace_slots"."held_task_ids")) AND ("author_workspace_slots"."execution_job_id" IS NULL OR "author_workspace_slots"."execution_task_id" IS NOT NULL)),
	CONSTRAINT "author_workspace_slots_review" CHECK ("author_workspace_slots"."review_task_id" IS NULL OR "author_workspace_slots"."review_task_id" = ANY("author_workspace_slots"."held_task_ids")),
	CONSTRAINT "author_workspace_slots_paused" CHECK ("author_workspace_slots"."paused_task_id" IS NULL OR "author_workspace_slots"."paused_task_id" = ANY("author_workspace_slots"."held_task_ids")),
	CONSTRAINT "author_workspace_slots_counts" CHECK ("author_workspace_slots"."switch_generation" BETWEEN 0 AND 9007199254740991 AND "author_workspace_slots"."version" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "task_area_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"binding_version" bigint NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"area" text NOT NULL,
	"area_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "task_area_locks_nonempty" CHECK (length("task_area_locks"."area") BETWEEN 1 AND 4096 AND length("task_area_locks"."area_key") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
CREATE TABLE "task_workspace_merge_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"binding_version" bigint NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"submission_revision" bigint NOT NULL,
	"task_branch" text NOT NULL,
	"submitted_head_sha" text NOT NULL,
	"publication_receipt_id" uuid NOT NULL,
	"integration_kind" text NOT NULL,
	"integration_ref" text NOT NULL,
	"integration_commit_sha" text NOT NULL,
	"batch_or_release_id" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_workspace_receipts_target" UNIQUE("company_id","workspace_id","binding_version","submission_revision","integration_kind","integration_ref"),
	CONSTRAINT "task_workspace_receipts_pins" CHECK ("task_workspace_merge_receipts"."submitted_head_sha" ~ '^[0-9a-f]{40}$' AND "task_workspace_merge_receipts"."integration_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "task_workspace_receipts_target_kind" CHECK ("task_workspace_merge_receipts"."integration_kind" IN ('turn','main'))
);
--> statement-breakpoint
CREATE TABLE "task_workspace_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"job_id" uuid,
	"workspace_id" uuid,
	"assignment_epoch" bigint NOT NULL,
	"binding_version" bigint,
	"source_node" jsonb,
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "task_workspace_operations_idempotent" UNIQUE("company_id","idempotency_key"),
	CONSTRAINT "task_workspace_operations_pending" CHECK ("task_workspace_operations"."phase" <> 'pending_integration_plan' OR ("task_workspace_operations"."workspace_id" IS NULL AND "task_workspace_operations"."binding_version" IS NULL)),
	CONSTRAINT "task_workspace_operations_binding_pair" CHECK (("task_workspace_operations"."workspace_id" IS NULL) = ("task_workspace_operations"."binding_version" IS NULL)),
	CONSTRAINT "task_workspace_operations_counts" CHECK ("task_workspace_operations"."assignment_epoch" BETWEEN 0 AND 9007199254740991 AND "task_workspace_operations"."version" BETWEEN 0 AND 9007199254740991 AND ("task_workspace_operations"."binding_version" IS NULL OR "task_workspace_operations"."binding_version" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "task_workspace_operations_payload" CHECK (jsonb_typeof("task_workspace_operations"."payload") = 'object' AND octet_length("task_workspace_operations"."payload"::text) <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "task_workspace_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"binding_version" bigint NOT NULL,
	"provider" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"model" text,
	"instructions_hash" text NOT NULL,
	"native_session_id" text,
	"last_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "task_workspace_sessions_instructions" CHECK ("task_workspace_sessions"."instructions_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "task_workspace_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"binding_version" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"head_sha" text NOT NULL,
	"publication_receipt_id" uuid,
	"publication" jsonb,
	"source_operation_id" uuid,
	"phase" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	CONSTRAINT "task_workspace_submissions_revision" UNIQUE("company_id","workspace_id","binding_version","revision"),
	CONSTRAINT "task_workspace_submissions_revision_positive" CHECK ("task_workspace_submissions"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "task_workspace_submissions_pin" CHECK ("task_workspace_submissions"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "task_workspace_submissions_publication_pair" CHECK (("task_workspace_submissions"."publication_receipt_id" IS NULL) = ("task_workspace_submissions"."publication" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "task_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"node_id" uuid,
	"builtin" boolean NOT NULL,
	"assignment_epoch" bigint NOT NULL,
	"binding_version" bigint NOT NULL,
	"task_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"base_ref" text NOT NULL,
	"spec_version" integer DEFAULT 1 NOT NULL,
	"areas" jsonb NOT NULL,
	"required_integrations" jsonb NOT NULL,
	"phase" text DEFAULT 'reserved' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"submission_revision" bigint DEFAULT 0 NOT NULL,
	"switch_generation" bigint DEFAULT 0 NOT NULL,
	"problem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_workspaces_binding_identity" UNIQUE("company_id","id","binding_version"),
	CONSTRAINT "task_workspaces_node" CHECK (("task_workspaces"."builtin" AND "task_workspaces"."node_id" IS NULL) OR (NOT "task_workspaces"."builtin" AND "task_workspaces"."node_id" IS NOT NULL)),
	CONSTRAINT "task_workspaces_counts" CHECK ("task_workspaces"."assignment_epoch" BETWEEN 0 AND 9007199254740991 AND "task_workspaces"."binding_version" BETWEEN 1 AND 9007199254740991 AND "task_workspaces"."submission_revision" BETWEEN 0 AND 9007199254740991 AND "task_workspaces"."switch_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "task_workspaces_pin" CHECK ("task_workspaces"."base_sha" ~ '^[0-9a-f]{40}$' AND "task_workspaces"."spec_version" = 1 AND length("task_workspaces"."task_branch") BETWEEN 1 AND 240 AND length("task_workspaces"."base_ref") BETWEEN 1 AND 240),
	CONSTRAINT "task_workspaces_policy" CHECK (jsonb_typeof("task_workspaces"."areas") = 'array' AND jsonb_array_length("task_workspaces"."areas") > 0 AND octet_length("task_workspaces"."areas"::text) <= 65536 AND jsonb_typeof("task_workspaces"."required_integrations") = 'array' AND jsonb_array_length("task_workspaces"."required_integrations") > 0 AND octet_length("task_workspaces"."required_integrations"::text) <= 65536),
	CONSTRAINT "task_workspaces_phase" CHECK ("task_workspaces"."phase" IN ('reserved','preparing','work','submitting','submission_waiting','review','merge_pending','merged','cleanup_pending','removed','return_pending','pausing_other','paused','retained','problem'))
);
--> statement-breakpoint
CREATE TABLE "workspace_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_repositories_company_identity" UNIQUE("company_id","canonical_url"),
	CONSTRAINT "workspace_repositories_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "workspace_repositories_https" CHECK ("workspace_repositories"."canonical_url" ~ '^https://[^/@?#[:space:]]+/[^?#[:space:]]+$')
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "assignment_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "workspace_spec_version" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignment_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_execution_task_id_tasks_id_fk" FOREIGN KEY ("execution_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_execution_job_id_jobs_id_fk" FOREIGN KEY ("execution_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_review_task_id_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_workspace_slots" ADD CONSTRAINT "author_workspace_slots_paused_task_id_tasks_id_fk" FOREIGN KEY ("paused_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_area_locks" ADD CONSTRAINT "task_area_locks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_area_locks" ADD CONSTRAINT "task_area_locks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_area_locks" ADD CONSTRAINT "task_area_locks_binding_fk" FOREIGN KEY ("company_id","workspace_id","binding_version") REFERENCES "public"."task_workspaces"("company_id","id","binding_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_area_locks" ADD CONSTRAINT "task_area_locks_repository_fk" FOREIGN KEY ("company_id","repository_id") REFERENCES "public"."workspace_repositories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_merge_receipts" ADD CONSTRAINT "task_workspace_merge_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_merge_receipts" ADD CONSTRAINT "task_workspace_merge_receipts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_merge_receipts" ADD CONSTRAINT "task_workspace_merge_receipts_binding_fk" FOREIGN KEY ("company_id","workspace_id","binding_version") REFERENCES "public"."task_workspaces"("company_id","id","binding_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_merge_receipts" ADD CONSTRAINT "workspace_receipts_repository_fk" FOREIGN KEY ("company_id","repository_id") REFERENCES "public"."workspace_repositories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_merge_receipts" ADD CONSTRAINT "workspace_receipts_submission_fk" FOREIGN KEY ("company_id","workspace_id","binding_version","submission_revision") REFERENCES "public"."task_workspace_submissions"("company_id","workspace_id","binding_version","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_operations" ADD CONSTRAINT "task_workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_operations" ADD CONSTRAINT "task_workspace_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_operations" ADD CONSTRAINT "task_workspace_operations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_operations" ADD CONSTRAINT "task_workspace_operations_binding_fk" FOREIGN KEY ("company_id","workspace_id","binding_version") REFERENCES "public"."task_workspaces"("company_id","id","binding_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_sessions" ADD CONSTRAINT "task_workspace_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_sessions" ADD CONSTRAINT "task_workspace_sessions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_sessions" ADD CONSTRAINT "task_workspace_sessions_last_job_id_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_sessions" ADD CONSTRAINT "task_workspace_sessions_binding_fk" FOREIGN KEY ("company_id","workspace_id","binding_version") REFERENCES "public"."task_workspaces"("company_id","id","binding_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_submissions" ADD CONSTRAINT "task_workspace_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_submissions" ADD CONSTRAINT "task_workspace_submissions_source_operation_id_task_workspace_operations_id_fk" FOREIGN KEY ("source_operation_id") REFERENCES "public"."task_workspace_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_submissions" ADD CONSTRAINT "task_workspace_submissions_binding_fk" FOREIGN KEY ("company_id","workspace_id","binding_version") REFERENCES "public"."task_workspaces"("company_id","id","binding_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspaces" ADD CONSTRAINT "task_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspaces" ADD CONSTRAINT "task_workspaces_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspaces" ADD CONSTRAINT "task_workspaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspaces" ADD CONSTRAINT "task_workspaces_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspaces" ADD CONSTRAINT "task_workspaces_company_repository_fk" FOREIGN KEY ("company_id","repository_id") REFERENCES "public"."workspace_repositories"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_repositories" ADD CONSTRAINT "workspace_repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_area_locks_active_claim" ON "task_area_locks" USING btree ("company_id","workspace_id","area_key") WHERE "task_area_locks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_area_locks_repository" ON "task_area_locks" USING btree ("company_id","repository_id");--> statement-breakpoint
CREATE INDEX "task_workspace_operations_outbox" ON "task_workspace_operations" USING btree ("company_id","phase","created_at");--> statement-breakpoint
CREATE INDEX "task_workspace_sessions_lookup" ON "task_workspace_sessions" USING btree ("company_id","workspace_id","binding_version","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "task_workspaces_current_assignment" ON "task_workspaces" USING btree ("company_id","task_id","assignment_epoch") WHERE "task_workspaces"."is_current";--> statement-breakpoint
CREATE INDEX "task_workspaces_author_phase" ON "task_workspaces" USING btree ("company_id","agent_id","phase");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_task_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."task_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_workspace_id" ON "jobs" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assignment_epoch" CHECK ("jobs"."assignment_epoch" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_pair" CHECK (("jobs"."workspace_id" IS NULL AND "jobs"."workspace_spec_version" IS NULL) OR ("jobs"."workspace_id" IS NOT NULL AND "jobs"."workspace_spec_version" IS NOT NULL AND "jobs"."workspace_spec_version" > 0));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignment_epoch" CHECK ("tasks"."assignment_epoch" BETWEEN 0 AND 9007199254740991);