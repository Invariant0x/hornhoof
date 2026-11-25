CREATE TABLE "agent_event_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"first_seq" bigint NOT NULL,
	"last_seq" bigint NOT NULL,
	"events" integer NOT NULL,
	"job_ids" uuid[] NOT NULL,
	"event_ids" uuid[] NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "history_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_event_archives" ADD CONSTRAINT "agent_event_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event_archives" ADD CONSTRAINT "agent_event_archives_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_event_archives_agent_seq" ON "agent_event_archives" USING btree ("agent_id","first_seq","last_seq");--> statement-breakpoint
CREATE INDEX "agent_event_archives_sha256" ON "agent_event_archives" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "agent_event_archives_job_ids" ON "agent_event_archives" USING gin ("job_ids");--> statement-breakpoint
CREATE INDEX "agent_event_archives_event_ids" ON "agent_event_archives" USING gin ("event_ids");--> statement-breakpoint
CREATE INDEX "agent_event_archives_pending" ON "agent_event_archives" USING btree ("company_id") WHERE cleared_at is null;--> statement-breakpoint
CREATE INDEX "jobs_ended" ON "jobs" USING btree ("company_id",coalesce("finished_at", "created_at")) WHERE "jobs"."status" in ('done', 'failed', 'obsolete');