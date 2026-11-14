CREATE TABLE "agent_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"sender_kind" text NOT NULL,
	"sender_agent_id" uuid,
	"sender_name" text NOT NULL,
	"task_id" uuid,
	"task_number" integer,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'unread' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "inbox_mode" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "inbox_mode" text DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "inbox_mode" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "inbox_wake" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_inbox_agent_status" ON "agent_inbox" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_inbox_job" ON "agent_inbox" USING btree ("job_id");