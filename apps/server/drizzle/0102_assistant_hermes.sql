-- An assistant may run Hermes Agent too, which Hornhoof wakes in its own way.
ALTER TABLE "assistants" DROP CONSTRAINT "assistants_program";--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_program" CHECK ("assistants"."program" IN ('avaclone', 'openclaw', 'hermes', 'other'));