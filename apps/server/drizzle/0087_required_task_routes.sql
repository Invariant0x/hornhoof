CREATE TABLE "task_routes" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" jsonb NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "task_routes_revision" CHECK ("task_routes"."revision" > 0),
	CONSTRAINT "task_routes_state" CHECK (jsonb_typeof("task_routes"."state") = 'object'),
	CONSTRAINT "task_routes_paths" CHECK (jsonb_typeof("task_routes"."paths") = 'array')
);
--> statement-breakpoint
ALTER TABLE "task_routes" ADD CONSTRAINT "task_routes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_routes" ADD CONSTRAINT "task_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;