CREATE TABLE "one_shot_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch" uuid NOT NULL,
	"number" integer NOT NULL,
	"judge" boolean DEFAULT false NOT NULL,
	"job_id" uuid NOT NULL,
	"caller_agent_id" uuid NOT NULL,
	"caller_job_id" uuid,
	"task_id" uuid NOT NULL,
	"department_id" uuid,
	"stage" text,
	"brief" text NOT NULL,
	"input" text,
	"wants_verdict" boolean DEFAULT false NOT NULL,
	"verdict" jsonb,
	"judge_brief" text,
	"told" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_shot_calls_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "one_shot_calls_batch_number" UNIQUE("batch","number"),
	CONSTRAINT "one_shot_calls_number" CHECK ("one_shot_calls"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_caller_job_id_jobs_id_fk" FOREIGN KEY ("caller_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_shot_calls" ADD CONSTRAINT "one_shot_calls_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "one_shot_calls_task_id" ON "one_shot_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "one_shot_calls_department_id" ON "one_shot_calls" USING btree ("department_id");