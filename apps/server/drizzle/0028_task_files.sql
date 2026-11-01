ALTER TABLE "attachments" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_task_id" ON "attachments" USING btree ("task_id");