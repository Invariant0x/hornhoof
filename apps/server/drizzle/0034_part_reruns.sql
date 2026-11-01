ALTER TABLE "test_parts" ADD COLUMN "lost" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "test_parts" ADD COLUMN "queued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "test_parts" SET "queued_at" = "created_at";
