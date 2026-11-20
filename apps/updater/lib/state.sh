# shellcheck shell=bash
# The state of the update this updater runs, which a stop never loses: status.json in the control folder, which the app
# reads, and the updater's own note of the update in backups/update.json, where the app cannot write. Each step is
# written before it is taken, so an updater that starts again goes on from the step the one before it stopped at, and an
# updater of this build that takes over from an older one finds the update in that one's note.

# What a company server's update says of the database besides its step: how many migrations of the new build it has
# not applied, empty when that cannot be told, and whether going back puts the saved database in its place. Both stand
# in every status from the moment the update knows them.
MIGRATIONS=''
RESTORE=''
SAYS_MIGRATIONS=''

ID=''
VERSION=''
STATE=''
STEP=''
LOG=''
WORK=''
# The update being run: its tag, the digests of its app, node and updater images, empty for one it takes by the tag,
# the build to go back to and the images it ran, the commit the new server answers with, how many migrations the
# database had before, the copy of it, and the revision of the updater that wrote the note, empty for an older one.
TAG=''
DIGEST=''
NODE_DIGEST=''
UPDATER_DIGEST=''
PREVIOUS=''
BACK_APP=''
BACK_NODE=''
BACK_UPDATER=''
TARGET=''
BEFORE=''
BACKUP=''
NOTE_REV=''
# Set for an installer that may stop the nodes now, with the ones it may stop when the server named them.
NODES_FREE=''
NODES_ONLY=''

say() {
  printf '%s\n' "$*"
  LOG="$LOG$*
"
}

# Written whole and then moved, so the app never reads half a file.
write_status() {
  STATE=$1
  STEP=$2
  publish "$CONTROL/status.json" over status_json || {
    printf '%s\n' 'Could not write status.json in the control folder.' >&2
    return 1
  }
}

status_json() {
  jq -n --arg id "$ID" --arg version "$VERSION" --arg state "$STATE" --arg step "$STEP" \
    --arg log "$(printf '%s' "$LOG" | tail -n 40)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg says "$SAYS_MIGRATIONS" --arg migrations "$MIGRATIONS" --arg restore "$RESTORE" \
    '{id: $id, version: $version, state: $state, step: $step, log: $log, at: $at}
      + (if $says == "" then {} else {migrations: (if $migrations == "" then null else ($migrations | tonumber) end), restore: ($restore == "1")} end)'
}

step() {
  say "$2"
  write_status running "$1"
}

# The update ends, and the note about it goes.
stop_with() {
  say "$2"
  write_status "$1" "${3:-$STEP}"
  forget
}

# The updater's own note of the update it runs, so an updater that was stopped can go on with it. It lies next to
# the backups, where the app cannot write.
note() {
  mkdir -p "$SERVER_DIR/backups"
  (umask 077 && jq -n --arg id "$ID" --arg version "$VERSION" --arg tag "$TAG" --arg digest "$DIGEST" --arg node "$NODE_DIGEST" \
    --arg updater "$UPDATER_DIGEST" --arg previous "$PREVIOUS" --arg back_app "$BACK_APP" --arg back_node "$BACK_NODE" \
    --arg back_updater "$BACK_UPDATER" --arg target "$TARGET" --arg before "$BEFORE" --arg backup "$BACKUP" --arg nodes_free "$NODES_FREE" --arg rev "$UPDATER_REV" \
    --arg path "$PATH_KIND" --arg shape "$SHAPE" \
    '{id: $id, version: $version, tag: $tag, digest: $digest, node: $node, updater: $updater, previous: $previous,
      back: {app: $back_app, node: $back_node, updater: $back_updater}, target: $target, before: $before, backup: $backup, nodes_free: $nodes_free, rev: $rev,
      path: $path, shape: $shape}' \
    > "$SERVER_DIR/backups/update.json.new")
  mv "$SERVER_DIR/backups/update.json.new" "$SERVER_DIR/backups/update.json"
}

# Reads the note of the update with this ID; fails when there is none.
recall() {
  local file="$SERVER_DIR/backups/update.json"
  [ -n "$SERVER_DIR" ] && [ -f "$file" ] && [ "$(jq -r '.id // empty' "$file" 2> /dev/null || true)" = "$ID" ] || return 1
  VERSION=$(jq -r '.version' "$file")
  TAG=$(jq -r '.tag' "$file")
  DIGEST=$(jq -r '.digest' "$file")
  NODE_DIGEST=$(jq -r '.node' "$file")
  UPDATER_DIGEST=$(jq -r '.updater' "$file")
  PREVIOUS=$(jq -r '.previous' "$file")
  BACK_APP=$(jq -r '.back.app' "$file")
  BACK_NODE=$(jq -r '.back.node' "$file")
  BACK_UPDATER=$(jq -r '.back.updater' "$file")
  TARGET=$(jq -r '.target' "$file")
  BEFORE=$(jq -r '.before' "$file")
  BACKUP=$(jq -r '.backup' "$file")
  NODES_FREE=$(jq -r '.nodes_free // empty' "$file")
  NOTE_REV=$(jq -r '.rev // empty' "$file")
  # What the machine was when the update began; a note from before this was written names neither, and then it is
  # what the machine is now.
  PATH_KIND=$(jq -r '.path // empty' "$file")
  SHAPE=$(jq -r '.shape // empty' "$file")
  case "$PATH_KIND:$SHAPE" in lead:server | lead:worker | copy:server | copy:worker | worker:worker) ;; *) read_kind ;; esac
  plain_tag "$TAG" && plain_digest "$DIGEST" && digest_or_none "$NODE_DIGEST" && digest_or_none "$UPDATER_DIGEST" && plain_tag "$PREVIOUS" || return 1
  own "$IMAGE" "$BACK_APP" && own "$NODE_IMAGE" "$BACK_NODE" && own "$UPDATER_IMAGE" "$BACK_UPDATER" || return 1
  case "$BACKUP" in '' | "$SERVER_DIR"/backups/hornhoof-*.sql.gz) ;; *) return 1 ;; esac
}

forget() { if [ -n "$SERVER_DIR" ]; then rm -f "$SERVER_DIR/backups/update.json"; fi; }

# A machine that joined the company: a worker, or one that keeps a copy of its data, which its keeper marks with
# replica.json. Either follows the company server's build as a worker does: it saves no database and runs no migration
# of its own, since a copy's schema is the company server's, and it installs when the server gives it its turn. A
# machine whose settings say worker is one whatever this updater was started as: it was wiped of the data it kept.
worker() { [ "$(path_kind)" != lead ]; }

# What this machine is now, in two words. Its path picks the steps of an update: worker by the role its settings name,
# or this updater's own where they name none; copy with replica.json; else lead, the machine whose database the company
# writes. Its shape picks the installer and its files: worker on a machine that joined, whose settings name the
# worker's compose file, and on any worker; server on a machine the company was installed on. A copy can be of either
# shape, and so can the machine that leads, since the CEO moves the server between them. Both words are read at the
# start of each update and stand until it ends, so a machine that changes in the middle ends the update as it began it.
PATH_KIND=''
SHAPE=''
path_kind() {
  local role
  if [ -n "$PATH_KIND" ]; then
    printf '%s' "$PATH_KIND"
    return 0
  fi
  role=$(env_value HORNHOOF_ROLE)
  if [ "${role:-$ROLE}" = worker ]; then
    printf worker
  elif [ -f "$CONTROL/replica.json" ]; then
    printf copy
  else
    printf lead
  fi
}
shape() {
  if [ -n "$SHAPE" ]; then
    printf '%s' "$SHAPE"
  elif [ "$(path_kind)" = worker ] || [ -n "$(env_value COMPOSE_FILE)" ]; then
    printf worker
  else
    printf server
  fi
}
joined() { [ "$(shape)" = worker ]; }
read_kind() {
  PATH_KIND=''
  SHAPE=''
  PATH_KIND=$(path_kind)
  SHAPE=$(shape)
}
forget_kind() {
  PATH_KIND=''
  SHAPE=''
}

# The service whose container is the build that runs here: the app on a server, the keeper on a worker, which has no app.
main_service() { if worker; then printf keeper; else printf app; fi; }

update_running() { [ "$(take "$CONTROL/status.json" quiet jq -r '.state // empty' || true)" = running ]; }

# The update under way, as status.json says it.
read_status() {
  local status
  status=$(take "$CONTROL/status.json" || true)
  ID=$(jq -r '.id // empty' <<< "$status" | tr -cd 'A-Za-z0-9-')
  VERSION=$(jq -r '.version // empty' <<< "$status" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  STEP=$(jq -r '.step // empty' <<< "$status")
  LOG="$(jq -r '.log // empty' <<< "$status")
"
  # What it said of the database, when it had said anything: an update of an updater from before says nothing.
  SAYS_MIGRATIONS=$(jq -r 'if has("migrations") then "1" else "" end' <<< "$status" 2> /dev/null || true)
  MIGRATIONS=$(jq -r '.migrations // empty | tostring' <<< "$status" 2> /dev/null | tr -cd '0-9' || true)
  RESTORE=$(jq -r 'if .restore == true then "1" else "" end' <<< "$status" 2> /dev/null || true)
}
