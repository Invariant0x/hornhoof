CREATE TABLE "google_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"account" text NOT NULL,
	"share_email" text,
	"credentials_enc" text NOT NULL,
	"key_last4" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_sheets_kind" CHECK ("google_sheets"."kind" IN ('service_account', 'oauth'))
);
--> statement-breakpoint
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_sheets_company" ON "google_sheets" USING btree ("company_id");