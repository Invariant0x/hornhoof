ALTER TABLE "departments" ADD COLUMN "autonomous_release" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "autonomous_release";