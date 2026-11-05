CREATE TABLE "link_tls" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"directory" text NOT NULL,
	"account_key_enc" text NOT NULL,
	"account_url" text,
	"name" text,
	"cert_pem" text,
	"cert_directory" text,
	"cert_key_enc" text,
	"not_after" timestamp with time zone,
	"renew_at" timestamp with time zone,
	"ask_at" timestamp with time zone,
	"next_try_at" timestamp with time zone,
	"failure" text,
	"failed_at" timestamp with time zone,
	"mode" text DEFAULT 'http' NOT NULL,
	"https_blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_tls" ADD CONSTRAINT "link_tls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;