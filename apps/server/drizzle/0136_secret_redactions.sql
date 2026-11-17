CREATE TABLE "secret_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"characters" integer NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_redactions_length" CHECK ("secret_redactions"."characters" > 0)
);
--> statement-breakpoint
ALTER TABLE "secret_redactions" ADD CONSTRAINT "secret_redactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_redactions" ADD CONSTRAINT "secret_redactions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_redactions_fingerprint" ON "secret_redactions" USING btree ("company_id","fingerprint");
--> statement-breakpoint
-- Suppression uses fingerprints only. The selected value is never written to a journal or a suppression row.
CREATE FUNCTION net.hide_secret_text(value text, scope_company uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  secret record;
  pos integer;
  result text := value;
  part text;
  cleaned text[];
BEGIN
  FOR secret IN SELECT fingerprint, characters FROM public.secret_redactions WHERE company_id = scope_company ORDER BY characters DESC, fingerprint LOOP
    cleaned := ARRAY[]::text[];
    FOREACH part IN ARRAY string_to_array(result, '[hidden]') LOOP
      FOR pos IN REVERSE length(part) - secret.characters + 1 .. 1 LOOP
        IF encode(sha256(convert_to(substr(part, pos, secret.characters), 'UTF8')), 'hex') = secret.fingerprint THEN
          part := overlay(part placing '[hidden]' from pos for secret.characters);
        END IF;
      END LOOP;
      cleaned := array_append(cleaned, part);
    END LOOP;
    result := array_to_string(cleaned, '[hidden]');
  END LOOP;
  RETURN result;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.hide_secret_json(value jsonb, scope_company uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  result jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'string' THEN RETURN to_jsonb(net.hide_secret_text(value #>> '{}', scope_company));
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(net.hide_secret_json(item, scope_company) ORDER BY n), '[]'::jsonb) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS a(item, n);
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(
        CASE WHEN key = ANY (ARRAY['text','data','body','title','brief','evidence','message','messages','_message','kind','status','type','id','name','direction','at','seq','number']) OR key ~ '(_id|Id|_hash|_digest)$'
          THEN key ELSE net.hide_secret_text(key, scope_company) END,
        CASE WHEN key = ANY (ARRAY['kind','status','type','id','direction','at','seq','number','code']) OR key ~ '(_id|Id|_hash|_digest)$'
          THEN item ELSE net.hide_secret_json(item, scope_company) END), '{}'::jsonb)
        INTO result FROM jsonb_each(value) AS o(key, item);
    ELSE RETURN value;
  END CASE;
  RETURN result;
END
$fn$;
--> statement-breakpoint
-- Prose may be copied between tables, but service state, identities, keys and credentials are never prose.
CREATE FUNCTION net.secret_text_columns(source text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT ARRAY['text','body','title','brief','prompt','requested_prompt','result','tail','question','answer','note',
    'evidence','description','goal','messages','data','options','summary','details','failure','interruption','sent_report','message']::text[]
    || CASE source
      WHEN 'public.tasks' THEN ARRAY['external_wait','paused']
      WHEN 'public.outbound_catalog_revisions' THEN ARRAY['value']
      WHEN 'public.turn_releases' THEN ARRAY['tasks']
      WHEN 'public.briefings' THEN ARRAY['files']
      WHEN 'public.program_operator_cases' THEN ARRAY['resolution']
      WHEN 'net.parked' THEN ARRAY['body']
      WHEN 'net.merge_conflicts' THEN ARRAY['why']
      ELSE ARRAY[]::text[] END;
$fn$;
--> statement-breakpoint
-- Replication records keep whole or partial rows. Clean the prose of the named table, preserving its service fields.
-- Resolve the company of prose and of its stored copies. A partial journal row uses its primary key; a deleted row's
-- company remains in the journal's full deletion record. Unknown ownership never applies another company's suppression.
CREATE FUNCTION net.secret_company(value jsonb, source text, row_key jsonb DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  scope_company uuid;
  field text;
  stored jsonb;
  source_table text;
BEGIN
  IF value->>'company_id' IS NOT NULL THEN RETURN (value->>'company_id')::uuid; END IF;
  IF source = 'public.companies' THEN RETURN coalesce(value->>'id', row_key->>'id')::uuid; END IF;
  IF source IN ('net.journal', 'net.merge_rows', 'net.merge_conflicts') THEN
    FOREACH field IN ARRAY ARRAY['here','there','old','was','value'] LOOP
      scope_company := net.secret_company(value->field, 'public.' || (value->>'tbl'), value->'key');
      IF scope_company IS NOT NULL THEN RETURN scope_company; END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF source IN ('public.tool_calls', 'net.parked') AND value->>'job_id' IS NOT NULL THEN
    RETURN net.secret_company(NULL, 'public.jobs', jsonb_build_object('id', value->>'job_id'));
  END IF;
  IF source LIKE 'public.%' AND row_key IS NOT NULL AND row_key <> '{}'::jsonb THEN
    source_table := substr(source, 8);
    IF to_regclass(format('public.%I', source_table)) IS NOT NULL THEN
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE to_jsonb(t) @> $1 LIMIT 1', source_table) INTO stored USING row_key;
      IF stored IS NOT NULL THEN RETURN net.secret_company(stored, source); END IF;
    END IF;
    SELECT (j.old->>'company_id')::uuid INTO scope_company FROM net.journal j
      WHERE j.tbl = source_table AND j.key = row_key AND j.old ? 'company_id' ORDER BY j.at DESC, j.id LIMIT 1;
    RETURN scope_company;
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.hide_secret_row(value jsonb, source text, inherited_company uuid DEFAULT NULL, row_key jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  result jsonb := value;
  field text;
  bytes bytea;
  scope_company uuid := coalesce(net.secret_company(value, source, row_key), inherited_company);
BEGIN
  IF source IN ('net.journal', 'net.merge_rows', 'net.merge_conflicts') THEN
    FOREACH field IN ARRAY ARRAY['old','was','here','there','value'] LOOP
      IF value ? field THEN result := result || jsonb_build_object(field, net.hide_secret_row(value->field, 'public.' || (value->>'tbl'), scope_company, value->'key')); END IF;
    END LOOP;
  END IF;
  FOREACH field IN ARRAY net.secret_text_columns(source) LOOP
    IF value ? field THEN result := result || jsonb_build_object(field, net.hide_secret_json(value->field, scope_company)); END IF;
  END LOOP;
  IF source = 'public.attachments' AND value ? 'bytes' AND (value->>'media_type' LIKE 'text/%' OR value->>'media_type' = 'application/json') THEN
    bytes := convert_to(net.hide_secret_text(convert_from((value->>'bytes')::bytea, 'UTF8'), scope_company), 'UTF8');
    result := result || jsonb_build_object('bytes', bytes, 'size', octet_length(bytes));
  END IF;
  RETURN result;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.suppress_hidden_secrets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.secret_redactions) THEN
    NEW := jsonb_populate_record(NEW, net.hide_secret_row(to_jsonb(NEW), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME));
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
-- A suppression arriving from an old copy is applied here too; it never waits for a person to repeat the action.
CREATE FUNCTION net.sweep_hidden_secrets() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT n.nspname, c.relname, (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 1) AS first_column
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'net') AND c.relkind = 'r' AND c.relname <> 'secret_redactions'
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('UPDATE %I.%I AS t SET %I = %I WHERE net.secret_company(to_jsonb(t), %L) = $1 AND net.hide_secret_row(to_jsonb(t), %L) IS DISTINCT FROM to_jsonb(t)', tbl.nspname, tbl.relname, tbl.first_column, tbl.first_column, tbl.nspname || '.' || tbl.relname, tbl.nspname || '.' || tbl.relname) USING NEW.company_id;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
DO $fn$
DECLARE tbl record;
BEGIN
  FOR tbl IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'net') AND c.relkind = 'r' AND c.relname <> 'secret_redactions'
  LOOP
    EXECUTE format('CREATE TRIGGER a_suppress_hidden_secrets BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION net.suppress_hidden_secrets()', tbl.nspname, tbl.relname);
  END LOOP;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER sweep_hidden_secrets AFTER INSERT ON public.secret_redactions FOR EACH ROW EXECUTE FUNCTION net.sweep_hidden_secrets();
--> statement-breakpoint
-- Frozen evidence may only lose the text that an authorized person already suppressed. Every other change stays refused.
CREATE OR REPLACE FUNCTION public.outbound_refuse_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
    AND to_jsonb(NEW) = net.hide_secret_row(to_jsonb(OLD), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'this change to % is refused: what it holds is never changed or taken back', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON public.secret_redactions FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION net.hide_secret_text(text, uuid), net.hide_secret_json(jsonb, uuid), net.secret_company(jsonb, text, jsonb), net.hide_secret_row(jsonb, text, uuid, jsonb), net.secret_text_columns(text), net.suppress_hidden_secrets(), net.sweep_hidden_secrets() FROM PUBLIC;
