CREATE UNIQUE INDEX "agents_one_head" ON "agents" USING btree ("department_id") WHERE kind = 'head' AND removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_orchestrator" ON "agents" USING btree ("company_id") WHERE kind = 'orchestrator' AND removed_at IS NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_approval_commit" CHECK ("requests"."kind" <> 'approval' OR "requests"."commit" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_review_has_executor" CHECK ("tasks"."status" <> 'review' OR "tasks"."executor_agent_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_counts" CHECK ("tasks"."stage" >= 0 AND "tasks"."bounces" >= 0 AND "tasks"."silent" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_closed_at" CHECK ("tasks"."status" NOT IN ('done', 'cancelled') OR "tasks"."closed_at" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_not_own_parent" CHECK ("tasks"."parent_id" IS NULL OR "tasks"."parent_id" <> "tasks"."id") NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_gates_lists" CHECK (jsonb_typeof("tasks"."gates") = 'array' AND jsonb_typeof("tasks"."panel") = 'array') NOT VALID;