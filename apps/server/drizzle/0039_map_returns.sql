CREATE TABLE "map_returns" (
	"company_id" uuid NOT NULL,
	"upstream_agent_id" uuid NOT NULL,
	"downstream_agent_id" uuid NOT NULL,
	"work_epoch" integer DEFAULT 0 NOT NULL,
	"work_job_id" uuid,
	"returned_epoch" integer,
	"returned_at" timestamp with time zone,
	"source_key" text,
	"source_job_id" uuid,
	"source_task_id" uuid,
	CONSTRAINT "map_returns_company_id_upstream_agent_id_downstream_agent_id_pk" PRIMARY KEY("company_id","upstream_agent_id","downstream_agent_id"),
	CONSTRAINT "map_returns_epochs" CHECK ("map_returns"."work_epoch" >= 0 AND ("map_returns"."returned_epoch" IS NULL OR ("map_returns"."returned_epoch" >= 0 AND "map_returns"."returned_epoch" <= "map_returns"."work_epoch"))),
	CONSTRAINT "map_returns_given_back" CHECK (("map_returns"."returned_at" IS NULL) = ("map_returns"."returned_epoch" IS NULL) AND ("map_returns"."returned_at" IS NULL) = ("map_returns"."source_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_upstream_agent_id_agents_id_fk" FOREIGN KEY ("upstream_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_downstream_agent_id_agents_id_fk" FOREIGN KEY ("downstream_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_work_job_id_jobs_id_fk" FOREIGN KEY ("work_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_returns" ADD CONSTRAINT "map_returns_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;