CREATE TABLE "harness_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"unit" text NOT NULL,
	"platform" text NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"builder" text,
	"lease_until" timestamp with time zone,
	"digest" text,
	"size" bigint,
	"error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone,
	"copies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_builds_company_key" UNIQUE("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "harness_products" (
	"department_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"head_commit" text,
	"good_commit" text,
	"version" text,
	"problem" jsonb,
	"told" text,
	"machines" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_builds" ADD CONSTRAINT "harness_builds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_builds" ADD CONSTRAINT "harness_builds_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_products" ADD CONSTRAINT "harness_products_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_products" ADD CONSTRAINT "harness_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harness_builds_department" ON "harness_builds" USING btree ("department_id","created_at");