ALTER TABLE "jobs" ADD COLUMN "retry_of" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "interruption" jsonb;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "boot" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_of_jobs_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;