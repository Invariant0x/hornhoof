CREATE TABLE "theme_files" (
	"company_id" uuid NOT NULL,
	"theme_id" text NOT NULL,
	"version" text NOT NULL,
	"path" text NOT NULL,
	"media_type" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "theme_files_company_id_theme_id_version_path_pk" PRIMARY KEY("company_id","theme_id","version","path"),
	CONSTRAINT "theme_files_sha256" CHECK ("theme_files"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"company_id" uuid NOT NULL,
	"theme_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"look" jsonb NOT NULL,
	"fonts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kit" jsonb,
	"world" jsonb,
	"skills" jsonb,
	"size" integer NOT NULL,
	"installed_by" uuid NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_company_id_theme_id_pk" PRIMARY KEY("company_id","theme_id"),
	CONSTRAINT "themes_version" UNIQUE("company_id","theme_id","version")
);
--> statement-breakpoint
ALTER TABLE "theme_files" ADD CONSTRAINT "theme_files_theme" FOREIGN KEY ("company_id","theme_id","version") REFERENCES "public"."themes"("company_id","theme_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_installed_by_people_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;