ALTER TABLE "subscriptions" ADD COLUMN "turn_limit" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_subscription_running_turns" ON "jobs" USING btree ("subscription_id","node_id","builtin_machine") WHERE "jobs"."kind" = 'conversation' and "jobs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_turn_limit_range" CHECK ("subscriptions"."turn_limit" between 1 and 5);
