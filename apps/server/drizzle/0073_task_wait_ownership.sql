CREATE TABLE "task_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"source_revision" integer NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"owner_agent_id" uuid,
	"owner_person_id" uuid,
	"plan" jsonb,
	"owner_due_at" timestamp with time zone,
	"head_due_at" timestamp with time zone,
	"decision_due_at" timestamp with time zone,
	"level" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"review_ordinal" integer DEFAULT 0 NOT NULL,
	"next_review_at" timestamp with time zone,
	"attention_agent_id" uuid,
	"attention_person_id" uuid,
	"final_decision_person_id" uuid,
	"fallback_to_ceo" boolean DEFAULT false NOT NULL,
	"route_revision" integer DEFAULT 0 NOT NULL,
	"source_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text,
	"proof_ref" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_waits_kind" CHECK ("task_waits"."kind" IN ('after', 'review', 'person', 'run', 'external')),
	CONSTRAINT "task_waits_state" CHECK ("task_waits"."state" IN ('active', 'resolved', 'cancelled', 'superseded', 'legacy_needs_plan')),
	CONSTRAINT "task_waits_counts" CHECK ("task_waits"."source_revision" >= 0 AND "task_waits"."generation" >= 1 AND "task_waits"."review_ordinal" >= 0 AND "task_waits"."route_revision" >= 0 AND "task_waits"."level" BETWEEN 0 AND 3),
	CONSTRAINT "task_waits_one_owner" CHECK ("task_waits"."owner_agent_id" IS NULL OR "task_waits"."owner_person_id" IS NULL),
	CONSTRAINT "task_waits_one_attention" CHECK ("task_waits"."attention_agent_id" IS NULL OR "task_waits"."attention_person_id" IS NULL),
	CONSTRAINT "task_waits_active_is_whole" CHECK ("task_waits"."state" <> 'active' OR (
    ("task_waits"."owner_agent_id" IS NULL) <> ("task_waits"."owner_person_id" IS NULL) AND "task_waits"."plan" IS NOT NULL AND "task_waits"."owner_due_at" IS NOT NULL AND "task_waits"."head_due_at" IS NOT NULL
    AND "task_waits"."decision_due_at" IS NOT NULL AND "task_waits"."next_action_at" IS NOT NULL)),
	CONSTRAINT "task_waits_reviews_go_on" CHECK ("task_waits"."state" <> 'active' OR "task_waits"."next_review_at" IS NOT NULL OR ("task_waits"."review_ordinal" >= 1 AND "task_waits"."kind" = 'external' AND "task_waits"."source_key" LIKE 'operation:%')),
	CONSTRAINT "task_waits_legacy_has_no_dates" CHECK ("task_waits"."state" <> 'legacy_needs_plan' OR ("task_waits"."plan" IS NULL AND "task_waits"."owner_due_at" IS NULL AND "task_waits"."head_due_at" IS NULL AND "task_waits"."decision_due_at" IS NULL AND "task_waits"."next_action_at" IS NULL AND "task_waits"."next_review_at" IS NULL)),
	CONSTRAINT "task_waits_ended" CHECK (("task_waits"."state" IN ('active', 'legacy_needs_plan')) = ("task_waits"."ended_at" IS NULL AND "task_waits"."outcome" IS NULL AND "task_waits"."proof_ref" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "wait_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stage" text DEFAULT '' NOT NULL,
	"version" integer NOT NULL,
	"owner_ms" bigint NOT NULL,
	"head_ms" bigint NOT NULL,
	"decision_ms" bigint NOT NULL,
	"review_interval_ms" bigint NOT NULL,
	"created_by_person_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wait_policies_version" UNIQUE("company_id","department_id","kind","stage","version"),
	CONSTRAINT "wait_policies_order" CHECK ("wait_policies"."owner_ms" > 0 AND "wait_policies"."owner_ms" <= "wait_policies"."head_ms" AND "wait_policies"."head_ms" <= "wait_policies"."decision_ms" AND "wait_policies"."review_interval_ms" > 0 AND "wait_policies"."version" >= 1),
	CONSTRAINT "wait_policies_kind" CHECK ("wait_policies"."kind" IN ('after', 'review', 'person', 'run', 'external')),
	CONSTRAINT "wait_policies_one_author" CHECK (("wait_policies"."created_by_person_id" IS NULL) <> ("wait_policies"."created_by_agent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "wait_id" uuid;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "generation" integer;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "level" integer;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD COLUMN "route_revision" integer;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_attention_agent_id_agents_id_fk" FOREIGN KEY ("attention_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_attention_person_id_people_id_fk" FOREIGN KEY ("attention_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_waits" ADD CONSTRAINT "task_waits_final_decision_person_id_people_id_fk" FOREIGN KEY ("final_decision_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_policies" ADD CONSTRAINT "wait_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_policies" ADD CONSTRAINT "wait_policies_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_policies" ADD CONSTRAINT "wait_policies_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_policies" ADD CONSTRAINT "wait_policies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_waits_open_source" ON "task_waits" USING btree ("company_id","task_id","kind","source_key") WHERE "task_waits"."state" IN ('active', 'legacy_needs_plan');--> statement-breakpoint
CREATE INDEX "task_waits_task" ON "task_waits" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_waits_next_action" ON "task_waits" USING btree ("next_action_at") WHERE "task_waits"."state" = 'active';--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_wait_id_task_waits_id_fk" FOREIGN KEY ("wait_id") REFERENCES "public"."task_waits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wait_notices_one_per_level" ON "wait_notices" USING btree ("wait_id","generation","level","purpose","route_revision") WHERE "wait_notices"."wait_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_wait_whole" CHECK ("wait_notices"."wait_id" IS NULL OR ("wait_notices"."generation" IS NOT NULL AND "wait_notices"."level" IS NOT NULL AND "wait_notices"."purpose" IS NOT NULL AND "wait_notices"."route_revision" IS NOT NULL));
--> statement-breakpoint
-- Every source open today gets its wait, in every company: what is known stays, and no plan, date, level or alarm is made up.
UPDATE "tasks" SET "external_wait" = "external_wait" || jsonb_build_object('operation', gen_random_uuid())
  WHERE "external_wait" IS NOT NULL AND "status" NOT IN ('done', 'cancelled') AND ("external_wait"->>'operation') IS NULL;
--> statement-breakpoint
INSERT INTO "task_waits" ("company_id", "task_id", "kind", "source_key", "source_revision", "state", "owner_agent_id", "source_state")
  SELECT t."company_id", t."id", 'external', 'wait_for:' || (t."external_wait"->>'operation'), 0, 'legacy_needs_plan', COALESCE(named."id", t."assignee_agent_id"), '{"stage":"waiting"}'::jsonb
  FROM "tasks" t
  LEFT JOIN "agents" named ON t."external_wait"->'on'->>'kind' = 'employee' AND named."id"::text = t."external_wait"->'on'->>'employee' AND named."company_id" = t."company_id"
  WHERE t."external_wait" IS NOT NULL AND t."status" NOT IN ('done', 'cancelled');
--> statement-breakpoint
INSERT INTO "task_waits" ("company_id", "task_id", "kind", "source_key", "source_revision", "state", "owner_agent_id")
  SELECT r."company_id", r."task_id", 'run', 'run:' || r."id", 0, 'legacy_needs_plan', r."agent_id"
  FROM "test_runs" r JOIN "tasks" t ON t."id" = r."task_id"
  WHERE r."status" = 'running' AND t."status" NOT IN ('done', 'cancelled');
--> statement-breakpoint
INSERT INTO "task_waits" ("company_id", "task_id", "kind", "source_key", "source_revision", "state", "owner_agent_id")
  SELECT DISTINCT t."company_id", t."id", 'after', 'task:' || p."id", 0, 'legacy_needs_plan', p."assignee_agent_id"
  FROM "tasks" t CROSS JOIN LATERAL jsonb_array_elements_text(t."after") AS edge(prerequisite)
  JOIN "tasks" p ON p."id"::text = edge.prerequisite AND p."company_id" = t."company_id"
  WHERE t."status" NOT IN ('done', 'cancelled') AND p."status" <> 'done';
--> statement-breakpoint
INSERT INTO "task_waits" ("company_id", "task_id", "kind", "source_key", "source_revision", "state")
  SELECT r."company_id", r."task_id", 'person', 'request:' || r."id", 0, 'legacy_needs_plan'
  FROM "requests" r JOIN "tasks" t ON t."id" = r."task_id"
  WHERE r."status" = 'open' AND t."status" NOT IN ('done', 'cancelled');
--> statement-breakpoint
INSERT INTO "task_waits" ("company_id", "task_id", "kind", "source_key", "source_revision", "state", "owner_agent_id")
  SELECT DISTINCT t."company_id", t."id", 'review', 'review:' || t."id" || ':' || t."bounces" || ':' || a."id", 0, 'legacy_needs_plan', a."id"
  FROM "tasks" t CROSS JOIN LATERAL jsonb_array_elements_text(t."panel") AS member(reviewer)
  JOIN "agents" a ON a."id"::text = member.reviewer AND a."company_id" = t."company_id"
  WHERE t."status" = 'review' AND NOT EXISTS (
    SELECT 1 FROM "task_events" e WHERE e."task_id" = t."id" AND e."kind" = 'verdict' AND e."agent_id" = a."id"
      AND e."data"->>'stage' = t."stage"::text AND e."data"->>'round' = t."bounces"::text
  );
