CREATE TABLE "recovery_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"link_print" text,
	"link_name" text,
	"link_url" text,
	"made_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "recovery_keys_recipient_unique" UNIQUE("recipient")
);
--> statement-breakpoint
ALTER TABLE "recovery_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "age_key" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "keeps_backups" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "held_backups" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_keys" ADD CONSTRAINT "recovery_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_keys" ADD CONSTRAINT "recovery_keys_made_by_people_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;