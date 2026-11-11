-- Personal assistants: a person may be an outside agent that acts for another person of the company, with its key, the
-- events it reads and the answers it gave for its owner.
CREATE TABLE "assistant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"assistant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_events_company_seq" UNIQUE("company_id","seq"),
	CONSTRAINT "assistant_events_kind" CHECK ("assistant_events"."kind" IN ('reply', 'reply_end', 'request', 'request_closed'))
);
--> statement-breakpoint
CREATE TABLE "assistant_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"assistant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"after_seq" bigint NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_replies_message" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_requests" (
	"assistant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_requests_assistant_id_request_id_pk" PRIMARY KEY("assistant_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_seqs" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistants" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"program" text NOT NULL,
	"events_url" text,
	"key_hash" text,
	"key_created_at" timestamp with time zone,
	"wake_secret_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistants_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "assistants_program" CHECK ("assistants"."program" IN ('avaclone', 'openclaw', 'other')),
	CONSTRAINT "assistants_key_whole" CHECK (num_nonnulls("assistants"."key_hash", "assistants"."key_created_at", "assistants"."wake_secret_enc") IN (0, 3))
);
--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "is_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "assistant_of" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "answered_by_assistant_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_assistant_id_people_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_replies" ADD CONSTRAINT "assistant_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_replies" ADD CONSTRAINT "assistant_replies_assistant_id_people_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_replies" ADD CONSTRAINT "assistant_replies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_replies" ADD CONSTRAINT "assistant_replies_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_assistant_id_people_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_requests" ADD CONSTRAINT "assistant_requests_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_seqs" ADD CONSTRAINT "assistant_seqs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_events_assistant_seq" ON "assistant_events" USING btree ("assistant_id","seq");--> statement-breakpoint
CREATE INDEX "assistant_events_created_at" ON "assistant_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "assistant_replies_company" ON "assistant_replies" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_assistant_of_people_id_fk" FOREIGN KEY ("assistant_of") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_answered_by_assistant_id_people_id_fk" FOREIGN KEY ("answered_by_assistant_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_assistant_of" ON "people" USING btree ("assistant_of");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_assistant" CHECK (("people"."is_agent" AND "people"."assistant_of" IS NOT NULL AND "people"."password_hash" IS NULL) OR (NOT "people"."is_agent" AND "people"."assistant_of" IS NULL AND "people"."email" IS NOT NULL));