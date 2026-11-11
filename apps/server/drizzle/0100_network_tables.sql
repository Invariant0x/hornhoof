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
CREATE TABLE "sign_in_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"address_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "before_host_cookie" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "link_tls" ADD CONSTRAINT "link_tls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_attempts_email" ON "sign_in_attempts" USING btree ("email_hash","at");--> statement-breakpoint
CREATE INDEX "sign_in_attempts_address" ON "sign_in_attempts" USING btree ("address_hash","at");--> statement-breakpoint
CREATE INDEX "sign_in_attempts_at" ON "sign_in_attempts" USING btree ("at");