CREATE TABLE "world_layouts" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"pack_id" text DEFAULT 'default' NOT NULL,
	"seed" text DEFAULT '' NOT NULL,
	"layout" jsonb,
	"relocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "world_layouts" ADD CONSTRAINT "world_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;