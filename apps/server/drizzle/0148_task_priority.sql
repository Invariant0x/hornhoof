ALTER TABLE "tasks" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_known" CHECK ("tasks"."priority" in ('urgent', 'high', 'normal', 'low'));