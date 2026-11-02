CREATE TABLE "plan_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_credentials_node_kind" UNIQUE("node_id","kind")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "account" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cred_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "lease_node_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_credentials" ADD CONSTRAINT "plan_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_credentials" ADD CONSTRAINT "plan_credentials_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_credentials" ADD CONSTRAINT "plan_credentials_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_credentials_subscription_id" ON "plan_credentials" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_lease_node_id_nodes_id_fk" FOREIGN KEY ("lease_node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;