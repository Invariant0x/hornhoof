CREATE TABLE "wait_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"dedup_key" text NOT NULL,
	"message" jsonb NOT NULL,
	"guard" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "wait_notices_dedup" UNIQUE("company_id","dedup_key")
);
--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_notices" ADD CONSTRAINT "wait_notices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wait_notices_pending" ON "wait_notices" USING btree ("created_at") WHERE "wait_notices"."delivered_at" IS NULL AND "wait_notices"."cancelled_at" IS NULL;