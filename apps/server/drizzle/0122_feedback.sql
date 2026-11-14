-- Findings about Hornhoof itself apart from a company's own, and the inbox of feedback from every installation on Hornhoof's own one.
CREATE TABLE "feedback_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"error_code" text,
	"versions" text[] DEFAULT '{}'::text[] NOT NULL,
	"platforms" text[] DEFAULT '{}'::text[] NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_inbox_fingerprint" UNIQUE("company_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "feedback_signals" (
	"card_id" uuid NOT NULL,
	"installation" text NOT NULL,
	"signals" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_signals_card_id_installation_pk" PRIMARY KEY("card_id","installation")
);
--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "scope" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "improvements" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "feedback_inbox" ADD CONSTRAINT "feedback_inbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_inbox" ADD CONSTRAINT "feedback_inbox_issued_by_people_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_signals" ADD CONSTRAINT "feedback_signals_card_id_feedback_inbox_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."feedback_inbox"("id") ON DELETE cascade ON UPDATE no action;