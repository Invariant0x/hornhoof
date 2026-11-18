ALTER TABLE "pipelines" ADD COLUMN "catalog_key" text;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_department_catalog" ON "pipelines" USING btree ("department_id","catalog_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_department_default" ON "pipelines" USING btree ("department_id") WHERE "pipelines"."is_default";