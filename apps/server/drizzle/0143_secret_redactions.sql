CREATE TABLE "secret_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"characters" integer NOT NULL,
	"window_hash" integer NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_redactions_length" CHECK ("secret_redactions"."characters" > 0)
);
--> statement-breakpoint
ALTER TABLE "secret_redactions" ADD CONSTRAINT "secret_redactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_redactions" ADD CONSTRAINT "secret_redactions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_redactions_fingerprint" ON "secret_redactions" USING btree ("company_id","fingerprint");
--> statement-breakpoint
-- The server replaces a hidden value in its own process and writes back only the masked text; no function or trigger
-- of the database ever sees the value. Frozen evidence may lose such a value and nothing else: only the server's own
-- connection, in the transaction that hides it, and only in the columns it names for that table.
CREATE OR REPLACE FUNCTION public.outbound_refuse_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  allowed text[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('hornhoof.hiding_secret', true), ''), '[]')::jsonb));
BEGIN
  IF TG_OP = 'UPDATE' AND cardinality(allowed) > 0 AND current_user = session_user
    AND (to_jsonb(NEW) - allowed) = (to_jsonb(OLD) - allowed) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'this change to % is refused: what it holds is never changed or taken back', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON public.secret_redactions FROM PUBLIC;
