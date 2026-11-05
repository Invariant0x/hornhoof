CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"mode" text NOT NULL,
	"limit_amount" double precision,
	"limit_unit" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_channel" UNIQUE("department_id","channel"),
	CONSTRAINT "approval_policies_limit" CHECK (("approval_policies"."mode" = 'within_limits') = ("approval_policies"."limit_amount" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_approval_commit";--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "owner_person_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "approval_channel" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "approval_kind" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "approval_amount" double precision;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "departments_owner_person_id" ON "departments" USING btree ("owner_person_id");--> statement-breakpoint
CREATE INDEX "requests_approved_kinds" ON "requests" USING btree ("company_id","approval_channel","approval_kind") WHERE "requests"."status" = 'approved' AND "requests"."approval_channel" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_approval_commit" CHECK ("requests"."kind" <> 'approval' OR "requests"."commit" IS NOT NULL OR "requests"."approval_channel" IS NOT NULL);