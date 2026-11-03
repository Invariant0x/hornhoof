ALTER TABLE "jobs" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "restarted_at" timestamp with time zone;