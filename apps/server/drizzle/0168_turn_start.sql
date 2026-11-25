ALTER TABLE "departments" ADD COLUMN "turn_start" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "confirmed_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cut_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cut_branch" text;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_turn_start" CHECK ("departments"."turn_start" IN ('automatic', 'manual'));--> statement-breakpoint
UPDATE "departments" SET "turn_start" = 'manual' WHERE "template_key" = 'development' AND "parent_id" IS NULL;
