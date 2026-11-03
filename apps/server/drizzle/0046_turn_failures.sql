ALTER TABLE "jobs" ADD COLUMN "failure" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "restarted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_events_failure_case" ON "agent_events" USING btree ((data->>'failureCase')) WHERE data->>'failureCase' is not null;--> statement-breakpoint
CREATE INDEX "agent_events_operations_pending" ON "agent_events" USING btree ((data->>'operationsPending')) WHERE data->>'operationsPending' is not null;
