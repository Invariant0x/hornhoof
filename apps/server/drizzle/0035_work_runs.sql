ALTER TABLE "test_runs" ADD COLUMN "kind" text DEFAULT 'tests' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "memory_gb" integer;