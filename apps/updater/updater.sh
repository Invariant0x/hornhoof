#!/usr/bin/env bash
# Hornhoof updater: swaps this server's images when someone updates from the web app.
#
#   updater.sh              watch the control folder for update requests
#   updater.sh --once       handle the waiting request, if any, then exit
#   updater.sh --take-over  put this build's updater in the place of an older one that runs an update, then exit
#
# The app writes request.json {id, version, tag, digest, nodeDigest, updaterDigest} into the control folder; this
# writes status.json {id, version, state, step, log, at} and touches alive. An update downloads the build by the
# digest the app read for it, and every image that build's compose file names, the node and updater images by their
# digests too, while the old server keeps working. Only then it stops the app, so every change the app confirmed is in
# the copy, saves the database, and runs that build's own installer, which starts exactly these images, and waits for
# the new server to answer with the build's commit, at front when the build has it. If it does not, or the installer
# does not end in time, the images that ran before go back, and the database goes back to the saved copy first when
# the new build added migrations to it, since the old build does not know them, with the public link's settings kept
# next to the copy. Before each install, containers of services the build's compose file does not name go, so a build
# from before front can take the web port again; after it, compose removes what is left of them. An updater stopped
# during an update goes on with it when it starts again.
#
# This is revision 2, which each installer hears as HORNHOOF_UPDATER_REV and the note of an update keeps. An older
# updater says no revision, so an installer that needs this one takes over: its helper container puts this build's
# updater in the place of the older one, which then finds the update in the older one's note, saves the database again
# with the app stopped, and goes on. If this build's updater does not start, the helper brings the older one back to
# go back.
#
# The updater holds the Docker socket, so it takes nothing from the request but the tag, which must be a plain image
# tag, and the digests, and only runs images of HORNHOOF_IMAGE and of its -node and -updater repositories. It runs on
# the bash that ships with macOS (3.2) for the tests, and on Alpine's in its image.
#
# It also runs the orchestrator's commands on this computer, as root, while the CEO keeps access to the computer open:
# the app writes computer.json {untilSec} and each command as computer/<id>.json {id, command, timeout}; this answers
# computer/<id>.out.json {id, exit, output}. It checks untilSec itself before each command.
set -euo pipefail

CONTROL="${HORNHOOF_CONTROL_DIR:-/control}"
SERVER_DIR="${HORNHOOF_SERVER_DIR:-}"
IMAGE="${HORNHOOF_IMAGE:-ghcr.io/invariant0x/hornhoof}"
NODE_IMAGE="${IMAGE}-node"
UPDATER_IMAGE="${IMAGE}-updater"
# The revision each installer hears and the note of an update keeps.
UPDATER_REV=2
HEALTH_WAIT="${HORNHOOF_HEALTH_WAIT:-120}"
# How long one install may take, so a migration or a database start that hangs never keeps the company in maintenance.
INSTALL_WAIT="${HORNHOOF_INSTALL_WAIT:-900}"
# How long this build's updater may take to say it goes on with an update it takes over.
TAKE_OVER_WAIT="${HORNHOOF_TAKE_OVER_WAIT:-60}"
TAKEN_OVER="This build's updater goes on with the update."
KEEP_BACKUPS=3
# The image commands on the computer run in: the updater's own, which compose names.
COMPUTER_IMAGE="${HORNHOOF_COMPUTER_IMAGE:-$UPDATER_IMAGE:latest}"
# The longest a command on the computer runs, in seconds, and how many characters of its output go back.
COMPUTER_MAX=1800
COMPUTER_OUTPUT=30000

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

# The update ends, and the note about it goes.
stop_with() {
  say "$2"
  write_status "$1" "${3:-$STEP}"
  forget
}

compose() { (cd "$SERVER_DIR" && docker compose "$@"); }

env_value() { grep "^$1=" "$SERVER_DIR/.env" 2> /dev/null | tail -1 | cut -d= -f2- || true; }

plain_tag() {
  case "$1" in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

# sha256: and 64 hex digits, the way a registry names one exact build.
plain_digest() {
  case "$1" in sha256:*) ;; *) return 1 ;; esac
  case "${1#sha256:}" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 71 ]
}

digest_or_none() { [ -z "$1" ] || plain_digest "$1"; }

# own <repository> <image>: the image is one of that repository's, by a plain tag or by a digest.
own() {
  case "$2" in
    "$1"@*) plain_digest "${2#"$1"@}" ;;
    "$1":*) plain_tag "${2#"$1":}" ;;
    *) return 1 ;;
  esac
}

# pinned <repository> <digest>: an image of the update by its digest, by the update's tag when it has none.
pinned() { if [ -n "$2" ]; then printf '%s@%s' "$1" "$2"; else printf '%s:%s' "$1" "$TAG"; fi; }

# The updater's own note of the update it runs, so an updater that was stopped can go on with it. It lies next to
# the backups, where the app cannot write.
note() {
  mkdir -p "$SERVER_DIR/backups"
  (umask 077 && jq -n --arg id "$ID" --arg version "$VERSION" --arg tag "$TAG" --arg digest "$DIGEST" --arg node "$NODE_DIGEST" \
    --arg updater "$UPDATER_DIGEST" --arg previous "$PREVIOUS" --arg back_app "$BACK_APP" --arg back_node "$BACK_NODE" \
    --arg back_updater "$BACK_UPDATER" --arg target "$TARGET" --arg before "$BEFORE" --arg backup "$BACKUP" --arg rev "$UPDATER_REV" \
    '{id: $id, version: $version, tag: $tag, digest: $digest, node: $node, updater: $updater, previous: $previous,
      back: {app: $back_app, node: $back_node, updater: $back_updater}, target: $target, before: $before, backup: $backup, rev: $rev}' \
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
  NOTE_REV=$(jq -r '.rev // empty' "$file")
  plain_tag "$TAG" && plain_digest "$DIGEST" && digest_or_none "$NODE_DIGEST" && digest_or_none "$UPDATER_DIGEST" && plain_tag "$PREVIOUS" || return 1
  own "$IMAGE" "$BACK_APP" && own "$NODE_IMAGE" "$BACK_NODE" && own "$UPDATER_IMAGE" "$BACK_UPDATER" || return 1
  case "$BACKUP" in '' | "$SERVER_DIR"/backups/hornhoof-*.sql.gz) ;; *) return 1 ;; esac
}

forget() { if [ -n "$SERVER_DIR" ]; then rm -f "$SERVER_DIR/backups/update.json"; fi; }

# The commit an app image was made from, from its label; empty for a build made by hand.
commit_of() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2> /dev/null || true; }

# The digests Docker keeps for the image the service runs now.
service_digests() {
  local id
  id=$(docker inspect --format '{{.Image}}' "$(compose ps -q "$1" 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$id" ] || return 0
  docker image inspect --format '{{join .RepoDigests " "}}' "$id" 2> /dev/null || true
}

# running <service> <repository>: the image the service runs now, by the digest Docker keeps for it in that
# repository; empty when it keeps none, as for a build made on this computer.
running() {
  local ref
  for ref in $(service_digests "$1"); do
    if own "$2" "$ref"; then
      printf '%s' "$ref"
      return 0
    fi
  done
}

# Whether the built-in node runs the exact node image of the update already.
same_node() {
  [ -n "$NODE_DIGEST" ] || return 1
  case " $(service_digests node) " in *" $NODE_IMAGE@$NODE_DIGEST "*) return 0 ;; esac
  return 1
}

# The services a compose file names, one per line; none when compose cannot read it.
services_of() { docker compose --project-directory "$SERVER_DIR" -f "$1" config --services 2> /dev/null || true; }

# names_service <compose file> <service>
names_service() {
  case " $(services_of "$1" | tr '\n' ' ') " in *" $2 "*) return 0 ;; esac
  return 1
}

services_without_node() {
  local s list=''
  for s in $(services_of "$1"); do
    [ "$s" = node ] || list="$list $s"
  done
  printf '%s' "${list# }"
}

# The container of the app starts again; it may be gone by now, and then nothing does.
start_app() { [ -z "$1" ] || docker start "$1" > /dev/null 2>&1 || true; }

# The app stops first, so every change it confirmed is in the copy. A copy that fails leaves it running again.
backup() {
  local db app file
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  mkdir -p "$SERVER_DIR/backups"
  file="$SERVER_DIR/backups/hornhoof-$(date -u +%Y%m%dT%H%M%SZ)-$ID.sql.gz"
  app=$(compose ps -q app 2> /dev/null || true)
  compose stop app > /dev/null 2>&1 || true
  (umask 077 && docker exec "$db" pg_dump -U hornhoof -d hornhoof | gzip > "$file") || {
    rm -f "$file"
    start_app "$app"
    return 1
  }
  BACKUP=$file
  # A copy of the link's settings kept with an old database copy goes with it.
  # shellcheck disable=SC2012 # the names are ours: hornhoof-<stamp>-<id>.sql.gz
  ls -1t "$SERVER_DIR"/backups/hornhoof-*.sql.gz | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old" "${old%.sql.gz}.tunnel.json"; done
  say "Saved the database to backups/$(basename "$file")."
}

# How many migrations the database has, once it answers; empty when it does not within HEALTH_WAIT seconds, as after
# the computer started again.
applied() {
  local db n i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    db=$(compose ps -q db 2> /dev/null || true)
    if [ -n "$db" ] && n=$(docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null) && [ -n "$n" ]; then
      printf '%s' "$n" | tr -d ' '
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
}

# The public link's settings as they are now, next to the database copy, readable by the owner only. A link the
# company took on the new build is not in that copy, while its name stays taken at hornhoof.org and its key is only
# here.
keep_link() {
  local file="${BACKUP%.sql.gz}.tunnel.json"
  if [ -z "$BACKUP" ] || [ ! -f "$CONTROL/tunnel.json" ]; then return 0; fi
  if (umask 077 && cp "$CONTROL/tunnel.json" "$file.new" && chmod 600 "$file.new" && mv "$file.new" "$file"); then
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
  docker exec "$db" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS hornhoof_restore' -c 'CREATE DATABASE hornhoof_restore OWNER hornhoof TEMPLATE template0' > /dev/null || return 1
  gzip -dc "$BACKUP" | docker exec -i "$db" psql -U hornhoof -d hornhoof_restore -v ON_ERROR_STOP=1 -q > /dev/null || return 1
  docker exec "$db" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS hornhoof WITH (FORCE)' -c 'ALTER DATABASE hornhoof_restore RENAME TO hornhoof' > /dev/null || return 1
}

# unpack <tag> <image>: the installer and the compose file that come inside that build of the app image, in
# WORK/<tag>.
unpack() {
  local dir="$WORK/$1" cid
  mkdir -p "$dir"
  cid=$(docker create "$2") || return 1
  if ! docker cp "$cid:/app/scripts/install.sh" "$dir/install.sh" > /dev/null || ! docker cp "$cid:/app/compose.yaml" "$dir/compose.yaml" > /dev/null; then
    docker rm "$cid" > /dev/null 2>&1 || true
    return 1
  fi
  docker rm "$cid" > /dev/null 2>&1 || true
}

# Every image the compose file of the new build names, the update's own by digest, with the server's .env filling in
# the rest. When the node runs that exact image already, compose leaves the node image out.
pull_images() {
  local services=''
  if same_node; then
    services=$(services_without_node "$WORK/$TAG/compose.yaml")
    [ -n "$services" ] || return 1
  fi
  # shellcheck disable=SC2086 # services is a space-separated list of compose service names, or empty for all of them.
  HORNHOOF_VERSION="$TAG" HORNHOOF_APP_REF="$IMAGE@$DIGEST" HORNHOOF_NODE_REF="$(pinned "$NODE_IMAGE" "$NODE_DIGEST")" \
    HORNHOOF_UPDATER_REF="$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")" \
    docker compose --project-directory "$SERVER_DIR" -f "$WORK/$TAG/compose.yaml" pull $services >> "$WORK/install.log" 2>&1
}

# The containers of this server, one per line: id and service. .env names the compose project; a server set up before
# it did goes by the name this updater's compose file gave it.
project_containers() {
  local project
  project=$(env_value COMPOSE_PROJECT_NAME)
  docker ps -a --filter "label=com.docker.compose.project=${project:-${COMPOSE_PROJECT_NAME:-hornhoof}}" \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}' 2> /dev/null || true
}

# remove_unnamed <compose file>: containers of services that file does not name go before its installer runs, since a
# build from before front could not take the web port while front holds it, and drop_orphans comes only after an
# install that worked. A file without the updater would take this updater for one of them, so then nothing goes.
remove_unnamed() {
  local named id service
  named=" $(services_of "$1" | tr '\n' ' ') "
  case "$named" in *' updater '*) ;; *) return 0 ;; esac
  while read -r id service; do
    [ -n "$service" ] || continue
    case "$named" in *" $service "*) continue ;; esac
    docker rm -f "$id" > /dev/null 2>&1 || say "Could not remove the container of $service, a service this build does not name."
  done <<< "$(project_containers)"
}

# stop_installer <process> <tag>: what it starts stops first, so a compose command waiting for it ends by itself.
stop_installer() {
  compose stop migrate app > /dev/null 2>&1 || true
  kill -9 -- "-$1" "$1" 2> /dev/null || true
  wait "$1" 2> /dev/null || true
  say "The installer of $2 did not end within $INSTALL_WAIT seconds, so it was stopped."
}

# run_installer <tag> <app> <node> <updater>: the installer of that build, for at most INSTALL_WAIT seconds. It runs in
# a process group of its own, so stopping it stops its compose commands too, which would go on starting this build
# while the one before goes back.
run_installer() {
  local tag=$1 dir="$WORK/$1" installer i=0
  set -m
  HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_VERSION="$tag" HORNHOOF_FROM_UPDATER=1 HORNHOOF_UPDATER_REV="$UPDATER_REV" HORNHOOF_COMPOSE_FILE="$dir/compose.yaml" HORNHOOF_PULLED=1 \
    HORNHOOF_APP_REF="$2" HORNHOOF_NODE_REF="$3" HORNHOOF_UPDATER_REF="$4" bash "$dir/install.sh" server >> "$WORK/install.log" 2>&1 &
  installer=$!
  set +m
  while kill -0 "$installer" 2> /dev/null; do
    if [ "$i" -ge "$INSTALL_WAIT" ]; then
      stop_installer "$installer" "$tag"
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  wait "$installer"
}

# install <tag> <app> <node> <updater>: runs the installer and the compose file that come inside that app image, and
# they start exactly these images. They are on this computer already: the new build's came before the database was
# saved, and the build from before ran here. Compose downloads only an image that is missing.
install() {
  unpack "$1" "$2" || return 1
  remove_unnamed "$WORK/$1/compose.yaml"
  run_installer "$@" || return 1
  drop_orphans
}

# The installer of a build starts only the services it knows, so after going back to a build from before a service,
# as the tunnel, that service's container would run on, carrying the public link to a server that knows nothing of
# it. compose removes the containers of services its file does not name; db runs already, so nothing else changes. A
# file without the updater would take this updater for one of them, so then nothing goes.
drop_orphans() {
  if names_service "$SERVER_DIR/compose.yaml" updater; then
    compose up -d --no-build --remove-orphans db >> "$WORK/install.log" 2>&1 || say "Could not remove the containers that $SERVER_DIR/compose.yaml no longer names."
  fi
}

# Where the build that runs now answers: at front when the compose file its installer copied here names it.
health_url() {
  if [ -n "${HORNHOOF_HEALTH_URL:-}" ]; then
    printf '%s' "$HORNHOOF_HEALTH_URL"
  elif names_service "$SERVER_DIR/compose.yaml" front; then
    printf 'http://front:8080/api/health'
  else
    printf 'http://app:8080/api/health'
  fi
}

# healthy <commit>: the server answers with that commit within HEALTH_WAIT seconds; any answer for a build made by hand.
healthy() {
  local want=$1 body got i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    if body=$(curl -fsS --max-time 5 "$(health_url)" 2> /dev/null); then
      got=$(printf '%s' "$body" | jq -r '.commit // empty' 2> /dev/null || true)
      if [ -z "$want" ] || [ "$got" = "$want" ]; then return 0; fi
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# The new updater takes over from a helper container that outlives this one. Both are the updater image of the
# update, which .env names for compose too.
swap_updater() {
  local image
  image=$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")
  docker image inspect "$image" > /dev/null 2>&1 || docker pull "$image" > /dev/null 2>&1 || return 0
  docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$SERVER_DIR:$SERVER_DIR" -w "$SERVER_DIR" \
    --entrypoint docker "$image" compose up -d --no-build updater > /dev/null 2>&1 || true
}

update() {
  local tag=$1 digest=$2 node=$3 updater=$4
  LOG=''
  if ! plain_tag "$tag"; then
    if [ "${#tag}" -le 128 ]; then
      stop_with failed "$tag is not a version this updater can install." finished
    else
      stop_with failed "The version is too long." finished
    fi
    return 0
  fi
  { plain_digest "$digest" && digest_or_none "$node" && digest_or_none "$updater"; } || {
    stop_with failed "The request does not name the exact build to install, so nothing changed." finished
    return 0
  }
  if [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/.env" ]; then
    stop_with failed "This Hornhoof was not set up with install.sh server, so it updates by running that command again." finished
    return 0
  fi
  TAG=$tag
  DIGEST=$digest
  NODE_DIGEST=$node
  UPDATER_DIGEST=$updater
  TARGET=''
  BEFORE=''
  BACKUP=''

  # The build to go back to: the one running now, by its commit, or the one .env pins; and the images it runs, by the
  # digests Docker keeps for them, or by that build's tag.
  PREVIOUS=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(compose ps -q app 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$PREVIOUS" ] || PREVIOUS=$(env_value HORNHOOF_VERSION)
  [ -n "$PREVIOUS" ] || PREVIOUS=latest
  BACK_APP=$(running app "$IMAGE")
  [ -n "$BACK_APP" ] || BACK_APP="$IMAGE:$PREVIOUS"
  BACK_NODE=$(running node "$NODE_IMAGE")
  [ -n "$BACK_NODE" ] || BACK_NODE="$NODE_IMAGE:$PREVIOUS"
  BACK_UPDATER=$(running updater "$UPDATER_IMAGE")
  [ -n "$BACK_UPDATER" ] || BACK_UPDATER="$UPDATER_IMAGE:$PREVIOUS"
  note

  step pull "Downloading $VERSION."
  docker pull "$IMAGE@$DIGEST" > /dev/null || {
    stop_with failed "Could not download $IMAGE:$TAG, so nothing changed."
    return 0
  }
  # Downloads take minutes and the old server works on meanwhile, so they come before the copy of the database: going
  # back to the copy then loses only what the old server did in the moment before the new build starts.
  { unpack "$TAG" "$IMAGE@$DIGEST" && pull_images; } || {
    stop_with failed "Could not download the images of $VERSION, so nothing changed."
    return 0
  }
  TARGET=$(commit_of "$IMAGE@$DIGEST")
  note

  step backup "Saving the database."
  BEFORE=$(applied)
  backup || {
    stop_with failed "Could not save the database, so nothing changed."
    return 0
  }
  note
  step install "Installing $VERSION."
  install_new
}

# The new build goes in and has to answer; otherwise the build from before goes back.
install_new() {
  if install "$TAG" "$IMAGE@$DIGEST" "$(pinned "$NODE_IMAGE" "$NODE_DIGEST")" "$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")"; then
    check_new
  else
    say "The installer of $VERSION failed: $(tail -n 3 "$WORK/install.log" 2> /dev/null | tr '\n' ' ')"
    go_back
  fi
}

check_new() {
  step health "Waiting for the new server to answer."
  if healthy "$TARGET"; then
    stop_with "done" "Hornhoof runs $VERSION now." finished
    swap_updater
    return 0
  fi
  say "$VERSION did not answer within $HEALTH_WAIT seconds."
  go_back
}

go_back() {
  local back="Hornhoof runs the build from before the update again. The database was saved before it."
  step rollback "Going back to $PREVIOUS."
  if [ "$(applied)" != "$BEFORE" ]; then
    say "$VERSION changed the database, so it goes back to the copy saved before the update."
    keep_link
    restore || {
      stop_with failed "Could not put the database back from backups/$(basename "$BACKUP"). Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
      return 0
    }
    back="Hornhoof runs the build from before the update again, with the database as it was saved before the update."
  fi
  if install "$PREVIOUS" "$BACK_APP" "$BACK_NODE" "$BACK_UPDATER" && healthy "$(commit_of "$BACK_APP")"; then
    stop_with rolled_back "$back" finished
  else
    stop_with failed "Could not go back to $PREVIOUS either. Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
  fi
}

handle_request() {
  local id tag digest node updater done_id
  [ -f "$CONTROL/request.json" ] || return 0
  id=$(jq -r '.id // empty' "$CONTROL/request.json" 2> /dev/null || true)
  case "$id" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
  done_id=$(jq -r '.id // empty' "$CONTROL/status.json" 2> /dev/null || true)
  [ "$id" != "$done_id" ] || return 0
  ID=$id
  VERSION=$(jq -r '.version // empty' "$CONTROL/request.json" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  tag=$(jq -r '.tag // empty' "$CONTROL/request.json")
  digest=$(jq -r '.digest // empty' "$CONTROL/request.json")
  node=$(jq -r '.nodeDigest // empty' "$CONTROL/request.json")
  updater=$(jq -r '.updaterDigest // empty' "$CONTROL/request.json")
  WORK=$(mktemp -d)
  update "$tag" "$digest" "$node" "$updater"
  rm -rf "$WORK"
  WORK=''
}

update_running() { [ "$(jq -r '.state // empty' "$CONTROL/status.json" 2> /dev/null || true)" = running ]; }

# The update under way, as status.json says it.
read_status() {
  ID=$(jq -r '.id // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9-')
  VERSION=$(jq -r '.version // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  STEP=$(jq -r '.step // empty' "$CONTROL/status.json")
  LOG="$(jq -r '.log // empty' "$CONTROL/status.json")
"
}

# Whether this build's installer handed the update over: an older updater got as far as its copy of the database, which
# it notes only after it took it. This updater may have been stopped during the second copy since.
handed_over() {
  [ -z "$NOTE_REV" ] && [ -n "$BACKUP" ] && { [ "$STEP" = install ] || [ "$STEP" = backup ]; }
}

# The older updater took its copy while the app worked on, so unless the new build ran already it is taken again, with
# the app stopped. The line goes out at once, since the helper is waiting for it. This build's installer wrote .env and
# compose.yaml already, so from here a failure goes back.
go_on_handed_over() {
  step install "$TAKEN_OVER"
  if [ "$(applied)" = "$BEFORE" ]; then
    step backup "Saving the database again, now that the app is stopped."
    backup || {
      say "Could not save the database again."
      go_back
      return 0
    }
  fi
  note
  step install "Installing $VERSION."
  install_new
}

# The update goes on from the step it was at. Before the install nothing changed yet, so it starts over, with the app
# running again that the copy stopped, or a download that fails would say nothing changed with the company's app down.
go_on() {
  say "The updater stopped during the update and goes on with it."
  [ "$STEP" != backup ] || start_app "$(compose ps -aq app 2> /dev/null || true)"
  case "$STEP" in
    backup | pull) update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST" ;;
    install)
      step install "Installing $VERSION."
      install_new
      ;;
    health) check_new ;;
    *) go_back ;;
  esac
}

# An update this updater was stopped in, or was handed by an older one, goes on by the note of it.
interrupted() {
  update_running || return 0
  read_status
  if ! recall; then
    stop_with failed "The updater stopped during the update. Check that Hornhoof answers, then try again."
    return 0
  fi
  WORK=$(mktemp -d)
  if handed_over; then go_on_handed_over; else go_on; fi
  rm -rf "$WORK"
  WORK=''
}

# Whether this build's updater says it goes on with the update, within TAKE_OVER_WAIT seconds.
taken_over() {
  local i=0
  while true; do
    case "$(jq -r '.log // empty' "$CONTROL/status.json" 2> /dev/null || true)" in *"$TAKEN_OVER"*) return 0 ;; esac
    [ "$i" -lt "$TAKE_OVER_WAIT" ] || return 1
    i=$((i + 1))
    sleep 1
  done
}

# The helper container this build's installer starts when an older updater runs it. Compose replaces that updater, and
# the installer waiting in it, with this build's, which finds the update by the older one's note. If it does not say so
# in time, the older updater starts again, finds step rollback and goes back, by itself.
take_over() {
  update_running || return 0
  read_status
  { [ "$STEP" = install ] && recall; } || return 0
  if compose up -d --no-build --wait updater > /dev/null 2>&1 && taken_over; then return 0; fi
  say "This build's updater did not start, so the build from before goes back."
  write_status running rollback
  HORNHOOF_UPDATER_REF="$BACK_UPDATER" compose up -d --no-build updater > /dev/null 2>&1 ||
    stop_with failed "No updater could start. Hornhoof still runs the build from before; run install.sh server in $SERVER_DIR." finished
}

# Whether the CEO keeps access to the computer open now, by the time the app wrote, which ends it by itself.
computer_open() {
  local until
  until=$(jq -r '.untilSec // 0' "$CONTROL/computer.json" 2> /dev/null || true)
  case "$until" in '' | *[!0-9]*) return 1 ;; esac
  [ "$until" -gt "$(date +%s)" ]
}

# computer_answer <id> <exit code> <output file>: the end of the output, written whole and then moved.
computer_answer() {
  local file="$CONTROL/computer/$1.out.json"
  tail -c "$COMPUTER_OUTPUT" "$3" | jq -Rs --arg id "$1" --argjson exit "$2" '{id: $id, exit: $exit, output: .}' > "$file.new"
  mv "$file.new" "$file"
}

# Each waiting command, one at a time, in a container of the updater's image: root with every privilege, in the
# computer's processes, network and names, with its whole file system at /host and its Docker. chroot /host runs a
# command on the computer itself. A command past its time, or still running when the CEO closes access, is stopped;
# nothing runs while access is closed. A command this updater started is marked, so after a restart it never runs a
# second time, and what still runs of it is stopped.
computer_runs() {
  local file id command timeout out name watch code made
  [ -d "$CONTROL/computer" ] || return 0
  for file in "$CONTROL"/computer/*.started; do
    [ -f "$file" ] || continue
    id=$(basename "$file" .started)
    case "$id" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    [ ! -f "$CONTROL/computer/$id.json" ] || continue
    docker rm -f "hornhoof-computer-$id" > /dev/null 2>&1 || true
    rm -f "$file"
  done
  for file in "$CONTROL"/computer/*.json; do
    case "$file" in *.out.json) continue ;; esac
    [ -f "$file" ] || continue
    id=$(basename "$file" .json)
    case "$id" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    [ ! -f "$CONTROL/computer/$id.out.json" ] || continue
    name="hornhoof-computer-$id"
    out=$(mktemp)
    if [ -f "$CONTROL/computer/$id.started" ]; then
      docker rm -f "$name" > /dev/null 2>&1 || true
      printf 'The updater restarted while this command ran, so it was stopped. Look at what it did before you run it again.\n' > "$out"
      computer_answer "$id" 125 "$out"
      rm -f "$out" "$CONTROL/computer/$id.started"
      continue
    fi
    if ! computer_open; then
      printf 'Access to the computer is closed.\n' > "$out"
      computer_answer "$id" 126 "$out"
      rm -f "$out"
      continue
    fi
    command=$(jq -r '.command // empty' "$file" 2> /dev/null || true)
    timeout=$(jq -r '.timeout // empty' "$file" 2> /dev/null || true)
    case "$timeout" in '' | *[!0-9]*) timeout=300 ;; esac
    if [ "$timeout" -lt 1 ] || [ "$timeout" -gt "$COMPUTER_MAX" ]; then timeout=300; fi
    touch "$CONTROL/computer/$id.started"
    code=0
    made=1
    # Made first and only then started, so the watch can always stop it.
    docker create --rm --name "$name" --privileged --pid=host --network=host --ipc=host --uts=host -v /:/host \
      -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash "$COMPUTER_IMAGE" -c "$command" > /dev/null 2>> "$out" || made=''
    if [ -z "$made" ]; then
      code=125
    elif ! computer_open; then
      touch "$out.closed"
      docker rm -f "$name" > /dev/null 2>&1 || true
    else
      # The watch removes the container once its time is up or access closes, unless the command ended first.
      (
        i=0
        while [ "$i" -lt "$timeout" ]; do
          sleep 1
          [ ! -f "$out.done" ] || exit 0
          if ! computer_open; then
            touch "$out.closed"
            docker rm -f "$name"
            exit 0
          fi
          i=$((i + 1))
        done
        touch "$out.late"
        docker rm -f "$name"
      ) > /dev/null 2>&1 &
      watch=$!
      docker start -a "$name" < /dev/null >> "$out" 2>&1 || code=$?
      touch "$out.done"
      wait "$watch" 2> /dev/null || true
    fi
    if [ -f "$out.late" ]; then
      printf '\nStopped after %s seconds.\n' "$timeout" >> "$out"
      code=124
    elif [ -f "$out.closed" ]; then
      printf '\nStopped: access to the computer was closed.\n' >> "$out"
      code=125
    fi
    # The app stops waiting for an answer and takes the command back after a while.
    [ ! -f "$file" ] || computer_answer "$id" "$code" "$out"
    rm -f "$out" "$out.done" "$out.late" "$out.closed" "$CONTROL/computer/$id.started"
  done
}

if [ "${1:-}" = --take-over ]; then
  take_over
  exit 0
fi
mkdir -p "$CONTROL"
touch "$CONTROL/alive"
interrupted
if [ "${1:-}" = --once ]; then
  handle_request
  computer_runs
  exit 0
fi
# alive stays fresh through long downloads too, and commands on the computer do not wait for an update.
(while sleep 5; do touch "$CONTROL/alive"; done) &
ALIVE=$!
# A command that went wrong does not end the loop.
(while true; do
  computer_runs || true
  sleep 1
done) &
RUNS=$!
trap 'kill $ALIVE $RUNS 2> /dev/null || true' EXIT
while true; do
  handle_request
  sleep 2
done
