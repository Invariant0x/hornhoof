CREATE TABLE "autonomous_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"task_id" uuid,
	"task_number" integer NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"commit_sha" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"test_run_id" uuid,
	"test_run_number" integer NOT NULL,
	"reviewer_agent_id" uuid,
	"reviewer_name" text NOT NULL,
	"verdict_event_id" bigint,
	"verdict_stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomous_releases_commit_sha" CHECK ("autonomous_releases"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "autonomous_releases_base_commit_sha" CHECK ("autonomous_releases"."base_commit_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "autonomous_release" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_releases" ADD CONSTRAINT "autonomous_releases_verdict_event_id_task_events_id_fk" FOREIGN KEY ("verdict_event_id") REFERENCES "public"."task_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autonomous_releases_company_created" ON "autonomous_releases" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "autonomous_releases_company_commit" ON "autonomous_releases" USING btree ("company_id","commit_sha");