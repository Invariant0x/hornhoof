CREATE TABLE "test_file_results" (
	"company_id" uuid NOT NULL,
	"repository_owner_id" uuid NOT NULL,
	"repo_url_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	"suite_id" text NOT NULL,
	"file" text NOT NULL,
	"run_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_file_results_pk" PRIMARY KEY("company_id","repository_owner_id","repo_url_hash","fingerprint","suite_id","file")
);
--> statement-breakpoint
CREATE TABLE "test_suite_memory" (
	"company_id" uuid NOT NULL,
	"repository_owner_id" uuid NOT NULL,
	"repo_url_hash" text NOT NULL,
	"suite_id" text NOT NULL,
	"files" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_suite_memory_pk" PRIMARY KEY("company_id","repository_owner_id","repo_url_hash","suite_id")
);
--> statement-breakpoint
ALTER TABLE "test_parts" ADD COLUMN "failed_files" jsonb;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "file_cache" jsonb;--> statement-breakpoint
ALTER TABLE "test_file_results" ADD CONSTRAINT "test_file_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_file_results" ADD CONSTRAINT "test_file_results_repository_owner_id_departments_id_fk" FOREIGN KEY ("repository_owner_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_file_results" ADD CONSTRAINT "test_file_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite_memory" ADD CONSTRAINT "test_suite_memory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suite_memory" ADD CONSTRAINT "test_suite_memory_repository_owner_id_departments_id_fk" FOREIGN KEY ("repository_owner_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_file_results_age" ON "test_file_results" USING btree ("company_id","created_at");