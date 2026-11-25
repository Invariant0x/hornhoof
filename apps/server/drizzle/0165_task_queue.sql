ALTER TABLE "departments" ADD COLUMN "slot_cap" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_slot_cap" CHECK ("departments"."slot_cap" IS NULL OR "departments"."slot_cap" >= 1);--> statement-breakpoint
CREATE INDEX "tasks_queued" ON "tasks" USING btree ("department_id","queued_at");