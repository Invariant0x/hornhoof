#!/usr/bin/env bash
# Hornhoof updater: swaps this server's images when someone updates from the web app.
#
#   updater.sh          watch the control folder for update requests
#   updater.sh --once   handle the waiting request, if any, then exit
#
# The app writes request.json {id, version, tag} into the control folder; this writes status.json {id, version,
# state, step, log, at} and touches alive. An update saves the database, downloads the build, runs that build's own
# installer, and waits for the new server to answer with the build's commit. If it does not, the build that ran
# before goes back, and the database goes back to the saved copy first when the new build added migrations to it, since
# the old build does not know them. The updater holds the Docker socket, so it takes nothing from the request but the tag, which
# must be a plain image tag, and only runs images of HORNHOOF_IMAGE. It runs on the bash that ships with macOS (3.2)
# for the tests, and on Alpine's in its image.
set -euo pipefail

CONTROL="${HORNHOOF_CONTROL_DIR:-/control}"
SERVER_DIR="${HORNHOOF_SERVER_DIR:-}"
IMAGE="${HORNHOOF_IMAGE:-ghcr.io/invariant0x/hornhoof}"
UPDATER_IMAGE="${IMAGE}-updater"
HEALTH_URL="${HORNHOOF_HEALTH_URL:-http://app:8080/api/health}"
HEALTH_WAIT="${HORNHOOF_HEALTH_WAIT:-120}"
KEEP_BACKUPS=3

ID=''
VERSION=''
STATE=''
STEP=''
LOG=''
WORK=''
BACKUP=''

say() {
  printf '%s\n' "$*"
  LOG="$LOG$*
"
}

# Written whole and then moved, so the app never reads half a file.
write_status() {
  STATE=$1
  STEP=$2
  jq -n --arg id "$ID" --arg version "$VERSION" --arg state "$STATE" --arg step "$STEP" \
    --arg log "$(printf '%s' "$LOG" | tail -n 40)" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, version: $version, state: $state, step: $step, log: $log, at: $at}' > "$CONTROL/status.json.new"
  mv "$CONTROL/status.json.new" "$CONTROL/status.json"
}

step() {
  say "$2"
  write_status running "$1"
}

stop_with() {
  say "$2"
  write_status "$1" "${3:-$STEP}"
}

compose() { (cd "$SERVER_DIR" && docker compose "$@"); }

env_value() { grep "^$1=" "$SERVER_DIR/.env" 2> /dev/null | tail -1 | cut -d= -f2- || true; }

# The commit a build was made from, from its label; empty for a build made by hand.
commit_of() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:$1" 2> /dev/null || true; }

backup() {
  local db file
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  mkdir -p "$SERVER_DIR/backups"
  file="$SERVER_DIR/backups/hornhoof-$(date -u +%Y%m%dT%H%M%SZ)-$ID.sql.gz"
  (umask 077 && docker exec "$db" pg_dump -U hornhoof -d hornhoof | gzip > "$file") || {
    rm -f "$file"
    return 1
  }
  BACKUP=$file
  # shellcheck disable=SC2012 # the names are ours: hornhoof-<stamp>-<id>.sql.gz
  ls -1t "$SERVER_DIR"/backups/hornhoof-*.sql.gz | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done
  say "Saved the database to backups/$(basename "$file")."
}

# How many migrations the database has; empty when the database does not answer.
applied() {
  local db
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 0
  docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null | tr -d ' ' || true
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
  docker exec "$db" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS hornhoof_restore' -c 'CREATE DATABASE hornhoof_restore OWNER hornhoof TEMPLATE template0' > /dev/null || return 1
  gzip -dc "$BACKUP" | docker exec -i "$db" psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q > /dev/null || return 1
  docker exec "$db" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE hornhoof WITH (FORCE)' -c 'ALTER DATABASE hornhoof_restore RENAME TO hornhoof' > /dev/null || return 1
}

# install <tag>: runs the installer and the compose file that come inside that build of the app image.
install() {
  local tag=$1 cid dir
  dir="$WORK/$tag"
  mkdir -p "$dir"
  cid=$(docker create "$IMAGE:$tag") || return 1
  if ! docker cp "$cid:/app/scripts/install.sh" "$dir/install.sh" > /dev/null || ! docker cp "$cid:/app/compose.yaml" "$dir/compose.yaml" > /dev/null; then
    docker rm "$cid" > /dev/null 2>&1 || true
    return 1
  fi
  docker rm "$cid" > /dev/null 2>&1 || true
  HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_VERSION="$tag" HORNHOOF_FROM_UPDATER=1 HORNHOOF_COMPOSE_FILE="$dir/compose.yaml" \
    bash "$dir/install.sh" server >> "$WORK/install.log" 2>&1
}

# healthy <commit>: the server answers with that commit within HEALTH_WAIT seconds; any answer for a build made by hand.
healthy() {
  local want=$1 body got i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    if body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2> /dev/null); then
      got=$(printf '%s' "$body" | jq -r '.commit // empty' 2> /dev/null || true)
      if [ -z "$want" ] || [ "$got" = "$want" ]; then return 0; fi
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# The new updater takes over from a helper container that outlives this one.
swap_updater() {
  local tag=$1
  docker image inspect "$UPDATER_IMAGE:$tag" > /dev/null 2>&1 || docker pull "$UPDATER_IMAGE:$tag" > /dev/null 2>&1 || return 0
  docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$SERVER_DIR:$SERVER_DIR" -w "$SERVER_DIR" \
    --entrypoint docker "$UPDATER_IMAGE:$tag" compose up -d --no-build updater > /dev/null 2>&1 || true
}

update() {
  local tag=$1 previous target before back
  LOG=''
  case "$tag" in
    '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*)
      stop_with failed "$tag is not a version this updater can install." finished
      return 0
      ;;
  esac
  [ "${#tag}" -le 128 ] || {
    stop_with failed "The version is too long." finished
    return 0
  }
  if [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/.env" ]; then
    stop_with failed "This Hornhoof was not set up with install.sh server, so it updates by running that command again." finished
    return 0
  fi
  WORK=$(mktemp -d)

  # The build to go back to: the one running now, by its commit, or the one .env pins.
  previous=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(compose ps -q app 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$previous" ] || previous=$(env_value HORNHOOF_VERSION)
  [ -n "$previous" ] || previous=latest

  step backup "Saving the database."
  before=$(applied)
  backup || {
    stop_with failed "Could not save the database, so nothing changed."
    return 0
  }
  step pull "Downloading $VERSION."
  docker pull "$IMAGE:$tag" > /dev/null || {
    stop_with failed "Could not download $IMAGE:$tag, so nothing changed."
    return 0
  }
  target=$(commit_of "$tag")
  step install "Installing $VERSION."
  if install "$tag"; then
    step health "Waiting for the new server to answer."
    if healthy "$target"; then
      stop_with "done" "Hornhoof runs $VERSION now." finished
      swap_updater "$tag"
      return 0
    fi
    say "$VERSION did not answer within $HEALTH_WAIT seconds."
  else
    say "The installer of $VERSION failed: $(tail -n 3 "$WORK/install.log" 2> /dev/null | tr '\n' ' ')"
  fi

  step rollback "Going back to $previous."
  back="Hornhoof runs the build from before the update again. The database was saved before it."
  if [ "$(applied)" != "$before" ]; then
    say "$VERSION changed the database, so it goes back to the copy saved before the update."
    restore || {
      stop_with failed "Could not put the database back from backups/$(basename "$BACKUP"). Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
      return 0
    }
    back="Hornhoof runs the build from before the update again, with the database as it was saved before the update."
  fi
  if install "$previous" && healthy "$(commit_of "$previous")"; then
    stop_with rolled_back "$back" finished
  else
    stop_with failed "Could not go back to $previous either. Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
  fi
}

handle_request() {
  local id tag done_id
  [ -f "$CONTROL/request.json" ] || return 0
  id=$(jq -r '.id // empty' "$CONTROL/request.json" 2> /dev/null || true)
  case "$id" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
  done_id=$(jq -r '.id // empty' "$CONTROL/status.json" 2> /dev/null || true)
  [ "$id" != "$done_id" ] || return 0
  ID=$id
  VERSION=$(jq -r '.version // empty' "$CONTROL/request.json" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  tag=$(jq -r '.tag // empty' "$CONTROL/request.json")
  update "$tag"
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  WORK=''
}

# An update this updater was stopped in never finishes on its own.
interrupted() {
  [ "$(jq -r '.state // empty' "$CONTROL/status.json" 2> /dev/null || true)" = running ] || return 0
  ID=$(jq -r '.id' "$CONTROL/status.json")
  VERSION=$(jq -r '.version' "$CONTROL/status.json")
  STEP=$(jq -r '.step' "$CONTROL/status.json")
  LOG="$(jq -r '.log' "$CONTROL/status.json")
"
  stop_with failed "The updater stopped during the update. Check that Hornhoof answers, then try again."
}

mkdir -p "$CONTROL"
touch "$CONTROL/alive"
interrupted
if [ "${1:-}" = --once ]; then
  handle_request
  exit 0
fi
# alive stays fresh through long downloads too.
(while sleep 5; do touch "$CONTROL/alive"; done) &
trap 'kill $! 2> /dev/null || true' EXIT
while true; do
  handle_request
  sleep 2
done
