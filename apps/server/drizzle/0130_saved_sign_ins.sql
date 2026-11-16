CREATE TABLE "saved_sign_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"site" text NOT NULL,
	"session_enc" text NOT NULL,
	"user_agent" text,
	"source" text NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_sign_ins" ADD CONSTRAINT "saved_sign_ins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sign_ins" ADD CONSTRAINT "saved_sign_ins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sign_ins" ADD CONSTRAINT "saved_sign_ins_saved_by_people_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_sign_ins_agent_site" ON "saved_sign_ins" USING btree ("agent_id","site");