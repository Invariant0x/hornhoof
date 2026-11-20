# shellcheck shell=bash
# The copies of the database. An update of the company server saves one in backups/ before it installs, and puts it back
# when going back needs it. The keeper's backups are made of dumps too: the keeper asks for a dump of the database with
# dump.json {id} and seals what it finds in dumps/, which holds every dump in the clear for a day at most.
#
# Deleting a copy cannot be undone, so the copies of updates go only as keep_backups says: once an update ended on a
# database that works, and never the one that update may go back to. The newest settings of the public link kept beside
# a copy never go.

# How many copies of the database updates saved stay in backups/, the one of the update under way among them.
KEEP_BACKUPS=3

# The app stops first, so every change it confirmed is in the copy. A copy that fails leaves it running again. It is
# written as .part and takes its name once whole, so a copy a stop cut short never counts as one; what such a copy left
# goes with the next, as one update runs at a time.
backup() {
  local db app file
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  mkdir -p "$SERVER_DIR/backups"
  rm -f "$SERVER_DIR"/backups/hornhoof-*.sql.gz.part
  file="$SERVER_DIR/backups/hornhoof-$(date -u +%Y%m%dT%H%M%SZ)-$ID.sql.gz"
  app=$(compose ps -q app 2> /dev/null || true)
  compose stop app > /dev/null 2>&1 || true
  { (umask 077 && docker exec "$db" pg_dump -U hornhoof -d hornhoof | gzip > "$file.part") && mv "$file.part" "$file"; } || {
    rm -f "$file.part"
    start_app "$app"
    return 1
  }
  BACKUP=$file
  say "Saved the database to backups/$(basename "$file")."
  hand_backup || {
    drop_dump "$ID"
    say "Could not hand the database copy to the keeper for a backup."
  }
}

# The copies of the database updates saved in backups/, and when one goes. Deleting a copy cannot be undone, so only an
# update that ended on a database a build runs on deletes any: the new build answered, or the build from before did, on
# the database as it was or on the copy put back. It keeps KEEP_BACKUPS of them: its own, whatever time the clock gave
# the others, and the newest of the others. An update that ended any other way deletes none, since the copy it made may
# not load and an older one may then be the only one that does; neither does one that made no copy, as on a worker. The
# public link's settings kept with a copy go with it, but for the newest of them, which stay for good: a link the company
# took on a build that went back may be in no other place.
keep_backups() {
  local kept=0 old link
  [ -n "$BACKUP" ] || return 0
  [ ! -f "$BACKUP" ] || kept=1
  # shellcheck disable=SC2012 # the names are ours: hornhoof-<stamp>-<id>.tunnel.json
  link=$(ls -1t "$SERVER_DIR"/backups/hornhoof-*.tunnel.json 2> /dev/null | head -n 1) || true
  # shellcheck disable=SC2012 # the names are ours: hornhoof-<stamp>-<id>.sql.gz
  { ls -1t "$SERVER_DIR"/backups/hornhoof-*.sql.gz 2> /dev/null || true; } | while read -r old; do
    [ "$old" != "$BACKUP" ] || continue
    if [ "$kept" -lt "$KEEP_BACKUPS" ]; then
      kept=$((kept + 1))
    else
      rm -f "$old" || true
      [ "${old%.sql.gz}.tunnel.json" = "$link" ] || rm -f "${old%.sql.gz}.tunnel.json" || true
    fi
  done
}

# The folder the keeper takes dumps of the database from, and seals each into a backup: <id>.sql.gz, and <id>.json
# {id, reason, at, migrations}, or <id>.failed with a line.
dumps_dir() { keeper_dir "$CONTROL/dumps"; }

# dump_said <id> <reason> <migrations>: written after the dump, so it says the dump is whole.
dump_said() {
  case "$3" in '' | *[!0-9]*) return 1 ;; esac
  # shellcheck disable=SC2016 # the dollars are jq's own
  publish "$CONTROL/dumps/$1.json" keeper jq -n --arg id "$1" --arg reason "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson migrations "$3" \
    '{id: $id, reason: $reason, at: $at, migrations: $migrations}'
}

# drop_dump <id>: whatever a dump that was not finished left, and what an updater of an older build left of one.
drop_dump() { remove_in "$CONTROL/dumps" "$1.sql.gz.part" "$1.sql.gz" "$1.json.new" "$1.json"; }

# pg_dump_gz <db container> <database>: that database, dumped and packed, on the standard output.
pg_dump_gz() {
  docker exec "$1" pg_dump -U hornhoof -d "$2" | gzip
}

# The copy taken before an update goes to the keeper too, under the update's id.
hand_backup() {
  dumps_dir && publish "$CONTROL/dumps/$ID.sql.gz" keeper cat -- "$BACKUP" && dump_said "$ID" update "$BEFORE"
}

# make_dump <id> <db container>: the database as it is now, for the keeper.
make_dump() {
  local n
  dumps_dir && n=$(migrations) || return 1
  publish "$CONTROL/dumps/$1.sql.gz" keeper pg_dump_gz "$2" hornhoof && dump_said "$1" timer "$n"
}

# kept_name <name>: the name of a database a restore set aside, and of no other. Only such a name ever goes into a
# statement, and between quotes, as the database server folds the letters of a name without them.
kept_name() {
  case "$1" in hornhoof_before_*) ;; *) return 1 ;; esac
  local rest=${1#hornhoof_before_}
  case "$rest" in '' | *[!A-Za-z0-9_]*) return 1 ;; esac
  [ "${#rest}" -le 47 ]
}

# make_fork_dump <id> <db container> <database>: a database a restore set aside, before it goes. A restore leaves its
# connections off, so they are turned on first.
make_fork_dump() {
  local n
  dumps_dir || return 1
  docker exec "$2" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE \"$3\" WITH ALLOW_CONNECTIONS true" > /dev/null 2>&1 || return 1
  n=$(docker exec "$2" psql -U hornhoof -d "$3" -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null | tr -d ' ') || return 1
  publish "$CONTROL/dumps/$1.sql.gz" keeper pg_dump_gz "$2" "$3" && dump_said "$1" fork "$n"
}

# dump_failed <id> [line]: nothing of the dump stays, and the keeper reads why.
dump_failed() {
  drop_dump "$1"
  dumps_dir && publish "$CONTROL/dumps/$1.failed" keeper printf '%s\n' "${2:-The database could not be dumped.}"
}

# The data keeper asks for a dump with dump.json {id}, or with {id, database, reason: "fork"} for a database a restore
# set aside or one made of what a machine uploaded. The keeper of a machine that keeps a copy asks with
# {id, database: "hornhoof", reason: "fork"} for its own database, when that one led the company before. The request goes once the dump is there, whole or failed; a dump that is there is not made again, so the
# keeper asks anew under another id.
dump_request() {
  local asked id db database reason copy=''
  [ -n "$SERVER_DIR" ] || return 0
  # A machine that keeps a copy gives one dump alone: its own database, from the time it led, which its keeper saves
  # before the copy is made again. A machine with no database gives none.
  if worker; then
    [ -f "$CONTROL/replica.json" ] || return 0
    copy=1
  fi
  asked=$(take "$CONTROL/dump.json") || return 0
  id=$(jq -r '.id // empty' <<< "$asked" 2> /dev/null || true)
  plain_id "$id" || return 0
  database=$(jq -r '.database // empty' <<< "$asked" 2> /dev/null || true)
  reason=$(jq -r '.reason // empty' <<< "$asked" 2> /dev/null || true)
  if [ ! -f "$CONTROL/dumps/$id.json" ] && [ ! -f "$CONTROL/dumps/$id.failed" ]; then
    db=$(compose ps -q db 2> /dev/null || true)
    [ -n "$db" ] || return 0
    # The request goes also when not even the failure could be written, as on a full disk: the keeper asks anew in its
    # own time, and no pass dumps the database again by itself.
    if [ -n "$copy" ]; then
      if [ "$database" = hornhoof ] && [ "$reason" = fork ]; then
        make_fork_dump "$id" "$db" hornhoof || dump_failed "$id" || drop_dump "$id"
      else
        dump_failed "$id" 'Not a kept database.' || drop_dump "$id"
      fi
    elif [ -z "$database" ] && [ -z "$reason" ]; then
      make_dump "$id" "$db" || dump_failed "$id" || drop_dump "$id"
    elif [ "$reason" = fork ] && { kept_name "$database" || upload_name "$database"; }; then
      make_fork_dump "$id" "$db" "$database" || dump_failed "$id" || drop_dump "$id"
    else
      dump_failed "$id" 'Not a kept database.' || drop_dump "$id"
    fi
  fi
  rm -f "$CONTROL/dump.json"
}

# A dump in the clear is never left for long. The keeper seals and removes each, and removes what it did not seal
# within a day; this does the same for a machine whose keeper makes no backups, or does not run. Only the files of dumps
# itself go, by their names there: a folder in it, which the app can swap for a link at any moment, is never gone into.
sweep_dumps() (
  [ -d "$CONTROL/dumps" ] || exit 0
  entered "$CONTROL/dumps" || exit 0
  if [ -n "$(find . -maxdepth 1 -type f -mmin +1440 2> /dev/null | head -n 1)" ]; then
    find . -maxdepth 1 -type f -mmin +1440 -exec rm -f {} + 2> /dev/null || true
    printf 'Deleted a database dump that was not sealed within a day.\n'
  fi
)

# The public link's settings as they are now, next to the database copy, readable by the owner only. A link the
# company took on the new build is not in that copy, while its name stays taken at hornhoof.org and its key is only
# here.
keep_link() {
  local file="${BACKUP%.sql.gz}.tunnel.json"
  [ -n "$BACKUP" ] || return 0
  [ -L "$CONTROL/tunnel.json" ] || [ -e "$CONTROL/tunnel.json" ] || return 0
  if (umask 077 && take "$CONTROL/tunnel.json" > "$file.new" && chmod 600 "$file.new" && mv "$file.new" "$file"); then
    say "The public link's settings are in backups/$(basename "$file"). A link taken after the database was saved is not in it; guide/updates.md says how to take it back."
  else
    rm -f "$file.new"
    say "Could not keep a copy of the public link's settings."
  fi
}

# The database goes back to the copy saved before the update. The copy goes into a database of its own first and only
# then takes the place of the one there, so a failed load changes nothing. The app stops before, so nothing writes
# meanwhile; the installer of the build that goes back starts it again.
restore() {
  local db
  [ -n "$BACKUP" ] && [ -f "$BACKUP" ] || return 1
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  compose stop app > /dev/null 2>&1 || true
  load_copy "$db" "$BACKUP" || return 1
  docker exec "$db" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS hornhoof WITH (FORCE)' -c 'ALTER DATABASE hornhoof_restore RENAME TO hornhoof' > /dev/null || return 1
}

# load_copy <db container> <file>: a copy of the database goes into one of its own, hornhoof_restore, made anew.
load_copy() {
  docker exec "$1" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS hornhoof_restore' -c 'CREATE DATABASE hornhoof_restore OWNER hornhoof TEMPLATE template0' > /dev/null || return 1
  gzip -dc "$2" | docker exec -i "$1" psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q > /dev/null || return 1
}
