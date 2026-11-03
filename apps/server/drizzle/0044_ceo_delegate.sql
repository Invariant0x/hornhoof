ALTER TABLE "jobs" ADD COLUMN "decision_input_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "is_ceo_delegate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "answered_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "answer_job_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "answer_source_seq" bigint;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_answered_by_agent_id_agents_id_fk" FOREIGN KEY ("answered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_answer_job_id_jobs_id_fk" FOREIGN KEY ("answer_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;