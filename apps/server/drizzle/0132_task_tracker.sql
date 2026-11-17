CREATE TABLE "goal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"agent_id" uuid,
	"text" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_events_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"department_id" uuid,
	"parent_goal_id" uuid,
	"title" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"responsible_person_id" uuid NOT NULL,
	"target_value" double precision,
	"current_value" double precision,
	"unit" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_person_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "goals_company_number" UNIQUE("company_id","number"),
	CONSTRAINT "goals_status" CHECK ("goals"."status" IN ('active', 'reached', 'dropped')),
	CONSTRAINT "goals_not_own_parent" CHECK ("goals"."parent_goal_id" IS NULL OR "goals"."parent_goal_id" <> "goals"."id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"parent_stage_id" uuid,
	"name" text NOT NULL,
	"owner_role" text,
	"owner_agent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pipeline_stages_one_owner" CHECK (("pipeline_stages"."owner_role" IS NULL) <> ("pipeline_stages"."owner_agent_id" IS NULL)),
	CONSTRAINT "pipeline_stages_not_own_parent" CHECK ("pipeline_stages"."parent_stage_id" IS NULL OR "pipeline_stages"."parent_stage_id" <> "pipeline_stages"."id")
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_person_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "timer_nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tracker_due" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "responsible_person_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "why" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pipeline_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pipeline_stage_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "tracker_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_goal_id_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_responsible_person_id_people_id_fk" FOREIGN KEY ("responsible_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_parent_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("parent_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_events_goal_id" ON "goal_events" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "goals_department_id" ON "goals" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "goals_parent_goal_id" ON "goals" USING btree ("parent_goal_id");--> statement-breakpoint
CREATE INDEX "pipeline_stages_pipeline_id" ON "pipeline_stages" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "pipelines_department_id" ON "pipelines" USING btree ("department_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_responsible_person_id_people_id_fk" FOREIGN KEY ("responsible_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pipeline_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("pipeline_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_goal_id" ON "tasks" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "tasks_responsible" ON "tasks" USING btree ("responsible_person_id");--> statement-breakpoint
CREATE INDEX "tasks_pipeline_id" ON "tasks" USING btree ("pipeline_id");--> statement-breakpoint
UPDATE "companies" SET "tracker_due" = true;
