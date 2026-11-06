ALTER TABLE "tasks" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "urgent_only" boolean DEFAULT false NOT NULL;