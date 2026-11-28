CREATE INDEX IF NOT EXISTS "task_events_company_rework" ON "task_events" USING btree ("company_id","created_at","task_id") WHERE kind = 'submitted' and data->'candidate'->>'parentId' is not null;
