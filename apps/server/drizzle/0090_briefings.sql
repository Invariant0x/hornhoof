CREATE TABLE "briefings" (
	"department_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"person_id" uuid,
	"by_orchestrator" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE cascade ON UPDATE no action;