ALTER TABLE "companies" ADD COLUMN "task_numbers_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "turn_numbers_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "companies" SET "task_numbers_used" = coalesce((SELECT max("number") FROM "tasks" WHERE "tasks"."company_id" = "companies"."id"), 0), "turn_numbers_used" = coalesce((SELECT max("number") FROM "turns" WHERE "turns"."company_id" = "companies"."id"), 0);
