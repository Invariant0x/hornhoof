CREATE TABLE "request_internal" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"material_snapshot" jsonb,
	CONSTRAINT "request_internal_material_snapshot_bound" CHECK (
  "request_internal"."material_snapshot" IS NULL OR (jsonb_typeof("request_internal"."material_snapshot") = 'object' AND octet_length("request_internal"."material_snapshot"::text) <= 1048576))
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "material_revision" bigint;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "material_digest" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "material_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "material_revision" bigint;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "material_digest" text;--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_internal" ADD CONSTRAINT "request_internal_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_internal_company_id" ON "request_internal" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_material_stamp" CHECK (
  ("proposals"."material_revision" IS NULL AND "proposals"."material_digest" IS NULL) OR
  ("proposals"."material_revision" IS NOT NULL AND "proposals"."material_digest" IS NOT NULL AND "proposals"."material_revision" > 0
   AND "proposals"."material_revision" <= 9007199254740991 AND "proposals"."material_digest" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_material_snapshot_bound" CHECK (
  "proposals"."material_snapshot" IS NULL OR (jsonb_typeof("proposals"."material_snapshot") = 'object' AND octet_length("proposals"."material_snapshot"::text) <= 1048576));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_material_stamp" CHECK (
  ("requests"."material_revision" IS NULL AND "requests"."material_digest" IS NULL) OR
  ("requests"."material_revision" IS NOT NULL AND "requests"."material_digest" IS NOT NULL AND "requests"."material_revision" > 0
   AND "requests"."material_revision" <= 9007199254740991 AND "requests"."material_digest" ~ '^[0-9a-f]{64}$'));