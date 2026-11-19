CREATE TABLE "revoked_certificate_serials" (
	"serial" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revoked_certificate_serials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "revoked_certificate_serials_until" ON "revoked_certificate_serials" USING btree ("until");