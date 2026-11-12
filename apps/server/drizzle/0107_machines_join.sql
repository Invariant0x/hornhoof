CREATE TABLE "machine_online" (
	"machine_id" uuid NOT NULL,
	"day" date NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "machine_online_machine_id_day_pk" PRIMARY KEY("machine_id","day"),
	CONSTRAINT "machine_online_seconds" CHECK (seconds BETWEEN 0 AND 86400)
);
--> statement-breakpoint
ALTER TABLE "machine_online" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "machine_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "person_keys" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"wrapped" text NOT NULL,
	"salt" text NOT NULL,
	"iv" text NOT NULL,
	"iterations" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_keys_iterations" CHECK (iterations >= 600000)
);
--> statement-breakpoint
ALTER TABLE "person_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "peer_secrets" DROP CONSTRAINT "peer_secrets_kind";--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "addresses" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "direct_fails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "renew_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "update_commit" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "update_state" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "go_commit" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "go_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "failed_commit" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "owner_pin" text;--> statement-breakpoint
ALTER TABLE "node_codes" ADD COLUMN "core" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_online" ADD CONSTRAINT "machine_online_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_tickets" ADD CONSTRAINT "machine_tickets_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_keys" ADD CONSTRAINT "person_keys_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_keys" ADD CONSTRAINT "person_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_path" CHECK (path IS NULL OR path IN ('direct', 'relay'));--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_update_state" CHECK (update_state IS NULL OR update_state IN ('ready', 'installing', 'failed'));--> statement-breakpoint
ALTER TABLE "peer_secrets" ADD CONSTRAINT "peer_secrets_kind" CHECK (kind IN ('data', 'app', 'visit'));