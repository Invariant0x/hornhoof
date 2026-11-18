ALTER TABLE "people" ADD COLUMN "deletion_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "deletion_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "deletion_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_deletion_approved_by_people_id_fk" FOREIGN KEY ("deletion_approved_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;