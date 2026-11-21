ALTER TABLE "companies" ADD COLUMN "paused" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "resumed_at" timestamp with time zone;