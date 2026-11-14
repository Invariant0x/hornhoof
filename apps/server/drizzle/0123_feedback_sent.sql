-- What became of a finding sent to Hornhoof's developers, and the number an installation calls an inbox card by.
ALTER TABLE "feedback_inbox" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "sent_report" jsonb;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "sent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "report_number" integer;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "issue_number" integer;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "issue_url" text;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "reported_seen" integer;--> statement-breakpoint
CREATE INDEX "improvements_sent_fingerprint" ON "improvements" USING btree ("company_id","sent_fingerprint");--> statement-breakpoint
ALTER TABLE "feedback_inbox" ADD CONSTRAINT "feedback_inbox_number" UNIQUE("number");