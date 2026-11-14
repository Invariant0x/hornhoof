#!/usr/bin/env bash
# Hornhoof updater: swaps this server's images when someone updates from the web app.
#
#   updater.sh          watch the control folder for update requests
#   updater.sh --once   handle the waiting request, if any, then exit
#
# The app writes request.json {id, version, tag, digest, nodeDigest, updaterDigest} into the control folder; this
# writes status.json {id, version, state, step, log, at} and touches alive. An update downloads the build by the
# digest the app read for it, and every image that build's compose file names, the node and updater images by their
# digests too, while the old server keeps working. Only then it saves the database, runs that build's own installer,
# which starts exactly these images, and waits for the new server to answer with the build's commit. If it does not,
# the images that ran before go back, and the database goes back to the saved copy first when the new build added
# migrations to it, since the old build does not know them, with the public link's settings kept next to the copy.
# After each install, containers of services the build's compose file does not name go. An updater stopped during an
# update goes on with it when it starts again. The updater holds the Docker socket, so it takes nothing from the
# request but the tag, which must be a plain image tag, and the digests, and only runs images of HORNHOOF_IMAGE and of
# its -node and -updater repositories. It runs on the bash that ships with macOS (3.2) for the tests, and on Alpine's
# in its image.
#
# An update replaces the app alone while a node runs another image, since the turns on it would stop with it. Afterwards
# this asks the server, with the built-in node's key, to let the work of the nodes on this computer that run another image
# end: the server keeps new work off them, says of each when it is free, and goes on saying one is not past its deadline,
# when it told Operations. The installer of the build that runs replaces each as soon as it is free itself, whatever the
# others wait for. A server from before this says so only of all of them together. Requests marked immediate or urgent
# replace them with the app at once. The same goes for an update an updater from before this ran, and for install.sh
# server by hand.
#
# It also runs the orchestrator's commands on this computer, as root, while the CEO keeps access to the computer open:
# the app writes computer.json {untilSec} and each command as computer/<id>.json {id, command, timeout}; this answers
# computer/<id>.out.json {id, exit, output}. It checks untilSec itself before each command.
#
#   updater.sh nodes <server> <image> <host> [--once]   move that server's nodes on this computer to the server's build
#   updater.sh start-nodes <server> <image> <host>      start the one updater of that server's nodes here, on <image>
#
# On a computer that is not the server's own, install.sh starts one updater for each server's nodes there, in a container of
# the updater image of the server's build with this computer's Docker, and with the hash that computer goes by (<host>). It
# has no server folder, no requests and no commands. Every few minutes it reads the installer the server serves, as data and
# never as a program: the node and updater images of the server's build, each by its digest in Hornhoof's own repository,
# and the server's own computer. It first moves to that updater image, through a helper
# that outlives it. Only then a node of that server on another image goes to that node image, through the installer this
# image carries, the one of the same build, with these values filled in: it asks the server, with the node's own key from its
# volume, to let the node's work end, and replaces the node once it is free. So what runs with this computer's Docker is only
# ever an image of Hornhoof's, by its digest. On the server's own computer it does nothing: the updater next to the server
# moves the nodes there.
set -euo pipefail

CONTROL="${HORNHOOF_CONTROL_DIR:-/control}"
SERVER_DIR="${HORNHOOF_SERVER_DIR:-}"
IMAGE="${HORNHOOF_IMAGE:-ghcr.io/invariant0x/hornhoof}"
NODE_IMAGE="${IMAGE}-node"
UPDATER_IMAGE="${IMAGE}-updater"
HEALTH_URL="${HORNHOOF_HEALTH_URL:-http://app:8080/api/health}"
HEALTH_WAIT="${HORNHOOF_HEALTH_WAIT:-120}"
KEEP_BACKUPS=3
NODES_URL="${HEALTH_URL%/api/health}/api/nodes/update"
# How often it looks whether a node is behind, and asks again after a server that gave no answer, in seconds.
NODES_CHECK=30
# How long it leaves the nodes alone after an installer failed or a server said it cannot wait, in seconds.
NODES_RETRY=300
# The installer of this updater's own build, which it runs for the nodes of a server on another computer.
INSTALLER="${HORNHOOF_INSTALLER:-/usr/local/share/hornhoof/install.sh}"
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
# database had before, and the copy of it.
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
# Set for an installer that may stop the nodes now, with the ones it may stop when the server named them. When to look at
# the nodes next, in seconds since 1970.
NODES_FREE=''
NODES_ONLY=''
NODES_AT=0

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

# by_digest <repository> <image>: the image is one of that repository's, by its digest alone.
by_digest() { case "$2" in "$1"@*) plain_digest "${2#"$1"@}" ;; *) return 1 ;; esac; }

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
    --arg back_updater "$BACK_UPDATER" --arg target "$TARGET" --arg before "$BEFORE" --arg backup "$BACKUP" --arg nodes_free "$NODES_FREE" \
    '{id: $id, version: $version, tag: $tag, digest: $digest, node: $node, updater: $updater, previous: $previous,
      back: {app: $back_app, node: $back_node, updater: $back_updater}, target: $target, before: $before, backup: $backup, nodes_free: $nodes_free}' \
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

services_without_node() {
  local s list=''
  for s in $(docker compose --project-directory "$SERVER_DIR" -f "$1" config --services 2> /dev/null || true); do
    [ "$s" = node ] || list="$list $s"
  done
  printf '%s' "${list# }"
}

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

# install <tag> <app> <node> <updater>: runs the installer and the compose file that come inside that app image, and
# they start exactly these images. They are on this computer already: the new build's came before the database was
# saved, and the build from before ran here. Compose downloads only an image that is missing.
install() {
  local tag=$1 dir="$WORK/$1"
  unpack "$tag" "$2" || return 1
  HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_VERSION="$tag" HORNHOOF_FROM_UPDATER=1 HORNHOOF_COMPOSE_FILE="$dir/compose.yaml" HORNHOOF_PULLED=1 \
    HORNHOOF_APP_REF="$2" HORNHOOF_NODE_REF="$3" HORNHOOF_UPDATER_REF="$4" HORNHOOF_NODES_FREE="$NODES_FREE" HORNHOOF_NODES_ONLY="$NODES_ONLY" bash "$dir/install.sh" server >> "$WORK/install.log" 2>&1 || return 1
  drop_orphans
}

# The installer of a build starts only the services it knows, so after going back to a build from before a service,
# as the tunnel, that service's container would run on, carrying the public link to a server that knows nothing of
# it. compose removes the containers of services its file does not name; db runs already, so nothing else changes. A
# file without the updater would take this updater for one of them, so then nothing goes.
drop_orphans() {
  case " $(compose config --services 2> /dev/null | tr '\n' ' ') " in
    *' updater '*) compose up -d --no-build --remove-orphans db >> "$WORK/install.log" 2>&1 || say "Could not remove the containers that $SERVER_DIR/compose.yaml no longer names." ;;
  esac
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
  NODES_FREE=$(jq -r 'if .immediate == true or .urgent == true then "1" else "" end' "$CONTROL/request.json")
  WORK=$(mktemp -d)
  update "$tag" "$digest" "$node" "$updater"
  rm -rf "$WORK"
  WORK=''
  NODES_FREE=''
}

# An update this updater was stopped in goes on from the step it was at, by the updater's own note of it. Before the
# install nothing changed yet, so it starts over.
interrupted() {
  [ "$(jq -r '.state // empty' "$CONTROL/status.json" 2> /dev/null || true)" = running ] || return 0
  ID=$(jq -r '.id // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9-')
  VERSION=$(jq -r '.version // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  STEP=$(jq -r '.step // empty' "$CONTROL/status.json")
  LOG="$(jq -r '.log // empty' "$CONTROL/status.json")
"
  if ! recall; then
    stop_with failed "The updater stopped during the update. Check that Hornhoof answers, then try again."
    return 0
  fi
  say "The updater stopped during the update and goes on with it."
  WORK=$(mktemp -d)
  case "$STEP" in
    backup | pull) update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST" ;;
    install)
      step install "Installing $VERSION."
      install_new
      ;;
    health) check_new ;;
    *) go_back ;;
  esac
  rm -rf "$WORK"
  WORK=''
  NODES_FREE=''
}

# The nodes on this computer that run another image than the one .env names, or have stopped, by the images of this
# server's own repositories, as words: builtin for the built-in node, the plan on its label for each other. One of
# another server on this computer counts too: the server names only its own.
nodes_behind() {
  local cid running target name plan
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  own "$IMAGE" "$(env_value HORNHOOF_APP_REF)" && own "$NODE_IMAGE" "$(env_value HORNHOOF_NODE_REF)" && own "$UPDATER_IMAGE" "$(env_value HORNHOOF_UPDATER_REF)" || return 0
  plain_tag "$(env_value HORNHOOF_VERSION)" || return 0
  target=$(docker image inspect --format '{{.Id}}' "$(env_value HORNHOOF_NODE_REF)" 2> /dev/null || true)
  cid=$(compose ps -aq node 2> /dev/null || true)
  running=''
  if [ -n "$cid" ]; then running=$(docker inspect --format '{{.Image}}' "$cid" 2> /dev/null || true); fi
  if [ -n "$running" ] && { [ "$running" != "$target" ] || [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2> /dev/null || true)" = false ]; }; then printf 'builtin '; fi
  { docker ps -a --filter label=hornhoof.subscription --format '{{.Names}} {{.Label "hornhoof.subscription"}}' 2> /dev/null || true; } | while read -r name plan; do
    case "$plan" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    running=$(docker inspect --format '{{.Image}}' "$name" 2> /dev/null || true)
    if [ -n "$running" ] && { [ "$running" != "$target" ] || [ "$(docker inspect --format '{{.State.Running}}' "$name" 2> /dev/null || true)" = false ]; }; then printf '%s ' "$plan"; fi
  done
}

# ask_nodes <method> <answer file> [names]: the HTTP code of the server's answer about these nodes on this computer, or
# about all of them. The key goes to curl on its input, so no command line shows it.
ask_nodes() {
  local body
  body=$(jq -cn --arg names "${3:-}" 'if $names == "" then {scope: "server"} else {scope: "server", nodes: ($names | split(" ") | map(select(length > 0)))} end')
  printf 'header = "Authorization: Bearer %s"\n' "$(env_value NODE_KEY)" |
    curl -sS --max-time 10 --config - -X "$1" -H 'content-type: application/json' -d "$body" -o "$2" -w '%{http_code}' "$NODES_URL" 2> /dev/null
}

# replace_nodes [names]: these nodes are free, or all of them with no names: the installer of the build that runs replaces
# them, and the server lets go of them. The others keep their wait and its deadline.
replace_nodes() {
  WORK=$(mktemp -d)
  NODES_FREE=1
  NODES_ONLY=${1:-}
  if ! install "$(env_value HORNHOOF_VERSION)" "$(env_value HORNHOOF_APP_REF)" "$(env_value HORNHOOF_NODE_REF)" "$(env_value HORNHOOF_UPDATER_REF)"; then
    printf 'Could not replace the nodes: %s\n' "$(tail -n 3 "$WORK/install.log" 2> /dev/null | tr '\n' ' ')"
    NODES_AT=$(($(date +%s) + NODES_RETRY))
  fi
  NODES_FREE=''
  NODES_ONLY=''
  ask_nodes DELETE /dev/null "${1:-}" > /dev/null || true
  rm -rf "$WORK"
  WORK=''
}

# free_of <answer file> <names>: those of these names the server says are free. The names are the ones this found itself,
# so the installer gets nothing else the server says.
free_of() {
  local name
  for name in $2; do
    if jq -e --arg name "$name" 'any(.free[]?; . == $name)' "$1" > /dev/null 2>&1; then printf '%s ' "$name"; fi
  done
}

# act_on_nodes <answer file> <names>: what the server said of the nodes behind. One from before free replaces them all or
# none, and its installer moves them only along with the built-in node: with that one on its image nothing would ever move,
# so they go back to work until a later look.
act_on_nodes() {
  local free now
  now=$(date +%s)
  if jq -e '.free != null' "$1" > /dev/null 2>&1; then
    free=$(free_of "$1" "$2")
    if [ -n "$free" ]; then replace_nodes "${free% }"; fi
  else
    case " $2 " in
      *' builtin '*) if [ "$(jq -r '.ready // false' "$1")" = true ]; then replace_nodes; fi ;;
      *)
        ask_nodes DELETE /dev/null > /dev/null || true
        NODES_AT=$((now + NODES_RETRY))
        ;;
    esac
  fi
}

# One look at the nodes, which never waits: a request for an update goes first, and the server lets go of the nodes when
# this stops asking.
catch_up_nodes() {
  local now code answer poll behind
  now=$(date +%s)
  [ "$now" -ge "$NODES_AT" ] || return 0
  NODES_AT=$((now + NODES_CHECK))
  behind=$(nodes_behind || true)
  [ -n "$behind" ] || return 0
  answer=$(mktemp)
  code=$(ask_nodes POST "$answer" "$behind" || true)
  case "$code" in
    200)
      poll=$(jq -r '((.pollAfterMs // 5000) / 1000) | ceil' "$answer")
      NODES_AT=$((now + poll))
      act_on_nodes "$answer" "$behind"
      ;;
    404)
      printf 'This server is from before nodes wait for their work, so they stay on their image and what they run goes on.\n'
      NODES_AT=$((now + NODES_RETRY))
      ;;
  esac
  rm -f "$answer"
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

# --- A server's nodes on another computer ------------------------------------------------------

# How often the updater of a server's nodes looks at them, and how long it waits after a look that failed, in seconds.
NODES_EVERY=300
NODES_BACKOFF=900
SAID=''

# Each thing once until something else is said, so a look every few minutes keeps the log short.
tell() {
  if [ "$*" != "$SAID" ]; then printf '%s\n' "$*"; fi
  SAID=$*
}

# An http or https address with nothing in it that a command line or a Docker filter would take for more.
plain_server() {
  case "$1" in http://?* | https://?*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9.:/_-]*) return 1 ;; esac
  [ "${#1}" -le 200 ]
}

# The hash a computer goes by, 64 hex digits, or none.
plain_host() {
  [ -n "$1" ] || return 0
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 64 ]
}

# served <name> <file>: what the installer a server serves says in that line of its own, read as data.
served() { sed -n "s/^$1=\"\\(.*\\)\"\$/\\1/p" "$2" | head -n 1; }

# The name of the one updater of a server's nodes on this computer, from the server's address.
updater_name() {
  if command -v sha256sum > /dev/null 2>&1; then
    printf 'hornhoof-updater-%s' "$(printf '%s' "$1" | sha256sum | cut -c1-12)"
  else
    printf 'hornhoof-updater-%s' "$(printf '%s' "$1" | shasum -a 256 | cut -c1-12)"
  fi
}

# behind_of <server> <image>: the plans of that server's nodes on this computer, by their labels, that have stopped or
# whose image Docker does not keep as <image>; a stopped container whose volume says Hornhoof removed its plan goes here.
behind_of() {
  local name plan id
  { docker ps -a --filter label=hornhoof.subscription --filter "label=hornhoof.server=$1" --format '{{.Names}} {{.Label "hornhoof.subscription"}}' 2> /dev/null || true; } | while read -r name plan; do
    case "$plan" in '' | *[!A-Za-z0-9_-]*) continue ;; esac
    id=$(docker inspect --format '{{.Image}}' "$name" 2> /dev/null || true)
    [ -n "$id" ] || continue
    if [ "$(docker inspect --format '{{.State.Running}}' "$name" 2> /dev/null || true)" != false ]; then
      case " $(docker image inspect --format '{{join .RepoDigests " "}}' "$id" 2> /dev/null || true) " in *" $2 "*) continue ;; esac
    elif docker cp "$name:/data/removed" - > /dev/null 2>&1; then
      printf 'Removing %s, which was removed in Hornhoof.\n' "$name" >&2
      docker rm -f "$name" > /dev/null 2>&1 || true
      docker volume rm "$name" > /dev/null 2>&1 || true
      continue
    fi
    printf '%s ' "$plan"
  done
}

# fill_installer <server> <node image> <updater image> <host>: this image's own installer as the server serves it. Every value
# matched its pattern before, so none holds a character sed or bash would take for more.
fill_installer() {
  sed -e "s|__HORNHOOF_SERVER__|$1|g" -e "s|__HORNHOOF_NODE_IMAGE__|$2|g" -e "s|__HORNHOOF_UPDATER_IMAGE__|$3|g" \
    -e "s|__HORNHOOF_HOST_ID__|$4|g" "$INSTALLER"
}

# nodes_look <server> <image> <host>: one look at that server's nodes here. The installers of several nodes wait for them
# side by side, each replacing only its own. Fails when the server did not answer, the move to the server's updater did not
# start, or an installer failed.
nodes_look() {
  local served build updater server_host behind plan pids='' pid failed=''
  served="$WORK/served"
  if ! curl -fsS --max-time 30 -o "$served" "$1/install.sh" 2> /dev/null; then
    tell "Could not reach $1, so its nodes here stay as they are for now."
    return 1
  fi
  build=$(served BUILD_IMAGE "$served")
  updater=$(served UPDATER_BUILD "$served")
  server_host=$(served SERVER_HOST_ID "$served")
  if [ -n "$3" ] && [ "$server_host" = "$3" ]; then
    tell "This is the computer of $1, so the updater next to that server moves its nodes here."
    return 0
  fi
  if ! by_digest "$NODE_IMAGE" "$build" || ! by_digest "$UPDATER_IMAGE" "$updater" || ! plain_host "$server_host"; then
    tell "$1 does not name the node and updater images of its build by their digests, so its nodes here stay as they are."
    return 0
  fi
  if [ "$updater" != "$2" ]; then
    tell "Moving to $updater, the updater of the build $1 runs. That one moves the nodes."
    docker run -d --rm --name "$(updater_name "$1")-move" -v /var/run/docker.sock:/var/run/docker.sock "$updater" start-nodes "$1" "$updater" "$3" > /dev/null || {
      tell "Could not start $updater, so the nodes here stay as they are for now."
      return 1
    }
    return 0
  fi
  behind=$(behind_of "$1" "$build")
  [ -n "$behind" ] || return 0
  SAID=''
  fill_installer "$1" "$build" "$updater" "$server_host" > "$WORK/install.sh"
  for plan in $behind; do
    printf 'The node of plan %s runs another build than %s, so it goes to %s once its work ends.\n' "$plan" "$1" "$build"
    HORNHOOF_FROM_UPDATER=1 HORNHOOF_NODES_ONLY="$plan" HORNHOOF_TTY=/dev/null bash "$WORK/install.sh" > "$WORK/$plan.log" 2>&1 &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" || failed=1; done
  for plan in $behind; do cat "$WORK/$plan.log"; done
  [ -z "$failed" ]
}

# nodes_mode <server> <image> <host> [--once]: a look at the nodes every few minutes, and a longer wait after one that failed.
nodes_mode() {
  local code
  if ! plain_server "$1" || ! by_digest "$UPDATER_IMAGE" "$2" || ! plain_host "$3"; then
    printf 'Usage: updater.sh nodes <server address> <updater image by digest> <host hash> [--once]\n' >&2
    exit 2
  fi
  while true; do
    WORK=$(mktemp -d)
    code=0
    nodes_look "$1" "$2" "$3" || code=1
    rm -rf "$WORK"
    if [ "${4:-}" = --once ]; then exit "$code"; fi
    if [ "$code" = 0 ]; then sleep "$NODES_EVERY"; else sleep "$NODES_BACKOFF"; fi
  done
}

# start_nodes <server> <image> <host>: the one updater of that server's nodes on this computer runs <image>, under a name that
# comes from the server's address, so Docker never lets a second one start. One that runs that image already stays; the others
# go once the image is here. It starts again with Docker.
start_nodes() {
  local name old
  if ! plain_server "$1" || ! by_digest "$UPDATER_IMAGE" "$2" || ! plain_host "$3"; then
    printf 'Usage: updater.sh start-nodes <server address> <updater image by digest> <host hash>\n' >&2
    return 2
  fi
  name=$(updater_name "$1")
  [ "$(docker inspect --format '{{if .State.Running}}{{.Config.Image}}{{end}}' "$name" 2> /dev/null || true)" != "$2" ] || return 0
  docker image inspect "$2" > /dev/null 2>&1 || docker pull "$2" > /dev/null || return 1
  for old in $(docker ps -aq --filter label=hornhoof.updater=nodes --filter "label=hornhoof.server=$1" 2> /dev/null || true); do
    docker rm -f "$old" > /dev/null 2>&1 || true
  done
  docker run -d --name "$name" --label hornhoof.updater=nodes --label "hornhoof.server=$1" --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock "$2" nodes "$1" "$2" "$3" > /dev/null
}

case "${1:-}" in
  nodes) nodes_mode "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  start-nodes)
    start_nodes "${2:-}" "${3:-}" "${4:-}"
    exit 0
    ;;
esac

mkdir -p "$CONTROL"
touch "$CONTROL/alive"
interrupted
if [ "${1:-}" = --once ]; then
  handle_request
  catch_up_nodes
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
  catch_up_nodes || printf 'Could not look at the nodes.\n'
  sleep 2
done
