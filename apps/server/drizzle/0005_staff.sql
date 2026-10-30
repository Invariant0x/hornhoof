CREATE TABLE "agent_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"person_id" uuid,
	"field" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"department_id" uuid,
	"team_id" uuid,
	CONSTRAINT "person_access_place" UNIQUE NULLS NOT DISTINCT("person_id","department_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role_key" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "instructions_hash" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "kind" text DEFAULT 'structure' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "models" jsonb;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_access" ADD CONSTRAINT "person_access_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_changes_agent_id" ON "agent_changes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "person_access_person_id" ON "person_access" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_product_id_departments_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A person with one department or one team gets it as an access list.
INSERT INTO "person_access" ("company_id", "person_id", "department_id", "team_id")
  SELECT "company_id", "id", CASE WHEN "scope_kind" = 'department' THEN "scope_id" END, CASE WHEN "scope_kind" = 'team' THEN "scope_id" END
  FROM "people" WHERE "scope_kind" IN ('department', 'team') AND "scope_id" IS NOT NULL;--> statement-breakpoint
UPDATE "people" SET "scope_kind" = 'listed' WHERE "scope_kind" IN ('department', 'team');
