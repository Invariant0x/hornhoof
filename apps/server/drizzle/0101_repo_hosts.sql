-- The keys of a git host Hornhoof creates repositories with: the company's, and a department's own, which goes first for it.
CREATE TABLE "repo_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"provider" text DEFAULT 'github' NOT NULL,
	"owner" text NOT NULL,
	"token_enc" text NOT NULL,
	"token_last4" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_hosts_provider" CHECK ("repo_hosts"."provider" IN ('github'))
);
--> statement-breakpoint
ALTER TABLE "repo_hosts" ADD CONSTRAINT "repo_hosts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_hosts" ADD CONSTRAINT "repo_hosts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_hosts" ADD CONSTRAINT "repo_hosts_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_hosts_company" ON "repo_hosts" USING btree ("company_id") WHERE "repo_hosts"."department_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_hosts_department" ON "repo_hosts" USING btree ("department_id");