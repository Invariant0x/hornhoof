-- Where each person put the blocks of the company map, kept apart for every person.
CREATE TABLE "map_layouts" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"blocks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_layouts" ADD CONSTRAINT "map_layouts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_layouts" ADD CONSTRAINT "map_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;