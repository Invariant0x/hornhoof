# shellcheck shell=bash
# A machine that comes to keep the company's data, and one that gives it up. A worker the company server gives the data
# becomes one that keeps a copy. A machine that stopped holding the company's data gives what it held to the company
# server and is then wiped. Its keeper asks with upload.json {id} for every table of its database as CSV, packed into
# uploads/<id>.tar.gz. The company server's keeper takes that file and asks with load.json for it as a database of its
# own, which this fills with the server's own schema and the file's rows, as rows alone. Once the server has it merged
# and saved, the machine's keeper asks with wipe.json {id} for the database, its dumps and the company's secrets to go,
# step by step.

# Everything of a machine that keeps a copy starts but the updater itself: the database, its app and the two a worker
# runs. The role is set for compose here, since this updater's own environment holds the one it was started with, which
# would win over the settings.
data_up() {
  local services
  services=$(compose config --services 2> /dev/null | grep -v '^updater$' | tr '\n' ' ') || return 1
  [ -n "${services// /}" ] || return 1
  # shellcheck disable=SC2086 # services is a space-separated list of compose service names.
  HORNHOOF_ROLE=data compose up -d --no-build $services > /dev/null 2>&1
}

# stay_worker <what failed>: the machine could not become one that keeps a copy, so everything is as before: the
# settings of before, with the password of a database that was started, no database running, and the two a worker runs. The keeper reads role.failed, tells the company,
# and tries again an hour later.
stay_worker() {
  local password
  # The password its database was started with stays: the database's volume was made with it, and the next try would
  # else make another that the volume does not take.
  password=$(env_value POSTGRES_PASSWORD)
  if [ -f "$SERVER_DIR/.env.before-data" ]; then as_env "$SERVER_DIR/.env.before-data" || true; fi
  if [ -n "$password" ] && [ -z "$(env_value POSTGRES_PASSWORD)" ]; then PUT_VALUE=$password put_env POSTGRES_PASSWORD || true; fi
  rm -f "$CONTROL/role.json" "$CONTROL/role-secrets.json" "$CONTROL/replica.json"
  COMPOSE_PROFILES=data,builtin compose rm -sf db migrate app node > /dev/null 2>&1 || true
  HORNHOOF_ROLE=worker compose up -d --no-build front keeper > /dev/null 2>&1 || true
  publish "$CONTROL/role.failed" keeper printf "The company's settings cannot be written here, so this machine stays a worker.\n" || true
  say "This machine stays a worker: could not $1."
}

# The settings a copy needs go into .env: the company's three, each checked as a backup's are, a password for its own
# database when it has none, and the role and the profiles that start the database, the app and this machine's own
# built-in node. No value is said. The secrets from the order go into a file of the updater's own, where neither
# the app nor the keeper can reach.
data_settings() {
  local from secret node_key relay ok=''
  from=$(mktemp) || return 1
  if (umask 077 && quiet jq '.secrets // {}' <<< "$1" > "$from") &&
    secret=$(setting HORNHOOF_SECRET "$from") && node_key=$(setting NODE_KEY "$from") && relay=$(setting RELAY_URL "$from"); then ok=1; fi
  rm -f -- "${from:?}"
  [ -n "$ok" ] && [ -n "$secret" ] && [ -n "$relay" ] || return 1
  write_env "$secret" "$node_key" "$relay" || return 1
  if [ -z "$(env_value POSTGRES_PASSWORD)" ]; then PUT_VALUE=$(new_password) put_env POSTGRES_PASSWORD || return 1; fi
  PUT_VALUE=data put_env HORNHOOF_ROLE && PUT_VALUE=data,builtin put_env COMPOSE_PROFILES
}

# The keeper of a worker that the company server gave the data left role.json {id, secrets}: this machine becomes one
# that keeps a copy. The settings of before stay beside the new ones until everything runs, so an updater that stopped
# in the middle finishes or undoes it.
become_data() {
  local order
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  order=$(take "$CONTROL/role.json") || return 0
  (umask 077 && cp "$SERVER_DIR/.env" "$SERVER_DIR/.env.before-data") || { stay_worker 'keep its settings of before'; return 0; }
  data_settings "$order" || { rm -f "$CONTROL/role-secrets.json"; stay_worker "write the company's settings"; return 0; }
  rm -f "$CONTROL/role.json" "$CONTROL/role-secrets.json"
  data_up || { stay_worker 'start its database'; return 0; }
  swap_updater "$(own_image)"
  rm -f "$SERVER_DIR/.env.before-data"
}

# The settings of before are still there: an updater stopped while this machine became one that keeps a copy. With the
# new settings whole, it starts what they name and replaces itself; else it stays a worker.
finish_become() {
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env.before-data" ] || return 0
  if [ "$(env_value HORNHOOF_ROLE)" != data ] || [ "$(env_value COMPOSE_PROFILES)" != data,builtin ]; then
    stay_worker 'finish what a restart cut short'
    return 0
  fi
  rm -f "$CONTROL/role.json" "$CONTROL/role-secrets.json"
  data_up || { stay_worker 'start its database'; return 0; }
  swap_updater "$(own_image)"
  rm -f "$SERVER_DIR/.env.before-data"
}

# load_schema <database> <port> <password>: the leader's schema, and the count of its migrations, read through the
# keeper's door as the role that only reads, and loaded into that database here in one piece. It prints why it could
# not. The password is read from the request into this one command's environment: it stands on no command line and in
# no line said, and goes on into the file the copy's subscription reads it from, in the database's own folder.
load_schema() {
  local database=$1 port=$2 password=$3 db tables dump status=0 said
  [ -n "$password" ] || { printf 'The schema request has no password.'; return 1; }
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || { printf "This machine's database does not run."; return 1; }
  tables=$(docker exec "$db" psql -U hornhoof -d "$database" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2> /dev/null) ||
    { printf "This machine's database could not be asked."; return 1; }
  [ "$tables" = 0 ] || { printf 'The database is not empty.'; return 1; }
  dump=$(mktemp) || { printf "The company server's schema could not be read."; return 1; }
  (
    umask 077
    export PGPASSWORD="$password"
    schema_roles "$db" "$port" > "$dump" || exit $?
    docker exec -e PGPASSWORD "$db" pg_dump -h keeper -p "$port" -U hornhoof_replica --schema-only --no-owner --no-publications --no-subscriptions --no-privileges hornhoof >> "$dump" 2> /dev/null &&
      docker exec -e PGPASSWORD "$db" pg_dump -h keeper -p "$port" -U hornhoof_replica --data-only --table=drizzle.__drizzle_migrations hornhoof >> "$dump" 2> /dev/null &&
      # The schema comes with no rights, since the leader's roles are not this machine's. A function is open to
      # everyone until it is closed, and a keeper leads on no database whose network functions are: they are closed
      # as the leader's own migration closes them, so a copy that takes the server over may lead.
      printf '%s\n' 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;' >> "$dump"
  ) || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$dump"
    if [ "$status" -eq 2 ]; then printf "The company server's schema returned an invalid role name."; else printf "The company server's schema could not be read."; fi
    return 1
  fi
  write_passfile "$db" "$password" || { rm -f "$dump"; printf "The password file of the copy could not be written."; return 1; }
  # What psql said goes into the line, without its place in the dump: no log would show why otherwise.
  if ! said=$(docker exec -i "$db" psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d "$database" < "$dump" 2>&1 > /dev/null); then
    rm -f "$dump"
    said=$(printf '%s\n' "$said" | grep -m 1 -E 'ERROR|FATAL|error' | sed -E 's/^psql:[^ ]*: //' | cut -c 1-300)
    printf 'The schema could not be loaded into the database%s' "${said:+: $said}"
    return 1
  fi
  rm -f "$dump"
}

# Roles referenced by policies or foreign user mappings still appear in a dump without owners or grants. Encode each
# name on the leader so newlines and quotes cross the shell as data. The copy creates missing roles without any grants
# or memberships in the same transaction as the schema.
schema_roles() {
  local db=$1 port=$2 roles encoded
  roles=$(docker exec -e PGPASSWORD "$db" psql -h keeper -p "$port" -U hornhoof_replica -d hornhoof -At -v ON_ERROR_STOP=1 -c "
    SELECT pg_catalog.encode(pg_catalog.convert_to(r.rolname::text, 'UTF8'), 'hex')
    FROM pg_catalog.pg_roles r
    JOIN (
      SELECT pg_catalog.unnest(polroles) AS oid FROM pg_catalog.pg_policy
      UNION
      SELECT umuser FROM pg_catalog.pg_user_mappings
    ) referenced USING (oid)
    ORDER BY 1" 2> /dev/null) || return 1
  [ -n "$roles" ] || return 0
  while IFS= read -r encoded; do [[ "$encoded" =~ ^([0-9a-f]{2}){1,252}$ ]] || return 2; done <<< "$roles"
  roles=${roles//$'\n'/,}
  # shellcheck disable=SC2016 # $roles$ is the SQL block delimiter.
  printf '%s\n' 'DO $roles$' 'DECLARE encoded text; wanted text;' 'BEGIN'
  printf "  FOREACH encoded IN ARRAY pg_catalog.string_to_array('%s', ',') LOOP\n" "$roles"
  cat <<'SQL'
    wanted := pg_catalog.convert_from(pg_catalog.decode(encoded, 'hex'), 'UTF8');
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = wanted) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOINHERIT', wanted);
    END IF;
  END LOOP;
END $roles$;
SQL
}

# write_passfile: the password of the role that only reads, into the file the copy's subscription
# reads it from, in the database's own folder. It stands on no command line and in no line said.
write_passfile() {
  local db=$1 password=$2
  [ -n "$password" ] || return 1
  # shellcheck disable=SC2016 # PGDATA is the database container's own, read there.
  printf '*:*:*:hornhoof_replica:%s\n' "$password" |
    docker exec -i -u postgres "$db" sh -c '
      umask 077
      tmp=$(mktemp "$PGDATA/.replica.pgpass.XXXXXXXX") || exit 1
      if cat > "$tmp" && mv -fT -- "$tmp" "$PGDATA/replica.pgpass"; then exit 0; fi
      rm -f -- "$tmp"
      exit 1
    ' > /dev/null 2>&1
}

# passfile_alone: for a copy that joins a slot of the leader's and holds every table already. It prints why it could
# not.
passfile_alone() {
  local db
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || { printf "This machine's database does not run."; return 1; }
  write_passfile "$db" "$1" || { printf "The password file of the copy could not be written."; return 1; }
}

# The keeper of a machine that keeps a copy asks, with schema.json {attempt, database, port, password}, for the leader's
# schema in a database of this machine: the copy then fills it by itself. This answers in schema/<attempt>.done, or
# .failed with a line, and removes the request. A request that names what no database, port or attempt is called is
# dropped. With only: "passfile" it asks for the password file alone, whatever was answered under that attempt before:
# a copy that joins the slot a new leader made for it holds its tables already.
schema_request() {
  local request="$CONTROL/schema.json" asked attempt database port only password reason
  [ -n "$SERVER_DIR" ] || return 0
  asked=$(take "$request") || return 0
  attempt=$(jq -r '.attempt // empty | tostring' <<< "$asked" 2> /dev/null || true)
  database=$(jq -r '.database // empty | tostring' <<< "$asked" 2> /dev/null || true)
  port=$(jq -r '.port // empty | tostring' <<< "$asked" 2> /dev/null || true)
  only=$(jq -r '.only // empty | tostring' <<< "$asked" 2> /dev/null || true)
  password=$(jq -r '.password | strings | select(test("[\\r\\n]") | not)' <<< "$asked" 2> /dev/null || true)
  if ! plain_count "$attempt" || ! plain_database "$database" || ! plain_count "$port" || { [ -n "$only" ] && [ "$only" != passfile ]; }; then
    rm -f "$request"
    return 0
  fi
  if [ "$only" = passfile ]; then
    keeper_dir "$CONTROL/schema" || return 0
    remove_in "$CONTROL/schema" "$attempt.done" "$attempt.failed"
  elif [ -f "$CONTROL/schema/$attempt.done" ] || [ -f "$CONTROL/schema/$attempt.failed" ]; then
    rm -f "$request"
    return 0
  fi
  keeper_dir "$CONTROL/schema" || return 0
  if reason=$(if [ "$only" = passfile ]; then passfile_alone "$password"; else load_schema "$database" "$port" "$password"; fi); then
    publish "$CONTROL/schema/$attempt.done" keeper : || true
  else
    publish "$CONTROL/schema/$attempt.failed" keeper printf '%s\n' "$reason" || true
    say "Could not load the company's schema for a copy: $reason"
  fi
  rm -f "$request"
}

# The name of a table as an upload holds it: one of the three schemas the company's rows are in, and its name. And the
# name of a column. Nothing else of an upload ever stands in a statement, and each between quotes.
plain_table() {
  [[ "$1" =~ ^(public|net|net_local)\.[a-z_][a-z0-9_]*$ ]]
}
plain_column() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]]
}
# The name of a database made of an upload, as the keeper that took it names it, and of no other.
upload_name() {
  [[ "$1" =~ ^hornhoof_upload_[0-9a-f]{16}_[0-9]{8}t[0-9]{6}$ ]]
}
quoted_table() { printf '"%s"."%s"' "${1%%.*}" "${1#*.}"; }

# The folder uploads are made in on a machine that leaves the data, and taken into on the company server.
uploads_dir() { keeper_dir "$CONTROL/uploads"; }

# scratch <name>: a private folder of the updater for one upload's tables.
scratch() {
  mktemp -d "${TMPDIR:-/tmp}/hornhoof-$1.XXXXXXXX"
}

# upload_said <name> <done | failed> [line]: how an upload, or its load, ended, for the keeper alone to read.
upload_said() {
  publish "$CONTROL/uploads/$1.$2" keeper printf '%s' "${3:+$3
}"
}

# make_upload <id> <db container>: every table of the company's three schemas in the database in use here, as CSV with
# its header, one file a table, in one packed file for the keeper to send. The tables are written in a folder of the
# updater's own first. UPLOAD_WHY says why it could not.
UPLOAD_WHY=''
make_upload() {
  local id=$1 db=$2 dir tables table status=0
  UPLOAD_WHY="This machine's database could not be asked."
  tables=$(docker exec "$db" psql -U hornhoof -d hornhoof -At -c "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'net', 'net_local') ORDER BY 1" 2> /dev/null) &&
    [ -n "$tables" ] || return 1
  UPLOAD_WHY='A table could not be read.'
  for table in $tables; do plain_table "$table" || return 1; done
  UPLOAD_WHY='The folder for the upload could not be made.'
  dir=$(scratch upload) || return 1
  publish "$CONTROL/uploads/$id.tar.gz" keeper pack_tables "$db" "$dir" "$tables" || status=$?
  rm -rf -- "${dir:?}"
  case "$status" in
    0) return 0 ;;
    3) UPLOAD_WHY='A table could not be read.' ;;
    4) UPLOAD_WHY='The upload could not be packed.' ;;
  esac
  return 1
}

# pack_tables <db container> <folder> <tables>: each table as CSV with its header into the folder, then all of them packed
# on the standard output. It fails with 3 when a table could not be read, and with 4 when they could not be packed.
pack_tables() {
  local db=$1 dir=$2 table names=''
  for table in $3; do
    (umask 077 && docker exec "$db" psql -U hornhoof -d hornhoof -v ON_ERROR_STOP=1 -q -c "COPY $(quoted_table "$table") TO STDOUT (FORMAT csv, HEADER true)" > "$dir/$table.csv" 2> /dev/null) || return 3
    names="$names $table.csv"
  done
  # shellcheck disable=SC2086 # names is a list of file names made of checked table names.
  tar -czf - -C "$dir" $names 2> /dev/null || return 4
}

# The keeper of a machine that stopped holding the company's data asks, with upload.json {id}, for everything its
# database holds, to send it to the company server. This answers in uploads/<id>.done beside uploads/<id>.tar.gz, or
# in .failed with a line, and removes the request. Only a machine that keeps a copy makes one.
upload_request() {
  local request="$CONTROL/upload.json" id db
  [ -n "$SERVER_DIR" ] && [ -f "$CONTROL/replica.json" ] || return 0
  id=$(take "$request" quiet jq -r '.id // empty | tostring') || return 0
  if ! plain_id "$id" || [ -f "$CONTROL/uploads/$id.done" ] || [ -f "$CONTROL/uploads/$id.failed" ]; then
    rm -f "$request"
    return 0
  fi
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 0
  uploads_dir || return 0
  if make_upload "$id" "$db"; then
    upload_said "$id" 'done' || true
  else
    remove_in "$CONTROL/uploads" "$id.tar.gz"
    upload_said "$id" failed "$UPLOAD_WHY" || true
    say "Could not make the upload of this machine's copy: $UPLOAD_WHY"
  fi
  rm -f "$request"
}

# tar_members <archive>: the members of a tar archive, a line each, as its own headers have them and not as a tar makes
# of them: "file <name>" for a plain file as this updater packs one, and "other <name>" for anything else: a link of either
# kind, a folder, a device, a pipe, a header that names or changes another member, and a plain file that names a link,
# which BusyBox tar makes a second name of. A name is given only when it is printable. Fails for an archive whose headers
# cannot be followed to its end, or that holds anything but zeros after the block that ends it; with 2 for one of more
# members than UPLOAD_MOST, read no further, as each header costs a command.
UPLOAD_MOST=1000
tar_members() {
  local archive=$1 total at=0 count=0 head name size octal kind i pair ch
  total=$(wc -c < "$archive") || return 1
  while [ "$at" -lt "$total" ]; do
    [ "$((total - at))" -ge 512 ] || return 1
    head=$(od -An -v -tx1 -j "$at" -N 512 -- "$archive" | tr -d ' \n') && [ "${#head}" = 1024 ] || return 1
    if [ "${head:0:2}" = 00 ]; then
      # A block with no name ends the archive; BusyBox tar reads on past one such block, so only zeros may follow.
      [ "$(tail -c "+$((at + 1))" -- "$archive" | tr -d '\000' | head -c 1 | wc -c)" -eq 0 ] || return 1
      return 0
    fi
    count=$((count + 1))
    [ "$count" -le "$UPLOAD_MOST" ] || return 2
    name=''
    for ((i = 0; i < 200; i += 2)); do
      pair=${head:i:2}
      [ "$pair" != 00 ] || break
      if [[ ! "$pair" =~ ^(2[1-9a-f]|[3-6][0-9a-f]|7[0-9a-e])$ ]]; then
        name=''
        break
      fi
      printf -v ch '%b' "\\x$pair"
      name+=$ch
    done
    # The size, in octal digits and nothing else before the spaces or zeros that end the field.
    size=${head:248:24}
    while [ "${size: -2}" = 00 ] || [ "${size: -2}" = 20 ]; do size=${size%??}; done
    [[ "$size" =~ ^(3[0-7])+$ ]] || return 1
    octal=''
    for ((i = 1; i < ${#size}; i += 2)); do octal+=${size:i:1}; done
    size=$((8#$octal))
    # Type 0, no name of a link, and no prefix for the name.
    kind=other
    if [ "${head:312:2}" = 30 ] && [[ "${head:314:200}${head:690:310}" =~ ^(00)+$ ]]; then kind='file'; fi
    printf '%s %s\n' "$kind" "$name"
    at=$((at + 512 + (size + 511) / 512 * 512))
  done
  [ "$at" -eq "$total" ]
}

# unpack_upload <file> <folder> <most bytes>: the files of an upload, each the rows of one table and nothing else: no
# other name, no folder, no link, and no more than it may unpack to. The upload is taken from the shared folder the
# keeper put it in, and unpacked into a folder of the updater's own, only once the headers of the archive itself say
# that it holds nothing else.
unpack_upload() {
  local file=$1 dir=$2 max=$3 archive="$2.tar" n members kind names name item links count=0 status=0 listed=0
  UPLOAD_WHY='The folder to unpack the upload in could not be made.'
  (umask 077 && mkdir "$dir") || return 1
  UPLOAD_WHY='The upload unpacks to more than it may.'
  (umask 077 && take "$file" quiet gunzip -c | head -c "$((max + 1))" > "$archive") || status=$?
  n=$(wc -c < "$archive") || return 1
  [ "$n" -le "$max" ] || return 1
  UPLOAD_WHY='The upload cannot be read.'
  [ "$status" -eq 0 ] || return 1
  members=$(tar_members "$archive") || listed=$?
  UPLOAD_WHY='The upload holds a file that is no table of the company.'
  [ "$listed" -ne 2 ] || return 1
  UPLOAD_WHY='The upload cannot be read.'
  [ "$listed" -eq 0 ] && [ -n "$members" ] || return 1
  UPLOAD_WHY='The upload holds a file that is no table of the company.'
  while read -r kind name; do
    plain_table "${name%.csv}" && [ "$name" != "${name%.csv}" ] || return 1
  done <<< "$members"
  UPLOAD_WHY='The upload holds a table twice.'
  [ -z "$(cut -d ' ' -f 2 <<< "$members" | sort | uniq -d)" ] || return 1
  UPLOAD_WHY='The upload holds what is no file.'
  while read -r kind name; do
    [ "$kind" = file ] || return 1
  done <<< "$members"
  # Tar has to see the same members, name by name, or it would unpack what was not looked at.
  UPLOAD_WHY='The upload cannot be read.'
  names=$(quiet tar -tf "$archive") && [ "$names" = "$(cut -d ' ' -f 2 <<< "$members")" ] || return 1
  (umask 077 && quiet tar -xf "$archive" -C "$dir") || return 1
  UPLOAD_WHY='The upload holds what is no file.'
  # And what it made is those files, each with its one name.
  for item in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${item##*/}
    [ ! -L "$item" ] && [ -f "$item" ] && links=$(facts "$item") && links=${links#* } && [ "${links%% *}" = 1 ] &&
      plain_table "${name%.csv}" && [ "$name" != "${name%.csv}" ] || return 1
    count=$((count + 1))
  done
  [ "$count" -eq "$(wc -l <<< "$members")" ]
}

# load_table <database> <file> <table> <columns of the server, one a line>: the rows of one file go into their table,
# by the columns its header names, each of which the table has. The rows reach the database on the standard input of a
# command of their own, so nothing of them is ever read as a statement.
load_table() {
  local loading=$1 path=$2 table=$3 columns=$4 header='' column list='' names
  UPLOAD_WHY='A file of the upload names a column its table has none of.'
  IFS= read -r header < "$path" || [ -n "$header" ] || return 1
  header=${header%$'\r'}
  IFS=, read -r -a names <<< "$header"
  [ "${#names[@]}" -gt 0 ] || return 1
  for column in "${names[@]}"; do
    plain_column "$column" || return 1
    case "
$columns
" in *"
$table.$column
"*) ;; *) return 1 ;; esac
    list="$list${list:+, }\"$column\""
  done
  UPLOAD_WHY='A table of the upload could not be loaded.'
  docker exec -e PGOPTIONS='-c session_replication_role=replica' -i "$DBC" psql -U hornhoof -d "$loading" -v ON_ERROR_STOP=1 -q \
    -c "\\copy $(quoted_table "$table") ($list) FROM STDIN WITH (FORMAT csv, HEADER true)" < "$path" > /dev/null 2>&1
}

# load_upload <file> <database> <most bytes unpacked> <work folder>: what a machine uploaded becomes a database of this
# server, under another name until it is whole: this server's own schema, and each file as the rows of its table, with
# no trigger run. No statement of the machine's runs: its bytes reach the database only as rows. It unpacks and dumps in
# the work folder, the updater's own. UPLOAD_WHY says why it could not.
load_upload() {
  local file=$1 database=$2 max=$3 loading="hornhoof_uploading_${2#hornhoof_upload_}" dir="$4/loading" schema="$4/loading.sql"
  local tables columns path table
  unpack_upload "$file" "$dir" "$max" || return 1
  UPLOAD_WHY='The database for the upload could not be made.'
  psql_on postgres -c "CREATE DATABASE $loading" > /dev/null 2>&1 || return 1
  UPLOAD_WHY="This server's schema could not be loaded into the database for the upload."
  (
    umask 077
    docker exec "$DBC" pg_dump -U hornhoof --schema-only --no-owner --no-privileges --no-publications --no-subscriptions -d hornhoof > "$schema" 2> /dev/null &&
      docker exec "$DBC" pg_dump -U hornhoof --data-only --table=drizzle.__drizzle_migrations -d hornhoof >> "$schema" 2> /dev/null
  ) &&
    docker exec -i "$DBC" psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d "$loading" < "$schema" > /dev/null 2>&1 || return 1
  UPLOAD_WHY='The database for the upload could not be asked.'
  tables=$(psql_on "$loading" -At -c "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'net', 'net_local')" 2> /dev/null) || return 1
  columns=$(psql_on "$loading" -At -c "SELECT table_schema || '.' || table_name || '.' || column_name FROM information_schema.columns WHERE table_schema IN ('public', 'net', 'net_local')" 2> /dev/null) || return 1
  for path in "$dir"/*.csv; do
    table=$(basename "$path" .csv)
    case "
$tables
" in
      *"
$table
"*) ;;
      *)
        say "The upload holds a table this server has none of: $table."
        continue
        ;;
    esac
    load_table "$loading" "$path" "$table" "$columns" || return 1
  done
  UPLOAD_WHY='The database of the upload could not be given its name.'
  psql_on postgres -c "ALTER DATABASE $loading RENAME TO $database" > /dev/null 2>&1
}

# The keeper of the company server took what a machine uploaded and asks, with load.json {id, machine, file, database,
# unpackMax}, for it as a database the merge reads. This answers beside the file's place in uploads/, in <its name
# without .tar.gz>.done or .failed with a line, removes the file and what it unpacked whatever the end, and then the
# request. A database a stop left half loaded goes first, and one that failed goes at once.
load_request() {
  local request="$CONTROL/load.json" asked file database max name old work ok=''
  if worker || [ -z "$SERVER_DIR" ]; then return 0; fi
  asked=$(take "$request") || return 0
  file=$(jq -r '.file // empty | tostring' <<< "$asked" 2> /dev/null || true)
  database=$(jq -r '.database // empty | tostring' <<< "$asked" 2> /dev/null || true)
  max=$(jq -r '.unpackMax // empty | tostring' <<< "$asked" 2> /dev/null || true)
  name=${file##*/}
  name=${name%.tar.gz}
  # The id of the machine it came from, in the length today's installs have or the one older installs had.
  if ! [[ "$name" =~ ^([0-9a-f]{32}|[0-9a-f]{64})-[0-9a-f-]{36}$ ]] || [ -f "$CONTROL/uploads/$name.done" ] || [ -f "$CONTROL/uploads/$name.failed" ]; then
    rm -f "$request"
    return 0
  fi
  DBC=$(compose ps -q db 2> /dev/null || true)
  [ -n "$DBC" ] || return 0
  uploads_dir || return 0
  for old in $(db_names || true); do
    case "$old" in hornhoof_uploading_*) if plain_database "$old"; then psql_on postgres -c "DROP DATABASE IF EXISTS $old" > /dev/null 2>&1 || true; fi ;; esac
  done
  UPLOAD_WHY='The folder to unpack the upload in could not be made.'
  if work=$(scratch load); then
    UPLOAD_WHY='The request names no database of an upload.'
    if upload_name "$database" && plain_number "$max" && [ "${#max}" -le 15 ] && load_upload "$CONTROL/uploads/$name.tar.gz" "$database" "$max" "$work"; then ok=1; fi
    rm -rf -- "${work:?}"
  fi
  remove_in "$CONTROL/uploads" "$name.tar.gz"
  if [ -n "$ok" ]; then
    upload_said "$name" 'done' || true
  else
    if upload_name "$database"; then psql_on postgres -c "DROP DATABASE IF EXISTS hornhoof_uploading_${database#hornhoof_upload_}" > /dev/null 2>&1 || true; fi
    upload_said "$name" failed "$UPLOAD_WHY" || true
    say "Could not load what a machine uploaded: $UPLOAD_WHY"
  fi
  rm -f "$request"
}

# The volume this machine's database keeps its files in, by the name Docker knows it by; nothing when compose does not
# say.
db_volume() {
  COMPOSE_PROFILES=data compose config --format json 2> /dev/null |
    jq -r '((.services.db.volumes // []) | map(select(.type == "volume" and .target == "/var/lib/postgresql/data")) | .[0].source // empty) as $key | .volumes[$key].name // empty' 2> /dev/null || true
}

# Whether this machine's database may be wiped: 0 when no database of it ever led the company, or its volume is gone
# already; 2 when one did; 1 when it could not be asked, which wipes nothing either. A database that led holds what
# only a merge may bring back, and is never removed here.
wipe_check() {
  local volume db names name has led
  volume=$(db_volume)
  [ -n "$volume" ] || return 1
  docker volume inspect "$volume" > /dev/null 2>&1 || return 0
  db=$(compose ps -q db 2> /dev/null || true)
  if [ -z "$db" ]; then
    HORNHOOF_ROLE=data COMPOSE_PROFILES=data compose up -d --no-build db > /dev/null 2>&1 || true
    return 1
  fi
  names=$(docker exec "$db" psql -U hornhoof -d postgres -tAc "SELECT COALESCE(string_agg(datname, ' '), '') FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2> /dev/null) || return 1
  for name in $names; do
    plain_database "$name" || return 1
    has=$(docker exec "$db" psql -U hornhoof -d "$name" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'net_local' AND c.relname = 'state'" 2> /dev/null | tr -d ' ') || return 1
    [ "$has" != 0 ] || continue
    # A term that ended in a planned handover wrote nothing the new leader lacks, and does not count.
    led=$(docker exec "$db" psql -U hornhoof -d "$name" -tAc "SELECT count(*) FROM net_local.state s WHERE to_jsonb(s) ->> 'handed_lsn' IS NULL" 2> /dev/null | tr -d ' ') || return 1
    [ "$led" = 0 ] || return 2
  done
}

# The address of the company a wiped machine reaches as a worker: https and a host name, nothing more.
company_address() {
  case "$1" in https://?*) ;; *) return 1 ;; esac
  case "${1#https://}" in *[!A-Za-z0-9.-]* | .* | *. | -*) return 1 ;; esac
  [ "${#1}" -le 200 ]
}

# The overlay a joined machine's compose file goes with comes from the build that runs here, whose compose file the
# folder holds already.
take_overlay() {
  local image cid took=1
  [ ! -f "$SERVER_DIR/compose.worker.yaml" ] || return 0
  image=$(running keeper "$IMAGE")
  [ -n "$image" ] || image=$(env_value HORNHOOF_APP_REF)
  [ -n "$image" ] || image="$IMAGE:$(env_value HORNHOOF_VERSION)"
  cid=$(docker create "$image" 2> /dev/null) || return 1
  if docker cp "$cid:/app/compose.worker.yaml" "$SERVER_DIR/compose.worker.yaml.new" > /dev/null 2>&1 && mv "$SERVER_DIR/compose.worker.yaml.new" "$SERVER_DIR/compose.worker.yaml"; then took=0; fi
  docker rm "$cid" > /dev/null 2>&1 || true
  return "$took"
}

# wipe_env <server>: .env of a machine that holds the company's data no more: none of the company's secrets, no
# password of a database, no profile that starts one, and a worker's role. A machine the company was installed on
# names no compose file of a joined machine and no company to reach: it gets both lines, in the same writing, once the
# overlay is in its folder. Every other line as it was.
wipe_env() {
  local file="$SERVER_DIR/.env" join=''
  if [ -z "$(env_value COMPOSE_FILE)" ]; then
    company_address "$1" && take_overlay || return 1
    join=$1
  fi
  (umask 077 && JOIN="$join" awk '
    BEGIN { join = ENVIRON["JOIN"] }
    /^(HORNHOOF_SECRET|NODE_KEY|RELAY_URL|POSTGRES_PASSWORD)=/ { sub(/=.*/, "="); print; next }
    /^COMPOSE_PROFILES=/ { next }
    /^HORNHOOF_ROLE=/ { if (!put) print "HORNHOOF_ROLE=worker"; put = 1; next }
    join != "" && /^(COMPOSE_FILE|HORNHOOF_JOIN_SERVER)=/ { next }
    { print }
    END {
      if (!put) print "HORNHOOF_ROLE=worker"
      if (join != "") { print "COMPOSE_FILE=compose.yaml:compose.worker.yaml"; print "HORNHOOF_JOIN_SERVER=" join }
    }' "$file" > "$file.new") && as_env "$file.new"
}

# What a worker runs starts under a worker's role, with no profile on, and what is left of the services that kept the
# data goes.
wipe_up() {
  local services
  services=$(COMPOSE_PROFILES='' compose config --services 2> /dev/null | grep -v '^updater$' | tr '\n' ' ') || return 1
  [ -n "${services// /}" ] || return 1
  # shellcheck disable=SC2086 # services is a space-separated list of compose service names.
  HORNHOOF_ROLE=worker COMPOSE_PROFILES='' compose up -d --no-build --remove-orphans $services > /dev/null 2>&1
}

# wipe_step <step> <server>: one step of a wipe; WIPE_WHY says what it could not do.
WIPE_WHY=''
wipe_step() {
  local volume
  case "$1" in
    stop)
      WIPE_WHY='could not stop its database'
      # Its built-in node goes with the database: it runs on the company's key, which the wipe takes away.
      COMPOSE_PROFILES=data,builtin compose rm -sf db migrate app node > /dev/null 2>&1
      ;;
    volume)
      WIPE_WHY="could not remove the database's volume"
      volume=$(db_volume)
      [ -n "$volume" ] || return 1
      if docker volume inspect "$volume" > /dev/null 2>&1; then docker volume rm "$volume" > /dev/null 2>&1 || return 1; fi
      ;;
    files)
      WIPE_WHY='could not remove the files of its database'
      # Remove the shared trees by direct names from opened directories on the control mount.
      remove_folders dumps restore schema uploads &&
        rm -f "$SERVER_DIR"/backups/hornhoof-*.sql.gz "$SERVER_DIR"/backups/hornhoof-*.sql.gz.part "$SERVER_DIR"/backups/hornhoof-*.tunnel.json "$CONTROL/schema.json" "$CONTROL/dump.json" "$CONTROL/upload.json"
      ;;
    env)
      WIPE_WHY="could not take the company's settings out"
      wipe_env "$2" && rm -f "$CONTROL/replica.json"
      ;;
    up)
      WIPE_WHY='could not start what a worker runs'
      wipe_up
      ;;
  esac
}

# The keeper of a machine that stopped holding the company's data, once the company server has everything it held,
# asks with wipe.json {id} for all of it to go: the database with its volume, every dump and file of it, and the
# company's secrets, after which the machine is a worker like any other. Each step is written into the request before
# it runs, so a step that failed, or an updater that stopped, goes on from it at the next pass. The last step says so
# in wiped.json {id, at}, and the look at this updater's own role, which comes next, starts one as a worker's. The
# settings of a machine the company was installed on name no role: nothing is ever wiped there while it leads, and
# once it keeps a copy of another machine's, the request names with server the address of the company, https and a
# host name, which the machine then reaches as a worker; without it nothing goes.
WIPE_SAID=''
wipe_request() {
  local request="$CONTROL/wipe.json" asked id step next checked server
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  asked=$(take "$request") || return 0
  id=$(jq -r '.id // empty | tostring' <<< "$asked" 2> /dev/null || true)
  if ! plain_id "$id" || { [ -z "$(env_value HORNHOOF_ROLE)" ] && [ ! -f "$CONTROL/replica.json" ]; }; then
    rm -f "$request"
    return 0
  fi
  server=$(jq -r '.server // empty | tostring' <<< "$asked" 2> /dev/null || true)
  if [ -z "$(env_value COMPOSE_FILE)" ] && ! company_address "$server"; then
    [ "$WIPE_SAID" = address ] || say "The request to wipe this machine names no address of the company to reach afterwards, so nothing is wiped."
    WIPE_SAID=address
    return 0
  fi
  step=$(jq -r '.step // "check" | tostring' <<< "$asked" 2> /dev/null || true)
  while true; do
    case "$step" in
      stop) next=volume ;;
      volume) next=files ;;
      files) next='env' ;;
      env) next=up ;;
      up) next='done' ;;
      done) next='' ;;
      *) step=check next=stop ;;
    esac
    # shellcheck disable=SC2016 # the dollars are jq's own
    publish "$request" keeper jq -n --arg id "$id" --arg step "$step" --arg server "$server" '{id: $id, step: $step} + (if $server == "" then {} else {server: $server} end)' || return 0
    case "$step" in
      check)
        checked=0
        wipe_check || checked=$?
        if [ "$checked" = 2 ]; then
          [ "$WIPE_SAID" = led ] || say "This machine's database once led the company, so it is not wiped."
          WIPE_SAID=led
          return 0
        fi
        WIPE_WHY='could not ask its database whether it ever led'
        [ "$checked" = 0 ] || { wipe_waits check; return 0; }
        ;;
      done)
        # shellcheck disable=SC2016 # the dollars are jq's own
        publish "$CONTROL/wiped.json" keeper jq -n --arg id "$id" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id: $id, at: $at}' || return 0
        rm -f "$request"
        say "This machine holds nothing of the company's data any more."
        return 0
        ;;
      *) wipe_step "$step" "$server" || { wipe_waits "$step"; return 0; } ;;
    esac
    step=$next
  done
}

# A step of a wipe that could not be done is said once, and tried again at the next pass.
wipe_waits() {
  [ "$WIPE_SAID" = "$1" ] || say "Could not wipe this machine's copy yet: $WIPE_WHY."
  WIPE_SAID=$1
}

# An updater whose own role is not the one the settings name replaces itself, so the next one is started with it. One
# try a minute, so a swap that did not take is tried again. A server's settings name no role, and nothing happens there.
ROLE_SWAP_AT=0
match_role() {
  local want now
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] && [ ! -f "$SERVER_DIR/.env.before-data" ] || return 0
  want=$(env_value HORNHOOF_ROLE)
  [ -n "$want" ] && [ "$want" != "${ROLE:-data}" ] || return 0
  now=$(date +%s)
  [ "$now" -ge "$ROLE_SWAP_AT" ] || return 0
  ROLE_SWAP_AT=$((now + 60))
  swap_updater "$(own_image)"
}
