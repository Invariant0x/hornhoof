CREATE SCHEMA net;
--> statement-breakpoint
CREATE SCHEMA net_local;
--> statement-breakpoint
CREATE TABLE net_local.state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  term_number bigint NOT NULL,
  term_machine text NOT NULL,
  term_split boolean NOT NULL DEFAULT false,
  machine text NOT NULL,
  cluster text NOT NULL
);
--> statement-breakpoint
CREATE TABLE net_local.lease (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  term_number bigint NOT NULL,
  term_machine text NOT NULL,
  term_split boolean NOT NULL DEFAULT false,
  kind text NOT NULL CHECK (kind IN ('normal', 'split', 'maintenance')),
  until timestamptz NOT NULL,
  sync text CHECK (sync IN ('copy', 'relay_off', 'alone'))
);
--> statement-breakpoint
CREATE TABLE net_local.maintenance (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  version text NOT NULL,
  since timestamptz NOT NULL,
  until timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE net.journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xact uuid NOT NULL,
  term_number bigint,
  term_machine text,
  term_split boolean,
  machine text,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tbl text NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  key jsonb NOT NULL,
  cols text[] NOT NULL,
  old jsonb
);
--> statement-breakpoint
CREATE INDEX journal_at ON net.journal (at);
--> statement-breakpoint
-- Only a superuser that does not say it is fenced goes free (ruling 1), and a role that cannot be found does not. The setting
-- comes first, so a fenced app's row reads no pg_roles.
CREATE FUNCTION net.session_fenced() RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
BEGIN
  IF current_setting('hornhoof.fenced', true) = 'on' THEN
    RETURN true;
  END IF;
  RETURN (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) IS NOT TRUE;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.refuse_write() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'This machine holds no lease now, so nothing was changed.' USING ERRCODE = 'HHF01';
END
$fn$;
--> statement-breakpoint
-- Every condition that comes out null, as with a missing row, falls through to the refusal, so what cannot decide refuses.
CREATE FUNCTION net.assert_lease(margin interval, invocation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  st net_local.state;
  le net_local.lease;
BEGIN
  IF NOT net.session_fenced() THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM net_local.state;
  SELECT * INTO le FROM net_local.lease;
  IF (le.term_number, le.term_machine, le.term_split) = (st.term_number, st.term_machine, st.term_split)
     AND le.kind IN ('normal', 'split')
     AND le.until > clock_timestamp() + margin
     AND current_setting('synchronous_commit') = 'on'
     AND (le.kind = 'split' OR le.sync IS NOT NULL) THEN
    RETURN;
  END IF;
  PERFORM net.refuse_write();
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.fence_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, net_local, pg_temp AS $fn$
BEGIN
  PERFORM net.assert_lease('0 s', NULL);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.journal
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
-- The one place a journal row is made, for every table's function. The transaction's uuid comes from its id, which no session can set.
CREATE FUNCTION net.write_journal(changed_table text, change text, row_key jsonb, named_columns text[], old_values jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  st net_local.state;
BEGIN
  SELECT * INTO st FROM net_local.state;
  INSERT INTO net.journal (xact, term_number, term_machine, term_split, machine, tbl, op, key, cols, old)
  VALUES (
    md5(COALESCE(st.cluster, (SELECT system_identifier::text FROM pg_control_system())) || ':' || pg_current_xact_id()::text)::uuid,
    st.term_number, st.term_machine, st.term_split, st.machine, changed_table, change, row_key, named_columns, old_values
  );
END
$fn$;
--> statement-breakpoint
-- A column's value as the journal keeps it, written as SQL over NEW or OLD. A file stays out of the journal: only its hash goes in.
CREATE FUNCTION net.pair_for_journal(side text, col name, type_of_col oid) RETURNS text
LANGUAGE sql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
  SELECT format('jsonb_build_object(%L, %s)', col,
    CASE WHEN type_of_col = 'bytea'::regtype
      THEN format($sql$'sha256:' || encode(sha256(%s.%I), 'hex')$sql$, side, col)
      ELSE format('%s.%I', side, col)
    END);
$fn$;
--> statement-breakpoint
-- The body of one table's journal function. It names the table's columns, so a migration must take it off before it drops one.
-- Pairs go through || because jsonb_build_object takes at most 100 arguments, which a wide table would pass.
CREATE FUNCTION net.source_of_journal(tbl oid, table_name text) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  key_of_new text;
  key_of_old text;
  every_column text;
  whole_old_row text;
  checks text;
BEGIN
  SELECT string_agg(net.pair_for_journal('NEW', a.attname, a.atttypid), ' || '), string_agg(net.pair_for_journal('OLD', a.attname, a.atttypid), ' || ')
    INTO key_of_new, key_of_old
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY ((i.indkey::smallint[])[0:i.indnkeyatts - 1])
    WHERE i.indrelid = tbl AND i.indisprimary;
  IF key_of_new IS NULL THEN
    RAISE EXCEPTION 'Table public.% has no primary key, so the journal could not name its rows.', table_name;
  END IF;
  SELECT 'ARRAY[' || string_agg(quote_literal(a.attname), ', ') || ']::text[]',
         string_agg(net.pair_for_journal('OLD', a.attname, a.atttypid), ' || '),
         string_agg(format('IF NEW.%1$I IS DISTINCT FROM OLD.%1$I THEN changed := changed || %2$L::text; was := was || %3$s; END IF;',
           a.attname, a.attname, net.pair_for_journal('OLD', a.attname, a.atttypid)), E'\n')
    INTO every_column, whole_old_row, checks
    FROM pg_attribute a
    WHERE a.attrelid = tbl AND a.attnum > 0 AND NOT a.attisdropped;
  RETURN format($src$
DECLARE
  changed text[] := '{}';
  was jsonb := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM net.write_journal(%1$L, 'insert', %2$s, %4$s, NULL);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM net.write_journal(%1$L, 'delete', %3$s, %4$s, %5$s);
  ELSE
    %6$s
    PERFORM net.write_journal(%1$L, 'update', %2$s, changed, was);
  END IF;
  RETURN NULL;
END
$src$, table_name, key_of_new, key_of_old, every_column, whole_old_row, checks);
END
$fn$;
--> statement-breakpoint
-- Every table's journal function. Its name starts with journal_ and it returns a trigger, and no other function of net does both.
CREATE FUNCTION net.functions_of_journal() RETURNS TABLE (name text, body text)
LANGUAGE sql STABLE SET search_path = pg_catalog, net_local, pg_temp AS $fn$
  SELECT p.proname::text, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'net' AND p.proname LIKE 'journal\_%' AND p.prorettype = 'trigger'::regtype;
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.set_journal_body(fn_name text, body text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION net.%I() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, net_local, pg_temp AS %L', fn_name, body);
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.public_tables() RETURNS TABLE (tbl oid, name text)
LANGUAGE sql STABLE SET search_path = pg_catalog, net_local, pg_temp AS $fn$
  SELECT c.oid, c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';
$fn$;
--> statement-breakpoint
-- One table's real journal function, and a trigger that calls it. A table renamed in a migration still has the trigger of its old
-- name, which goes, or the row would be journaled under that name and the old function could never be dropped.
CREATE FUNCTION net.attach_journal_to(tbl oid, table_name text) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  fn_name text := 'journal_' || table_name;
BEGIN
  IF octet_length(table_name) > 55 THEN
    RAISE EXCEPTION 'Table public.% has a name over 55 characters, too long for its journal function.', table_name;
  END IF;
  PERFORM net.set_journal_body(fn_name, net.source_of_journal(tbl, table_name));
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = tbl AND tgname = 'net_journal' AND tgfoid = format('net.%I()', fn_name)::regprocedure) THEN
    RETURN false;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS net_journal ON public.%I', table_name);
  EXECUTE format('CREATE TRIGGER net_journal AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION net.%I()', table_name, fn_name);
  RETURN true;
END
$fn$;
--> statement-breakpoint
-- Puts the real body back where a migration left the journal off, and takes no table's strongest lock unless that table needs a
-- trigger. Runs as the last step of a migrate, and again after a killed one.
CREATE FUNCTION net.attach_journal() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  t record;
  fn record;
  attached integer := 0;
BEGIN
  FOR t IN SELECT p.tbl, p.name FROM net.public_tables() p LOOP
    IF net.attach_journal_to(t.tbl, t.name) THEN
      attached := attached + 1;
    END IF;
  END LOOP;
  FOR fn IN SELECT f.name FROM net.functions_of_journal() f
            WHERE NOT EXISTS (SELECT 1 FROM net.public_tables() p WHERE 'journal_' || p.name = f.name) LOOP
    EXECUTE format('DROP FUNCTION net.%I() CASCADE', fn.name);
  END LOOP;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;
  RETURN attached;
END
$fn$;
--> statement-breakpoint
-- Takes the journal off for a migration without taking a table's trigger off, which would need every table's strongest lock and
-- leave a write in that moment with no fence to ask. The body left names no column, so a migration may drop one and then write
-- that table. It refuses a fenced session under any lease, so a run killed here fails closed until the next migrate heals it.
CREATE FUNCTION net.detach_journal() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  fn record;
  detached integer := 0;
BEGIN
  FOR fn IN SELECT f.name FROM net.functions_of_journal() f LOOP
    PERFORM net.set_journal_body(fn.name, $body$
BEGIN
  IF net.session_fenced() THEN
    PERFORM net.refuse_write();
  END IF;
  RETURN NULL;
END
$body$);
    detached := detached + 1;
  END LOOP;
  RETURN detached;
END
$fn$;
--> statement-breakpoint
-- The tables whose journal is off: a journal function that writes no journal row, whatever else its body says.
CREATE FUNCTION net.journals_off() RETURNS TABLE (table_name text)
LANGUAGE sql STABLE SET search_path = pg_catalog, net_local, pg_temp AS $fn$
  SELECT substr(f.name, length('journal_') + 1) FROM net.functions_of_journal() f WHERE f.body NOT LIKE '%net.write_journal(%';
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.foreign_keys_to_defer() RETURNS TABLE (conname text, relname text)
LANGUAGE sql STABLE SET search_path = pg_catalog, net_local, pg_temp AS $fn$
  SELECT k.conname::text, t.relname::text FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE k.contype = 'f' AND NOT k.condeferrable AND n.nspname = 'public';
$fn$;
--> statement-breakpoint
CREATE FUNCTION net.defer_foreign_keys() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, net_local, pg_temp AS $fn$
DECLARE
  fk record;
  made_deferrable integer := 0;
BEGIN
  FOR fk IN SELECT d.conname, d.relname FROM net.foreign_keys_to_defer() d LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk.relname, fk.conname);
    made_deferrable := made_deferrable + 1;
  END LOOP;
  RETURN made_deferrable;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;
