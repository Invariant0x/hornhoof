ALTER TABLE "departments" ADD COLUMN "work_mode" text DEFAULT 'turns' NOT NULL;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_work_mode" CHECK ("departments"."work_mode" IN ('turns', 'continuous'));--> statement-breakpoint
/* Existing top-level Operations departments inherit their template's default.
   Every other department keeps the generic turns default; no company data. */
UPDATE "departments" SET "work_mode" = 'continuous'
WHERE "template_key" = 'operations' AND "parent_id" IS NULL;
