CREATE TABLE "person_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"actor_id" uuid,
	"field" text NOT NULL,
	"before" text NOT NULL,
	"after" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_changes" ADD CONSTRAINT "person_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_changes" ADD CONSTRAINT "person_changes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_changes" ADD CONSTRAINT "person_changes_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_changes_person_id" ON "person_changes" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_changes_company_id" ON "person_changes" USING btree ("company_id");