CREATE TABLE "outbound_contact_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"fields_enc" text NOT NULL,
	CONSTRAINT "outbound_contact_fields_place" UNIQUE("company_id","department_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "outbound_contact_fields" ADD CONSTRAINT "outbound_contact_fields_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_contact_fields" ADD CONSTRAINT "outbound_contact_fields_department" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_contact_fields" ADD CONSTRAINT "outbound_contact_fields_contact" FOREIGN KEY ("company_id","contact_id") REFERENCES "public"."outbound_contacts"("company_id","id") ON DELETE no action ON UPDATE no action;