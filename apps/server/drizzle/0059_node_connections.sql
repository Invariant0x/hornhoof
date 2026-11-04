CREATE TABLE "node_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	"cause" text,
	"close_code" integer,
	"close_reason" text,
	"error" text,
	"report" jsonb,
	CONSTRAINT "node_connections_end_has_cause" CHECK (("node_connections"."disconnected_at" IS NULL) = ("node_connections"."cause" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "node_connections" ADD CONSTRAINT "node_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_connections" ADD CONSTRAINT "node_connections_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_connections" ADD CONSTRAINT "node_connections_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_connections_machine" ON "node_connections" USING btree ("machine_id","connected_at");--> statement-breakpoint
CREATE INDEX "node_connections_node" ON "node_connections" USING btree ("node_id","connected_at");