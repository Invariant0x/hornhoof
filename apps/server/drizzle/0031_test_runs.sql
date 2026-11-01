CREATE TABLE "test_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"part" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"subscription_id" uuid,
	"builtin" boolean DEFAULT false NOT NULL,
	"machine_id" uuid,
	"machine_name" text,
	"commit" text,
	"exit_code" integer,
	"error" text,
	"tail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "test_parts_run_part" UNIQUE("run_id","part")
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"department_id" uuid,
	"branch" text,
	"command" text NOT NULL,
	"parts" integer DEFAULT 1 NOT NULL,
	"timeout_ms" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stopped_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "test_runs_company_number" UNIQUE("company_id","number")
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "repo_test_memory_gb" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "lends_tests" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_stopped_by_agent_id_agents_id_fk" FOREIGN KEY ("stopped_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_parts_status" ON "test_parts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "test_runs_task_id" ON "test_runs" USING btree ("task_id");