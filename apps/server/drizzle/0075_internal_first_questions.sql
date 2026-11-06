CREATE TABLE "computer_access_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"audience" text DEFAULT 'internal' NOT NULL,
	"question_revision" bigint DEFAULT 1 NOT NULL,
	"source_key" text,
	"source_job_id" uuid,
	"source_sequence" bigint,
	"triage_agent_id" uuid,
	"route_revision" bigint DEFAULT 1 NOT NULL,
	"classification" jsonb,
	"technical_text" text NOT NULL,
	"executor_instruction" text,
	"resolved_by_agent_id" uuid,
	"resolved_by_job_id" uuid,
	"resolved_source_sequence" bigint,
	"resolved_at" timestamp with time zone,
	"recovery_intent" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"apply_operation_id" uuid,
	"apply_revision" bigint,
	"apply_route_revision" bigint,
	"apply_control_revision" bigint,
	"apply_target_until" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_access_intents_source_episode" UNIQUE("company_id","source_key"),
	CONSTRAINT "computer_access_intents_question_audience" CHECK ("computer_access_intents"."audience" IN ('internal', 'human', 'legacy')),
	CONSTRAINT "computer_access_intents_question_revision" CHECK ("computer_access_intents"."question_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_route_revision" CHECK ("computer_access_intents"."route_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_source_sequence" CHECK ("computer_access_intents"."source_sequence" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_source_key" CHECK (length(btrim("computer_access_intents"."source_key")) BETWEEN 1 AND 512 AND "computer_access_intents"."source_key" !~ '[[:cntrl:]]'),
	CONSTRAINT "computer_access_intents_classification_bound" CHECK (jsonb_typeof("computer_access_intents"."classification") = 'object' AND octet_length("computer_access_intents"."classification"::text) <= 32768),
	CONSTRAINT "computer_access_intents_resolver_whole" CHECK (num_nonnulls("computer_access_intents"."resolved_by_agent_id", "computer_access_intents"."resolved_by_job_id", "computer_access_intents"."resolved_at") IN (0, 3)
    AND ("computer_access_intents"."resolved_source_sequence" IS NULL OR "computer_access_intents"."resolved_at" IS NOT NULL)),
	CONSTRAINT "computer_access_intents_resolver_sequence" CHECK ("computer_access_intents"."resolved_source_sequence" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_recovery_bound" CHECK (jsonb_typeof("computer_access_intents"."recovery_intent") = 'object' AND octet_length("computer_access_intents"."recovery_intent"::text) <= 32768),
	CONSTRAINT "computer_access_intents_status" CHECK ("computer_access_intents"."status" IN ('open', 'resolved_internal', 'granted', 'declined', 'withdrawn', 'apply_unknown')),
	CONSTRAINT "computer_access_intents_apply_whole" CHECK (num_nonnulls("computer_access_intents"."apply_operation_id", "computer_access_intents"."apply_revision", "computer_access_intents"."apply_route_revision", "computer_access_intents"."apply_control_revision", "computer_access_intents"."apply_target_until") IN (0, 5)),
	CONSTRAINT "computer_access_intents_apply_started" CHECK ("computer_access_intents"."apply_operation_id" IS NULL OR "computer_access_intents"."status" IN ('apply_unknown', 'granted', 'declined', 'withdrawn')),
	CONSTRAINT "computer_access_intents_apply_revision" CHECK ("computer_access_intents"."apply_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_apply_route_revision" CHECK ("computer_access_intents"."apply_route_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_apply_control_revision" CHECK ("computer_access_intents"."apply_control_revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "computer_access_intents_apply_outcome" CHECK (
    ("computer_access_intents"."status" NOT IN ('apply_unknown', 'granted') OR "computer_access_intents"."apply_operation_id" IS NOT NULL)
    AND ("computer_access_intents"."status" <> 'granted' OR "computer_access_intents"."applied_at" IS NOT NULL)
    AND ("computer_access_intents"."applied_at" IS NULL OR "computer_access_intents"."status" = 'granted'))
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "audience" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "question_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "source_job_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "source_sequence" bigint;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "triage_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "route_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "technical_text" text;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "executor_instruction" text;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "resolved_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "resolved_by_job_id" uuid;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "resolved_source_sequence" bigint;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_internal" ADD COLUMN "recovery_intent" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "audience" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "question_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "source_job_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "source_sequence" bigint;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "triage_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "route_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_triage_agent_id_agents_id_fk" FOREIGN KEY ("triage_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_access_intents" ADD CONSTRAINT "computer_access_intents_resolved_by_job_id_jobs_id_fk" FOREIGN KEY ("resolved_by_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_triage_agent_id_agents_id_fk" FOREIGN KEY ("triage_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_resolved_by_job_id_jobs_id_fk" FOREIGN KEY ("resolved_by_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_company_request" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_triage_agent_id_agents_id_fk" FOREIGN KEY ("triage_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_episode" UNIQUE("company_id","source_key");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_source_episode" UNIQUE("company_id","source_key");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_question_audience" CHECK ("proposals"."audience" IN ('internal', 'human', 'legacy'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_question_revision" CHECK ("proposals"."question_revision" BETWEEN 1 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_route_revision" CHECK ("proposals"."route_revision" BETWEEN 1 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_sequence" CHECK ("proposals"."source_sequence" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_key" CHECK (length(btrim("proposals"."source_key")) BETWEEN 1 AND 512 AND "proposals"."source_key" !~ '[[:cntrl:]]');--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_classification_bound" CHECK (jsonb_typeof("proposals"."classification") = 'object' AND octet_length("proposals"."classification"::text) <= 32768);--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_resolver_whole" CHECK (num_nonnulls("request_internal"."resolved_by_agent_id", "request_internal"."resolved_by_job_id", "request_internal"."resolved_at") IN (0, 3)
    AND ("request_internal"."resolved_source_sequence" IS NULL OR "request_internal"."resolved_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_resolver_sequence" CHECK ("request_internal"."resolved_source_sequence" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_recovery_bound" CHECK (jsonb_typeof("request_internal"."recovery_intent") = 'object' AND octet_length("request_internal"."recovery_intent"::text) <= 32768);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_question_audience" CHECK ("requests"."audience" IN ('internal', 'human', 'legacy'));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_question_revision" CHECK ("requests"."question_revision" BETWEEN 1 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_route_revision" CHECK ("requests"."route_revision" BETWEEN 1 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_source_sequence" CHECK ("requests"."source_sequence" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_source_key" CHECK (length(btrim("requests"."source_key")) BETWEEN 1 AND 512 AND "requests"."source_key" !~ '[[:cntrl:]]');--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_classification_bound" CHECK (jsonb_typeof("requests"."classification") = 'object' AND octet_length("requests"."classification"::text) <= 32768);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_internal_not_person_answer" CHECK ("requests"."status" <> 'resolved_internal' OR
      num_nonnulls("requests"."answered_by", "requests"."answered_by_agent_id", "requests"."answer_job_id", "requests"."answer_source_seq", "requests"."answered_at") = 0);--> statement-breakpoint
-- Keep source identity and every historical decision. No original job is inferred from a later answer.
-- An open stuck note names no head or orchestrator who could answer it, so it stays with the people it asked.
UPDATE "requests" SET "audience" = CASE WHEN "status" = 'open' AND "kind" = 'stuck' THEN 'human' WHEN "status" = 'open' THEN 'internal' ELSE 'legacy' END,
  "source_key" = 'legacy:task_request:' || "id"::text;--> statement-breakpoint
UPDATE "proposals" SET "audience" = CASE WHEN "status" = 'pending' THEN 'internal' ELSE 'legacy' END,
  "source_key" = 'legacy:proposal:' || "id"::text, "source_job_id" = "job_id";--> statement-breakpoint
-- Preserve sealed material history and raw source bytes; do not route, answer or replay a job here.
INSERT INTO "request_internal" ("request_id", "company_id", "technical_text")
  SELECT "id", "company_id", "text" FROM "requests" WHERE "status" = 'open'
  ON CONFLICT ("request_id") DO UPDATE
  SET "technical_text" = COALESCE("request_internal"."technical_text", EXCLUDED."technical_text");
