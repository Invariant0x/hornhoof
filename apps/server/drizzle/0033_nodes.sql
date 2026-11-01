CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"subscription_id" uuid,
	"key_hash" text,
	"status" text DEFAULT 'needs_login' NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "nodes_machine_plan" UNIQUE NULLS NOT DISTINCT("machine_id","subscription_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_node_key_hash_unique";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_machine_id_machines_id_fk";
--> statement-breakpoint
ALTER TABLE "test_parts" DROP CONSTRAINT "test_parts_subscription_id_subscriptions_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "node_codes" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "node_codes" ADD COLUMN "command_enc" text;--> statement-breakpoint
ALTER TABLE "test_parts" ADD COLUMN "node_id" uuid;--> statement-breakpoint
-- Each plan that has a machine gets a node there with the plan's own id, so its running node, the node's container,
-- volume and sign-in go on as they are, and its jobs, agents and parts of test runs are on that node. A removed plan
-- keeps its node until the node hears so.
INSERT INTO "nodes" ("id", "company_id", "machine_id", "subscription_id", "key_hash", "status", "version", "last_seen_at")
  SELECT "id", "company_id", "machine_id", "id", "node_key_hash", CASE WHEN "status" = 'ready' THEN 'ready' ELSE 'needs_login' END, "node_version", "last_seen_at"
  FROM "subscriptions" WHERE "machine_id" IS NOT NULL AND "kind" = 'personal';--> statement-breakpoint
UPDATE "agents" SET "node_id" = "subscription_id" WHERE "subscription_id" IN (SELECT "id" FROM "nodes");--> statement-breakpoint
UPDATE "jobs" SET "node_id" = "subscription_id" WHERE "subscription_id" IN (SELECT "id" FROM "nodes");--> statement-breakpoint
UPDATE "test_parts" SET "node_id" = "subscription_id" WHERE "subscription_id" IN (SELECT "id" FROM "nodes");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_subscription_id" ON "nodes" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_codes" ADD CONSTRAINT "node_codes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "machine_id";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "node_key_hash";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "node_version";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "last_seen_at";--> statement-breakpoint
ALTER TABLE "test_parts" DROP COLUMN "subscription_id";