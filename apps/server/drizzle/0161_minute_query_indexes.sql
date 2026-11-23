CREATE INDEX IF NOT EXISTS "agent_events_operator_fallback" ON "agent_events" USING btree ("agent_id",(data->>'operatorFallback')) WHERE "agent_events"."kind" = 'typed' and data->>'operatorFallback' is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_conversation_activity" ON "jobs" USING btree ("agent_id","company_id","status","started_at","finished_at") WHERE "jobs"."kind" = 'conversation';--> statement-breakpoint
CREATE STATISTICS IF NOT EXISTS "agent_events_operations_pending_stat" ON (data->>'operationsPending') FROM "agent_events";--> statement-breakpoint
ANALYZE "agent_events";
