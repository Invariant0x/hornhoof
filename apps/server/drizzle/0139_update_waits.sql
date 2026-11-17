CREATE TABLE "update_waits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"reason" text,
	"turns" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "update_waits" ADD CONSTRAINT "update_waits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "update_waits_open" ON "update_waits" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "update_waits_company_since" ON "update_waits" USING btree ("company_id","since");