CREATE TABLE "sign_in_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"address_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sign_in_attempts_email" ON "sign_in_attempts" USING btree ("email_hash","at");--> statement-breakpoint
CREATE INDEX "sign_in_attempts_address" ON "sign_in_attempts" USING btree ("address_hash","at");--> statement-breakpoint
CREATE INDEX "sign_in_attempts_at" ON "sign_in_attempts" USING btree ("at");