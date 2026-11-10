ALTER TABLE "turns" DROP CONSTRAINT "turns_closed_by_people_id_fk";--> statement-breakpoint
DROP TABLE "computer_access_intents" CASCADE;--> statement-breakpoint
DROP TABLE "external_operations" CASCADE;--> statement-breakpoint
DROP TABLE "external_recovery_attempts" CASCADE;--> statement-breakpoint
DROP TABLE "external_recovery_cases" CASCADE;--> statement-breakpoint
DROP TABLE "external_recovery_members" CASCADE;--> statement-breakpoint
DROP TABLE "external_recovery_notices" CASCADE;--> statement-breakpoint
DROP TABLE "program_operator_actions" CASCADE;--> statement-breakpoint
ALTER TABLE "program_operator_cases" DROP COLUMN "snapshot";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "closed_by";
