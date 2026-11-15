ALTER TABLE "departments" ADD COLUMN "autonomous_release" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Each top-level department keeps the autonomous release its company had: its people turn it off or on from now on.
UPDATE "departments" SET "autonomous_release" = true FROM "companies" WHERE "departments"."company_id" = "companies"."id" AND "companies"."autonomous_release" AND "departments"."parent_id" IS NULL;
