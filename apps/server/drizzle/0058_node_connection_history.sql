CREATE TABLE "node_connection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"happened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text,
	"cause" text,
	"close_code" integer,
	"close_reason" text,
	"error" text,
	"offline_ms" bigint,
	"node_report" jsonb
);
--> statement-breakpoint
ALTER TABLE "node_connection_events" ADD CONSTRAINT "node_connection_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_connection_events" ADD CONSTRAINT "node_connection_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_connection_events" ADD CONSTRAINT "node_connection_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_connection_events_happened_at" ON "node_connection_events" USING btree ("happened_at");--> statement-breakpoint
CREATE INDEX "node_connection_events_machine_time" ON "node_connection_events" USING btree ("machine_id","happened_at");--> statement-breakpoint
CREATE INDEX "node_connection_events_node_time" ON "node_connection_events" USING btree ("node_id","happened_at");