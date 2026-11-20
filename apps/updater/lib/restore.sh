# shellcheck shell=bash
# A backup the keeper puts back, on the machine that keeps the company's data. To restore a backup the keeper writes
# restore.json {attempt, id, dumpedAt, carry} once restore/<attempt>.sql.gz and restore/<attempt>.env.json are whole. This
# loads the dump into a database of its own, closes the one in use, renames it to hornhoof_before_<stamp> and the loaded
# one into its place, writes the backup's three settings into .env, and starts the company; each step goes to
# restore-status.json. It notes every change in restore-journal.json, with the number the database server knows the old
# database by, so whatever stops it, the next start puts everything back as it was, or goes on when the swap was done.
# The old database is never removed here.

# The restore being run: its attempt, the backup's id and time, the stamp its copies go by, the number the database
# server gives the database that was in use, why a swap failed, and what was said once already.
R_ATTEMPT=''
R_ID=''
R_DUMPED=''
R_STAMP=''
R_OLD=''
SWAP_LINE=''
JOURNAL_SAID=''
BACK_SAID=''

# The stamp a restore's copies go by, as this wrote it: digits and a line, so the name of a database made of it is
# the same however the database server folds letters.
plain_stamp() {
  case "$1" in '' | *[!0-9_]*) return 1 ;; esac
  [ "${#1}" -eq 15 ]
}

# The number of the database named hornhoof now. A database keeps its number under every name, so the one that was in
# use is told by it for good.
number_in_use() { psql_on postgres -tAc "SELECT oid FROM pg_database WHERE datname = 'hornhoof'" 2> /dev/null; }

# restore_says <state> <step> <line> [kept]: restore-status.json, written whole and then moved. dumpedAt: from when the
# restored database is, as the order has it; the app marks the restore by it once the order is gone.
restore_says() {
  printf '%s\n' "$3"
  # shellcheck disable=SC2016 # the dollars are jq's own
  publish "$CONTROL/restore-status.json" over jq -n --arg attempt "$R_ATTEMPT" --arg id "$R_ID" --arg state "$1" --arg step "$2" --arg line "$3" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg kept "${4:-}" --arg dumped "$R_DUMPED" \
    '{attempt: $attempt, id: $id, state: $state, step: $step, line: $line, at: $at, kept: (if $kept == "" then null else $kept end)} + (if $dumped == "" then {} else {dumpedAt: $dumped} end)' || {
    printf '%s\n' 'Could not write restore-status.json in the control folder.' >&2
    return 1
  }
}

# restore_ended <state> <step> <line> [kept]: the last word of a restore; its order and its journal go.
restore_ended() {
  restore_says "$@" || return 0
  rm -f "$CONTROL/restore-journal.json" "$CONTROL/restore.json"
}

# journal <change>: the last change a restore made, written whole and then moved, so a start after any stop knows what
# to put back.
journal() {
  # shellcheck disable=SC2016 # the dollars are jq's own
  publish "$CONTROL/restore-journal.json" over jq -n --arg attempt "$R_ATTEMPT" --arg id "$R_ID" --arg dumped "$R_DUMPED" --arg stamp "$R_STAMP" --arg old "$R_OLD" --arg did "$1" \
    '{attempt: $attempt, id: $id, dumpedAt: $dumped, stamp: $stamp, old: $old, did: $did}'
}

# The dump and the settings a restore was given in the clear go in every outcome.
restore_wipe() { remove_in "$CONTROL/restore" "$R_ATTEMPT.sql.gz" "$R_ATTEMPT.env.json"; }

# The app and the node stop, so nothing writes while the databases change places.
restore_stop() {
  local s list=''
  for s in app node; do
    if names_service "$SERVER_DIR/compose.yaml" "$s"; then list="$list $s"; fi
  done
  # shellcheck disable=SC2086 # the names of services, a word each
  [ -z "$list" ] || compose stop $list > /dev/null 2>&1 || true
}

# Every service of the build that runs starts, but the database and this updater: with .env as it is now, so one whose
# settings changed starts anew.
restore_up() {
  local s list=''
  for s in $(services_of "$SERVER_DIR/compose.yaml"); do
    case "$s" in db | updater) ;; *) list="$list $s" ;; esac
  done
  [ -n "$list" ] || return 1
  # shellcheck disable=SC2086 # the names of services, a word each
  compose up -d --no-build $list > /dev/null 2>&1
}

# The commit the build that runs here was made from; empty for a build made by hand.
running_commit() {
  docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(compose ps -aq "$(main_service)" 2> /dev/null || true)" 2> /dev/null || true
}

# A stamp no copy goes by yet, so two restores never meet in one name.
restore_stamp() {
  local names
  while true; do
    R_STAMP=$(date -u +%Y%m%d_%H%M%S)
    names=$(db_names) || return 1
    case " $names " in
      *" hornhoof_before_$R_STAMP "*) ;;
      *) [ -e "$SERVER_DIR/backups/env-before-$R_STAMP" ] || return 0 ;;
    esac
    sleep 1
  done
}

# cutover <with carry> <out>: the database in use closes. One session stays on it, turns nothing off itself, since
# Postgres lets no session close the database it is on, and reads what the restored one must keep once every other
# session is gone (cutover.sql, and carry.sql for who may get in now). The connections go off from another session, as
# soon as that one is seen on the database. Its answers go to <out>, a line each.
cutover() {
  local reader seen looks=0
  {
    cat "$SQL_DIR/cutover.sql"
    if [ -n "$1" ]; then cat "$SQL_DIR/carry.sql"; fi
  } | docker exec -i -e PGAPPNAME=hornhoof-cutover "$DBC" psql -U hornhoof -d hornhoof -v ON_ERROR_STOP=1 -qAt > "$2" 2> /dev/null &
  reader=$!
  while kill -0 "$reader" 2> /dev/null && [ "$looks" -lt 60 ]; do
    seen=$(psql_on postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'hornhoof' AND application_name = 'hornhoof-cutover'" 2> /dev/null || true)
    if [ "${seen:-0}" != 0 ]; then
      psql_alone postgres -c 'ALTER DATABASE hornhoof WITH ALLOW_CONNECTIONS false' > /dev/null 2>&1 || true
      break
    fi
    looks=$((looks + 1))
    sleep 1
  done
  wait "$reader"
}

# keep_carry <out>: who may get in now, for the keeper to put into the restored database, and for it alone to read.
keep_carry() {
  publish "$CONTROL/restore-carry.json" keeper carry_of "$1"
}

carry_of() {
  sed -n 2p "$1" | jq -ce --arg attempt "$R_ATTEMPT" 'select(type == "object") | {attempt: $attempt, carry: .}'
}

# adopt <term> <machine> <cluster>: the loaded database goes by what the closed one went by (adopt.sql), committed
# here alone as psql_alone's statements are.
adopt() {
  {
    printf '%s\n' 'SET synchronous_commit = local;'
    printf '%s\n' "SELECT set_config('hornhoof.term', :'term', false), set_config('hornhoof.machine', :'machine', false), set_config('hornhoof.cluster', :'cluster', false);"
    cat "$SQL_DIR/adopt.sql"
  } | docker exec -i "$DBC" psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q -v term="$1" -v machine="$2" -v cluster="$3" > /dev/null 2>&1
}

# restore_swap <with carry>: the loaded database takes the place of the one in use, which is kept as
# hornhoof_before_<stamp> with its connections off, and the backup's settings go into .env. SWAP_LINE says why it
# failed.
restore_swap() {
  local env="$WORK/env.json" out="$WORK/cutover.out" secret node_key relay term machine cluster
  SWAP_LINE="The backup's settings cannot be written, so nothing changed."
  # The backup's settings, as restore_hold took them into the updater's own folder.
  secret=$(setting HORNHOOF_SECRET "$env") && node_key=$(setting NODE_KEY "$env") && relay=$(setting RELAY_URL "$env") || return 1
  SWAP_LINE='The databases could not change places, so nothing changed.'
  restore_stamp || return 1
  R_OLD=$(number_in_use) && plain_number "$R_OLD" || return 1
  mkdir -p "$SERVER_DIR/backups" && (umask 077 && cp "$SERVER_DIR/.env" "$SERVER_DIR/backups/env-before-$R_STAMP") || return 1
  journal saved || return 1
  SWAP_LINE='The database in use could not be closed, so nothing changed.'
  cutover "$1" "$out" || return 1
  journal closed || return 1
  SWAP_LINE='The databases could not change places, so nothing changed.'
  term=$(sed -n 1p "$out" | jq -r '.term | select(type == "number") | floor' 2> /dev/null || true)
  case "$term" in '' | *[!0-9]*) return 1 ;; esac
  machine=$(sed -n 1p "$out" | jq -r '.machine // empty')
  cluster=$(sed -n 1p "$out" | jq -r '.cluster // empty')
  if [ -n "$1" ]; then keep_carry "$out" || return 1; fi
  adopt "$term" "$machine" "$cluster" || return 1
  psql_alone postgres -c "ALTER DATABASE hornhoof RENAME TO hornhoof_before_$R_STAMP" > /dev/null 2>&1 || return 1
  journal old_renamed || return 1
  psql_alone postgres -c 'ALTER DATABASE hornhoof_restore RENAME TO hornhoof' > /dev/null 2>&1 || return 1
  journal new_renamed || return 1
  write_env "$secret" "$node_key" "$relay" || return 1
  rm -f "$env"
  remove_in "$CONTROL/restore" "$R_ATTEMPT.env.json"
  journal committed
}

# Everything a restore changed goes back, from wherever it got to: it looks at what is there, so it may run again from
# its start. The database that was in use is told by its number, never by a name. While it goes by another name, the
# one named hornhoof is the restored one, which is dropped, and it takes its name back; while it cannot be found,
# nothing is dropped at all.
restore_back() {
  local names name kept="$SERVER_DIR/backups/env-before-$R_STAMP"
  if [ -n "$R_OLD" ]; then
    name=$(psql_on postgres -tAc "SELECT datname FROM pg_database WHERE oid = $R_OLD" 2> /dev/null) || return 1
    case "$name" in
      hornhoof) ;;
      hornhoof_before_*)
        case "$name" in *[!a-z0-9_]*) return 1 ;; esac
        names=$(db_names) || return 1
        case " $names " in
          *' hornhoof '*)
            restore_stop
            psql_alone postgres -c 'DROP DATABASE hornhoof WITH (FORCE)' > /dev/null 2>&1 || return 1
            ;;
        esac
        psql_alone postgres -c "ALTER DATABASE $name RENAME TO hornhoof" > /dev/null 2>&1 || return 1
        ;;
      *) return 1 ;;
    esac
  fi
  psql_alone postgres -c 'ALTER DATABASE hornhoof WITH ALLOW_CONNECTIONS true' -c 'DROP DATABASE IF EXISTS hornhoof_restore WITH (FORCE)' > /dev/null 2>&1 || return 1
  # Settings that were not written whole go, with the backup's values in them.
  rm -f "$SERVER_DIR/.env.new"
  if [ -n "$R_STAMP" ] && [ -f "$kept" ]; then
    (umask 077 && cp "$kept" "$SERVER_DIR/.env.new") && as_env "$SERVER_DIR/.env.new" && rm -f "$kept" || return 1
  fi
}

# restore_undo <line> <step>: the restore ends failed, with everything as it was and the company started again. A way
# back that fails itself leaves the journal and the status, and is tried again.
restore_undo() {
  if ! restore_back; then
    [ -n "$BACK_SAID" ] || printf 'Could not put the database back as it was yet. The updater tries again.\n'
    BACK_SAID=1
    return 0
  fi
  BACK_SAID=''
  restore_wipe
  # What was carried over is for the restored database alone: it goes before the company starts on the old one, whose
  # app would else take it for its own.
  rm -f "$CONTROL/restore-carry.json" "$CONTROL/restore-carry.json.new"
  restore_up || true
  restore_ended failed "$2" "$1"
}

# The swap is done, which the step start says: the company starts on the restored database and has to answer, as after
# an update; otherwise everything goes back.
restore_start() {
  local kept="hornhoof_before_$R_STAMP"
  restore_says running start 'Starting the company on the restored database.'
  rm -f "$CONTROL/recovery-link.json"
  restore_up || true
  if healthy "$(running_commit)"; then
    restore_wipe
    restore_ended 'done' start "Restored the backup of $R_DUMPED. The database from before is kept on this machine as $kept." "$kept"
    return 0
  fi
  restore_undo 'The restored company did not start, so it is back as it was.' start
}

# A restore this updater was stopped in, or could not put back: by its journal it goes on when the swap was done, and
# back otherwise; one stopped before its journal began only loaded a copy. Fails when there is none.
restore_left() {
  local file="$CONTROL/restore-journal.json" status="$CONTROL/restore-status.json" said did step
  if [ -L "$file" ] || [ -e "$file" ]; then
    said=$(take "$file" || true)
    R_ATTEMPT=$(jq -r '.attempt // empty' <<< "$said" 2> /dev/null || true)
    R_ID=$(jq -r '.id // empty' <<< "$said" 2> /dev/null || true)
    R_DUMPED=$(jq -r '.dumpedAt // empty' <<< "$said" 2> /dev/null | tr -cd '0-9A-Za-z:.+-' | cut -c1-40 || true)
    R_STAMP=$(jq -r '.stamp // empty' <<< "$said" 2> /dev/null || true)
    R_OLD=$(jq -r '.old // empty' <<< "$said" 2> /dev/null || true)
    did=$(jq -r '.did // empty' <<< "$said" 2> /dev/null || true)
    if ! plain_id "$R_ATTEMPT" || ! plain_id "$R_ID" || ! plain_stamp "$R_STAMP" || ! plain_number "$R_OLD"; then
      [ -n "$JOURNAL_SAID" ] || printf 'restore-journal.json cannot be read, so the restore it is of stays as it is.\n'
      JOURNAL_SAID=1
      return 0
    fi
  else
    said=$(take "$status" || true)
    [ "$(jq -r '.state // empty' <<< "$said" 2> /dev/null || true)" = running ] || return 1
    step=$(jq -r '.step // empty' <<< "$said" 2> /dev/null || true)
    case "$step" in load | swap) ;; *) return 1 ;; esac
    R_ATTEMPT=$(jq -r '.attempt // empty' <<< "$said" 2> /dev/null || true)
    R_ID=$(jq -r '.id // empty' <<< "$said" 2> /dev/null || true)
    plain_id "$R_ATTEMPT" && plain_id "$R_ID" || return 1
    R_STAMP=''
    R_OLD=''
    did=''
  fi
  DBC=$(compose ps -q db 2> /dev/null || true)
  [ -n "$DBC" ] || return 0
  if [ "$did" = committed ]; then
    restore_start
  else
    restore_undo 'The updater stopped during the restore, so nothing changed.' "${step:-swap}"
  fi
}

# restore_hold: the dump and the settings are taken from the keeper's folder into the updater's own while the company
# still runs: each a plain file of the keeper's, alone at its name, so neither a link, a pipe, a second name nor a file
# put at the name later changes what is restored, and none stops the company for nothing. HOLD_LINE says which was not.
restore_hold() {
  HOLD_LINE='The backup cannot be read, so nothing changed.'
  (umask 077 && take_alone "$CONTROL/restore/$R_ATTEMPT.sql.gz" > "$WORK/restore.sql.gz") || return 1
  HOLD_LINE="The backup's settings cannot be read, so nothing changed."
  (umask 077 && take_alone "$CONTROL/restore/$R_ATTEMPT.env.json" > "$WORK/env.json")
}

# restore_run <with carry>: hold, load, swap, start.
restore_run() {
  local status=0
  restore_says running load 'Loading the backup.'
  if ! restore_hold; then
    restore_wipe
    restore_ended failed load "$HOLD_LINE"
    return 0
  fi
  restore_stop
  # The copy of the dump goes as soon as it is loaded, or could not be: it is kept through no later step.
  load_copy "$DBC" "$WORK/restore.sql.gz" || status=$?
  # While the company is down, both removal and reporting its failure must leave the load result in charge.
  rm -f -- "$WORK/restore.sql.gz" || say "Could not remove the updater's copy of the backup yet; it goes with its folder." || true
  if [ "$status" -ne 0 ]; then
    restore_undo 'The backup did not load, so nothing changed.' load
    return 0
  fi
  remove_in "$CONTROL/restore" "$R_ATTEMPT.sql.gz"
  restore_says running swap 'Putting the restored database in the place of the one in use.'
  if ! restore_swap "$1"; then
    restore_undo "$SWAP_LINE" swap
    return 0
  fi
  restore_start
}

# The keeper orders a restore with restore.json, once both files of restore/<attempt> are whole. An order runs once:
# the same backup is tried again under a new attempt. It waits for an update that waits or runs.
restore_request() {
  local file="$CONTROL/restore.json" status="$CONTROL/restore-status.json" order said carry waiting name
  if worker || [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/.env" ]; then return 0; fi
  if restore_left; then return 0; fi
  order=$(take "$file") || return 0
  waiting=$(take "$CONTROL/request.json" quiet jq -r '.id // empty' || true)
  if plain_id "$waiting" && [ "$waiting" != "$(take "$CONTROL/status.json" quiet jq -r '.id // empty' || true)" ]; then return 0; fi
  if update_running; then return 0; fi
  R_ATTEMPT=$(jq -r '.attempt // empty' <<< "$order" 2> /dev/null || true)
  R_ID=$(jq -r '.id // empty' <<< "$order" 2> /dev/null || true)
  plain_id "$R_ATTEMPT" && plain_id "$R_ID" || return 0
  said=$(take "$status" || true)
  if [ "$(jq -r '.attempt // empty' <<< "$said" 2> /dev/null || true)" = "$R_ATTEMPT" ]; then
    case "$(jq -r '.state // empty' <<< "$said" 2> /dev/null || true)" in
      'done' | failed)
        rm -f "$file"
        return 0
        ;;
    esac
  fi
  # Whatever stands at both names, a link or a pipe too, goes on to restore_hold: it takes only a plain file, and says so.
  for name in "$R_ATTEMPT.sql.gz" "$R_ATTEMPT.env.json"; do
    [ -L "$CONTROL/restore/$name" ] || [ -e "$CONTROL/restore/$name" ] || return 0
  done
  R_DUMPED=$(jq -r '.dumpedAt // empty' <<< "$order" 2> /dev/null | tr -cd '0-9A-Za-z:.+-' | cut -c1-40 || true)
  carry=$(jq -r 'if .carry == true then "1" else "" end' <<< "$order" 2> /dev/null || true)
  R_STAMP=''
  R_OLD=''
  DBC=$(compose ps -q db 2> /dev/null || true)
  [ -n "$DBC" ] || return 0
  WORK=$(mktemp -d)
  restore_run "$carry"
  # The restore has ended, done or undone, either way: a folder of the updater's own that will not go stops nothing.
  rm -rf -- "${WORK:?}" || say "Could not remove the updater's copy of the backup, in $WORK." || true
  WORK=''
}
