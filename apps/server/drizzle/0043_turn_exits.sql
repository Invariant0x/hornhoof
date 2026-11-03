ALTER TABLE "jobs" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "exit_signal" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "continue_of" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_continue_of_jobs_id_fk" FOREIGN KEY ("continue_of") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;