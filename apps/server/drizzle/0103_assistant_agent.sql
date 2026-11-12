-- An assistant's own agent, which thinks for it on a plan its owner picks, and the address of the program's skills.
ALTER TABLE "assistants" ADD COLUMN "skills_url" text;--> statement-breakpoint
ALTER TABLE "assistants" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
