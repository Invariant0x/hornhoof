CREATE INDEX IF NOT EXISTS "agent_events_visible_history" ON "agent_events" USING btree ("agent_id","seq") WHERE data->>'operatorEvidenceId' is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_events_chat_receipt" ON "agent_events" USING btree ((data->>'chatReceipt')) WHERE data->>'chatReceipt' is not null;
