ALTER TABLE "notebook_notes" DROP CONSTRAINT "notebook_notes_company_number";--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD CONSTRAINT "notebook_notes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD CONSTRAINT "notebook_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook_notes" ADD CONSTRAINT "notebook_notes_book_number" UNIQUE NULLS NOT DISTINCT("company_id","department_id","number");