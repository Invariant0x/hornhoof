CREATE TABLE "authority" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"cert_pem" text NOT NULL,
	"key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authority" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "certificates" (
	"serial" text PRIMARY KEY NOT NULL,
	"machine_id" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "peer_secrets" (
	"kind" text PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_secrets_kind" CHECK (kind IN ('data', 'app'))
);
--> statement-breakpoint
ALTER TABLE "peer_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "network_id" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "sign_key" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "web_port" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "peer_port" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "uptime_s" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "fsync_p99_ms" real;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "disk_free" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "report_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_network_id_unique" UNIQUE("network_id");--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_role" CHECK (role IS NULL OR role IN ('data', 'worker'));