ALTER TABLE "pending_wakes" ADD COLUMN "task_version" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_wait" jsonb;--> statement-breakpoint
CREATE INDEX "tasks_external_wait_until" ON "tasks" USING btree (("external_wait"->>'until')) WHERE "tasks"."external_wait" IS NOT NULL;