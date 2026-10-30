ALTER TABLE "agents" ADD COLUMN "switched_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "panel" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "panel" = jsonb_build_array("gates"->("stage" - 1)) WHERE "status" IN ('review', 'waiting') AND "stage" > 0;
