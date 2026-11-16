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
# fails, the images that ran before go back, and the database goes back to the saved copy first when
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
# An update replaces the app alone while a node runs another image, since the turns on it would stop with it. Afterwards
# this asks the server, with the built-in node's key, to let the work of the nodes on this computer that run another image
# end: the server keeps new work off them, says of each when it is free, and goes on saying one is not past its deadline,
# when it told Operations. The installer of the build that runs replaces each as soon as it is free itself, whatever the
# others wait for. A server from before this says so only of all of them together. Requests marked immediate or urgent
# replace them with the app at once. The same goes for an update an updater from before this ran, and for install.sh
# server by hand.
#
# It also runs the orchestrator's commands on this computer, as root, while the machine's owner keeps access to it open:
# the machine's keeper writes computer.json {untilSec} and each command as computer/<id>.json {id, command, timeout};
# this answers computer/<id>.out.json {id, exit, output}. It checks untilSec itself before each command.
#
# It also works for the keeper's backups, on the machine that keeps the company's data. The keeper asks for a dump of
# the database with dump.json {id} and seals what it finds in dumps/. To restore a backup the keeper writes restore.json
# {attempt, id, dumpedAt, carry} once restore/<attempt>.sql.gz and restore/<attempt>.env.json are whole. This loads the
# dump into a database of its own, closes the one in use, renames it to hornhoof_before_<stamp> and the loaded one into
# its place, writes the backup's three settings into .env, and starts the company; each step goes to
# restore-status.json. It notes every change in restore-journal.json, with the number the database server knows the
# old database by, so whatever stops it, the next start puts everything back as it was, or goes on when the swap was
# done. The old database is never removed here.
#
# A machine that stopped holding the company's data gives what it held to the company server and is then wiped. Its
# keeper asks with upload.json {id} for every table of its database as CSV, packed into uploads/<id>.tar.gz. The
# company server's keeper takes that file and asks with load.json for it as a database of its own, which this fills
# with the server's own schema and the file's rows, as rows alone. Once the server has it merged and saved, the
# machine's keeper asks with wipe.json {id} for the database, its dumps and the company's secrets to go, step by step.
#
# With HORNHOOF_ROLE=worker it runs on a machine that keeps none of the company's data. There the keeper writes
# request.json for the build the company server runs. This downloads it, says so with the step wait, and installs once
# the keeper passes on the server's word in go.json {id, commit, until}: the request's id, its tag, and the second the
# word ends. It takes no copy of a database and puts none back. With HORNHOOF_HOST_OS=linux it also writes the machine's
# own addresses to addresses.json {at, addresses} once a minute, for the keeper to report.
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
# The revision each installer hears and the note of an update keeps.
UPDATER_REV=2
HEALTH_WAIT="${HORNHOOF_HEALTH_WAIT:-120}"
# How long, in seconds, the server's keeper has to say that the copies promised to wait, that they hold every change
# the database is saved with, and that their slots went before a database is put back.
PROMISE_WAIT="${HORNHOOF_PROMISE_WAIT:-30}"
SETTLE_WAIT="${HORNHOOF_SETTLE_WAIT:-120}"
DROP_WAIT="${HORNHOOF_DROP_WAIT:-60}"
# What a company server's update says of the database besides its step: how many migrations of the new build it has
# not applied, empty when that cannot be told, and whether going back puts the saved database in its place. Both stand
# in every status from the moment the update knows them.
MIGRATIONS=''
RESTORE=''
SAYS_MIGRATIONS=''
# How long this build's updater may take to say it goes on with an update it takes over.
TAKE_OVER_WAIT="${HORNHOOF_TAKE_OVER_WAIT:-60}"
TAKEN_OVER="This build's updater goes on with the update."
# A Docker network as docker network inspect gives it: id|name|project|bridge|internal|subnet,gateway;...
NETWORK_FORMAT='{{.Id}}|{{.Name}}|{{with .Labels}}{{with index . "com.docker.compose.project"}}{{.}}{{end}}{{end}}|{{with .Options}}{{with index . "com.docker.network.bridge.name"}}{{.}}{{end}}{{end}}|{{.Internal}}|{{range .IPAM.Config}}{{with index . "Subnet"}}{{.}}{{end}},{{with index . "Gateway"}}{{.}}{{end}};{{end}}'
KEEP_BACKUPS=3
# How often it looks whether a node is behind, and asks again after a server that gave no answer, in seconds.
NODES_CHECK=30
# How long it leaves the nodes alone after an installer failed or a server said it cannot wait, in seconds.
NODES_RETRY=300
# The look at a worker's nodes that runs now, and whether this run looks once and ends.
NODES_LOOK=''
ONCE=''
# The installer of this updater's own build, which it runs for the nodes of a server on another computer.
INSTALLER="${HORNHOOF_INSTALLER:-/usr/local/share/hornhoof/install.sh}"
# The image commands on the computer run in: the updater's own, which compose names.
COMPUTER_IMAGE="${HORNHOOF_COMPUTER_IMAGE:-$UPDATER_IMAGE:latest}"
# worker: this machine keeps none of the company's data. Its updater follows the company server's build: it downloads
# the build its keeper asks for, waits until the keeper passes on the server's word that it is this machine's turn, and
# installs then. It saves and restores no database, since it has none.
ROLE="${HORNHOOF_ROLE:-}"
# How long a worker waits for its turn, in seconds: a day.
TURN_WAIT="${HORNHOOF_TURN_WAIT:-86400}"
# linux: this reads the machine's own addresses, which only a container on the host's network sees, once a minute.
HOST_OS="${HORNHOOF_HOST_OS:-}"
ADDRESSES_EVERY=60
ADDRESSES_AT=0
# The longest a command on the computer runs, in seconds, and how many characters of its output go back.
COMPUTER_MAX=1800
COMPUTER_OUTPUT=30000
# Where the statements of a restore lie in this image: cutover.sql, carry.sql and adopt.sql.
SQL_DIR="${HORNHOOF_SQL_DIR:-/usr/local/share/hornhoof-updater}"

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
# Set for an installer that may stop the nodes now, with the ones it may stop when the server named them. When to look at
# the nodes next, in seconds since 1970.
NODES_FREE=''
NODES_ONLY=''
NODES_AT=0
NOTE_REV=''
# The restore being run: its attempt, the backup's id and time, the stamp its copies go by, the number the database
# server gives the database that was in use, the db container, why a swap failed, and what was said once already.
R_ATTEMPT=''
R_ID=''
R_DUMPED=''
R_STAMP=''
R_OLD=''
DBC=''
SWAP_LINE=''
JOURNAL_SAID=''
BACK_SAID=''

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
    --arg says "$SAYS_MIGRATIONS" --arg migrations "$MIGRATIONS" --arg restore "$RESTORE" \
    '{id: $id, version: $version, state: $state, step: $step, log: $log, at: $at}
      + (if $says == "" then {} else {migrations: (if $migrations == "" then null else ($migrations | tonumber) end), restore: ($restore == "1")} end)' > "$CONTROL/status.json.new"
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

# The compose project of the server: the one its settings name, else the one compose takes from the folder's name.
compose_project() {
  local project
  project=$(env_value COMPOSE_PROJECT_NAME)
  [ -n "$project" ] || project=$(basename "$SERVER_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  printf '%s' "$project"
}

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

# An id another program gave, which goes into the names of files here.
plain_id() {
  case "$1" in '' | *[!A-Za-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

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

# compose_files <compose file>: FILES is what names that build to compose: its file, and on a machine that joined the
# overlay beside it, which leaves the services that keep data out where no profile turns them on.
compose_files() {
  FILES=(-f "$1")
  if joined && [ -f "${1%compose.yaml}compose.worker.yaml" ]; then FILES+=(-f "${1%compose.yaml}compose.worker.yaml"); fi
}

# The services a compose file names, one per line; none when compose cannot read it.
services_of() {
  compose_files "$1"
  docker compose --project-directory "$SERVER_DIR" "${FILES[@]}" config --services 2> /dev/null || true
}

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
  hand_backup || {
    drop_dump "$ID"
    say "Could not hand the database copy to the keeper for a backup."
  }
}

# How many migrations the database has now; fails when it does not answer.
migrations() {
  local db n
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] && n=$(docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null) && [ -n "$n" ] && printf '%s' "$n" | tr -d ' '
}

# How many migrations the database has, once it answers; empty when it does not within HEALTH_WAIT seconds, as after
# the computer started again.
applied() {
  local i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    if migrations; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
}

# owned <path> <mode>: what this wrote as root becomes the keeper's alone to read and remove. The keeper runs as the
# owner of the control folder.
owned() {
  local owner
  # shellcheck disable=SC2012 # the owner and the group as numbers, which BusyBox and macOS print alike
  owner=$(ls -nd "$CONTROL" | awk '{ print $3 ":" $4 }')
  chmod "$2" "$1" && chown "$owner" "$1"
}

# The folder the keeper takes dumps of the database from, and seals each into a backup: <id>.sql.gz, and <id>.json
# {id, reason, at, migrations}, or <id>.failed with a line.
dumps_dir() { mkdir -p "$CONTROL/dumps" && owned "$CONTROL/dumps" 700; }

# dump_said <id> <reason> <migrations>: written after the dump, so it says the dump is whole.
dump_said() {
  local file="$CONTROL/dumps/$1.json"
  case "$3" in '' | *[!0-9]*) return 1 ;; esac
  (umask 077 && jq -n --arg id "$1" --arg reason "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson migrations "$3" \
    '{id: $id, reason: $reason, at: $at, migrations: $migrations}' > "$file.new") && owned "$file.new" 600 && mv "$file.new" "$file"
}

# drop_dump <id>: whatever a dump that was not finished left.
drop_dump() { rm -f "$CONTROL/dumps/$1.sql.gz.part" "$CONTROL/dumps/$1.sql.gz" "$CONTROL/dumps/$1.json.new" "$CONTROL/dumps/$1.json"; }

# The copy taken before an update goes to the keeper too, under the update's id.
hand_backup() {
  local file="$CONTROL/dumps/$ID.sql.gz"
  dumps_dir && (umask 077 && cp "$BACKUP" "$file.part") && owned "$file.part" 600 && mv "$file.part" "$file" && dump_said "$ID" update "$BEFORE"
}

# make_dump <id> <db container>: the database as it is now, for the keeper.
make_dump() {
  local file="$CONTROL/dumps/$1.sql.gz" n
  dumps_dir && n=$(migrations) || return 1
  (umask 077 && docker exec "$2" pg_dump -U hornhoof -d hornhoof | gzip > "$file.part") || return 1
  owned "$file.part" 600 && mv "$file.part" "$file" && dump_said "$1" timer "$n"
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
  local file="$CONTROL/dumps/$1.sql.gz" n
  dumps_dir || return 1
  docker exec "$2" psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE \"$3\" WITH ALLOW_CONNECTIONS true" > /dev/null 2>&1 || return 1
  n=$(docker exec "$2" psql -U hornhoof -d "$3" -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null | tr -d ' ') || return 1
  (umask 077 && docker exec "$2" pg_dump -U hornhoof -d "$3" | gzip > "$file.part") || return 1
  owned "$file.part" 600 && mv "$file.part" "$file" && dump_said "$1" fork "$n"
}

# dump_failed <id> [line]: nothing of the dump stays, and the keeper reads why.
dump_failed() {
  local file="$CONTROL/dumps/$1.failed"
  drop_dump "$1"
  dumps_dir && (umask 077 && printf '%s\n' "${2:-The database could not be dumped.}" > "$file.new") && owned "$file.new" 600 && mv "$file.new" "$file"
}

# The data keeper asks for a dump with dump.json {id}, or with {id, database, reason: "fork"} for a database a restore
# set aside or one made of what a machine uploaded. The keeper of a machine that keeps a copy asks with
# {id, database: "hornhoof", reason: "fork"} for its own database, when that one led the company before. The request goes once the dump is there, whole or failed; a dump that is there is not made again, so the
# keeper asks anew under another id.
dump_request() {
  local id db database reason copy=''
  [ -f "$CONTROL/dump.json" ] || return 0
  [ -n "$SERVER_DIR" ] || return 0
  # A machine that keeps a copy gives one dump alone: its own database, from the time it led, which its keeper saves
  # before the copy is made again. A machine with no database gives none.
  if worker; then
    [ -f "$CONTROL/replica.json" ] || return 0
    copy=1
  fi
  id=$(jq -r '.id // empty' "$CONTROL/dump.json" 2> /dev/null || true)
  plain_id "$id" || return 0
  database=$(jq -r '.database // empty' "$CONTROL/dump.json" 2> /dev/null || true)
  reason=$(jq -r '.reason // empty' "$CONTROL/dump.json" 2> /dev/null || true)
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
# within a day; this does the same for a machine whose keeper makes no backups, or does not run.
sweep_dumps() {
  [ -d "$CONTROL/dumps" ] || return 0
  if [ -n "$(find "$CONTROL/dumps" -type f -mmin +1440 2> /dev/null | head -n 1)" ]; then
    find "$CONTROL/dumps" -type f -mmin +1440 -exec rm -f {} + 2> /dev/null || true
    printf 'Deleted a database dump that was not sealed within a day.\n'
  fi
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
  # A machine that joined also needs the overlay that names what it does not run.
  if joined && ! docker cp "$cid:/app/compose.worker.yaml" "$dir/compose.worker.yaml" > /dev/null; then
    docker rm "$cid" > /dev/null 2>&1 || true
    return 1
  fi
  # A company server counts the migrations the build brings by its journal; a build without one is no failure.
  worker || docker cp "$cid:/app/apps/server/drizzle/meta/_journal.json" "$dir/journal.json" > /dev/null 2>&1 || true
  docker rm "$cid" > /dev/null 2>&1 || true
}

# migrations_to_run <journal> <applied>: how many migrations of the new build the database has not applied; nothing
# when either count cannot be told, or the database has more than the build knows.
migrations_to_run() {
  local known
  known=$(jq -r '.entries | length' "$1" 2> /dev/null || true)
  plain_number "$known" && plain_number "$2" || return 0
  [ "$known" -lt "$2" ] || printf '%s' "$((known - $2))"
}

# keeper_said <file> <field>: a field of the answer the server's keeper left for this very update; fails while there
# is none of this update.
keeper_said() {
  [ "$(jq -r '.id // empty' "$CONTROL/$1" 2> /dev/null || true)" = "$ID" ] || return 1
  jq -r ".$2 // empty" "$CONTROL/$1" 2> /dev/null || true
}

# The machines that keep a copy of the company promise to wait for the update: the server's keeper asks them, and says
# here whether each did. With none promised, or no word of the keeper's, the update ends before anything changed.
promise_copies() {
  local waited=0 ok why
  step promise "Asking the copies to wait for the update."
  while [ "$waited" -lt "$PROMISE_WAIT" ]; do
    if ok=$(keeper_said promised.json ok); then
      [ "$ok" != true ] || return 0
      why=$(keeper_said promised.json why || true)
      stop_with failed "${why:-A machine that keeps a copy did not promise to wait}, so nothing changed."
      return 1
    fi
    waited=$((waited + 1))
    sleep 1
  done
  stop_with failed "The keeper did not answer, so nothing changed."
  return 1
}

# The database is saved only once the keeper said the copies hold every change it is saved with. The step is backup by
# now, so the keeper holds the lease in maintenance and the app's sessions have ended.
settle_wait() {
  local waited=0 ok
  while [ "$waited" -lt "$SETTLE_WAIT" ]; do
    if ok=$(keeper_said settled.json ok); then
      [ "$ok" != true ] || return 0
      break
    fi
    waited=$((waited + 1))
    sleep 1
  done
  stop_with failed "The copies did not confirm the last changes, so nothing changed."
  return 1
}

# Before the saved database is put back, nothing of a copy may hold the one in use: the keeper stops the copies and
# drops their slots, and says so. With or without its word, the updater ends whatever still reads a slot and drops
# every slot itself, again every two seconds, until none is left. Fails when one will not go.
drop_slots() {
  local db waited=0 left
  while [ "$waited" -lt "$DROP_WAIT" ] && ! keeper_said slots-dropped.json ok > /dev/null; do
    waited=$((waited + 1))
    sleep 1
  done
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  waited=0
  while true; do
    left=$(docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM pg_replication_slots' 2> /dev/null | tr -d ' ') || left=''
    [ "$left" != 0 ] || return 0
    [ "$waited" -lt "$DROP_WAIT" ] || return 1
    docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE active_pid IS NOT NULL' > /dev/null 2>&1 || true
    docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE active_pid IS NULL' > /dev/null 2>&1 || true
    waited=$((waited + 2))
    sleep 2
  done
}

# Every image the compose file of the new build names, the update's own by digest, with the server's .env filling in
# the rest. When the node runs that exact image already, compose leaves the node image out.
pull_images() {
  local services=''
  if same_node; then
    services=$(services_without_node "$WORK/$TAG/compose.yaml")
    [ -n "$services" ] || return 1
  fi
  compose_files "$WORK/$TAG/compose.yaml"
  # shellcheck disable=SC2086 # services is a space-separated list of compose service names, or empty for all of them.
  HORNHOOF_VERSION="$TAG" HORNHOOF_APP_REF="$IMAGE@$DIGEST" HORNHOOF_NODE_REF="$(pinned "$NODE_IMAGE" "$NODE_DIGEST")" \
    HORNHOOF_UPDATER_REF="$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")" \
    docker compose --project-directory "$SERVER_DIR" "${FILES[@]}" pull $services >> "$WORK/install.log" 2>&1 || return 1
  # The nodes of a machine that joined are no service of its compose file unless it keeps the data, so their image
  # comes by itself, for the installer to start.
  if joined && [ -n "$NODE_DIGEST" ]; then docker pull "$NODE_IMAGE@$NODE_DIGEST" >> "$WORK/install.log" 2>&1 || return 1; fi
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

# run_installer <tag> <app> <node> <updater>: the installer of that build. It takes as long as it takes: no clock ends it.
run_installer() {
  local tag=$1 dir="$WORK/$1"
  HORNHOOF_CONTROL_DIR="$CONTROL" HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_VERSION="$tag" HORNHOOF_FROM_UPDATER=1 HORNHOOF_UPDATER_REV="$UPDATER_REV" HORNHOOF_COMPOSE_FILE="$dir/compose.yaml" HORNHOOF_PULLED=1 \
    HORNHOOF_APP_REF="$2" HORNHOOF_NODE_REF="$3" HORNHOOF_UPDATER_REF="$4" HORNHOOF_NODES_FREE="$NODES_FREE" HORNHOOF_NODES_ONLY="$NODES_ONLY" bash "$dir/install.sh" "$(install_mode)" >> "$WORK/install.log" 2>&1
}

# What the installer is run as: a server's, or that of a machine that joined.
install_mode() { shape; }

# install <tag> <app> <node> <updater>: runs the installer and the compose file that come inside that app image, and
# they start exactly these images. They are on this computer already: the new build's came before the database was
# saved, and the build from before ran here. Compose downloads only an image that is missing.
install() {
  unpack "$1" "$2" || return 1
  keep_networks "$WORK/$1/compose.yaml" || return 1
  remove_unnamed "$WORK/$1/compose.yaml"
  if worker; then after_nodes_look; fi
  run_installer "$@" || return 1
  drop_orphans
}

# keep_networks <compose file>: a build from before compose files named the networks' subnets would make the networks
# again, as compose takes those made with subnets for changed, and it cannot while this updater is on them. Its file
# takes the networks as the one in the server folder names them, which that build runs on as on its own.
keep_networks() {
  local now="$SERVER_DIR/compose.yaml"
  grep -q 'HORNHOOF_SUBNET' "$now" 2> /dev/null || return 0
  ! grep -q 'HORNHOOF_SUBNET' "$1" || return 0
  awk '
    FNR == 1 { file++ }
    /^[^[:space:]]/ { inside = /^networks:/ }
    file == 1 { if (inside) kept = kept $0 "\n"; next }
    !inside { print }
    END { printf "%s", kept }' "$now" "$1" > "$1.new" && mv "$1.new" "$1"
}

# The installer of a build starts only the services it knows, so after going back to a build from before a service,
# as the tunnel, that service's container would run on, carrying the public link to a server that knows nothing of
# it. compose removes the containers of services its file does not name; db runs already, so nothing else changes. A
# file without the updater would take this updater for one of them, so then nothing goes.
drop_orphans() {
  local runs=db
  # A worker has no db: its keeper runs already, and naming it starts nothing else.
  if worker; then runs=keeper; fi
  if names_service "$SERVER_DIR/compose.yaml" updater; then
    compose up -d --no-build --remove-orphans "$runs" >> "$WORK/install.log" 2>&1 || say "Could not remove the containers that $SERVER_DIR/compose.yaml no longer names."
  fi
}

# Where the server takes the updater's word of the nodes: the same place its health is asked.
nodes_url() {
  local health
  health=$(health_url)
  printf '%s/api/nodes/update' "${health%/api/health}"
}

# Where the build that runs now answers. On a machine that does not lead, its keeper says so: its front door leads to
# another machine's app. On the one that leads, the app does, at front when the compose file its installer copied here
# names it; the address a joined machine's settings name is its keeper's, from the time it did not lead.
health_url() {
  if worker; then
    printf '%s' "${HORNHOOF_HEALTH_URL:-http://keeper:7080/api/keeper}"
  elif [ -n "${HORNHOOF_HEALTH_URL:-}" ] && ! joined; then
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

# The image of the container this updater runs in, which Docker names after the container's host name; else the one
# the settings name for it; nothing when neither is known.
own_image() {
  local image
  image=$(docker inspect --format '{{.Config.Image}}' "$(hostname)" 2> /dev/null || true)
  [ -n "$image" ] || image=$(env_value HORNHOOF_UPDATER_REF)
  printf '%s' "$image"
}

# swap_updater <image>: a new updater takes over from a helper container that outlives this one. Both run that image:
# the updater image of an update, which .env names for compose too, or this updater's own when only its settings changed.
swap_updater() {
  local image=$1
  [ -n "$image" ] || return 0
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
  read_kind
  TAG=$tag
  DIGEST=$digest
  NODE_DIGEST=$node
  UPDATER_DIGEST=$updater
  TARGET=''
  BEFORE=''
  BACKUP=''
  MIGRATIONS=''
  RESTORE=''
  SAYS_MIGRATIONS=''

  # The build to go back to: the one running now, by its commit, or the one .env pins; and the images it runs, by the
  # digests Docker keeps for them, or by that build's tag.
  PREVIOUS=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(compose ps -q "$(main_service)" 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$PREVIOUS" ] || PREVIOUS=$(env_value HORNHOOF_VERSION)
  [ -n "$PREVIOUS" ] || PREVIOUS=latest
  BACK_APP=$(running "$(main_service)" "$IMAGE")
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

  if worker; then
    wait_turn || return 0
    step install "Installing $VERSION."
    install_new
    return 0
  fi
  BEFORE=$(applied)
  MIGRATIONS=$(migrations_to_run "$WORK/$TAG/journal.json" "$BEFORE")
  SAYS_MIGRATIONS=1
  promise_copies || return 0
  save_and_install
}

# The database is saved, once the copies hold every change it is saved with, and the new build goes in.
save_and_install() {
  step backup "Saving the database."
  settle_wait || return 0
  backup || {
    stop_with failed "Could not save the database, so nothing changed."
    return 0
  }
  note
  step install "Installing $VERSION."
  install_new
}

# Whether the keeper passed on the company server's word for this very request, and the word still stands.
told_to_go() {
  local id commit until
  id=$(jq -r '.id // empty' "$CONTROL/go.json" 2> /dev/null || true)
  commit=$(jq -r '.commit // empty' "$CONTROL/go.json" 2> /dev/null || true)
  until=$(jq -r '.until // 0 | floor' "$CONTROL/go.json" 2> /dev/null || true)
  case "$until" in '' | *[!0-9]*) return 1 ;; esac
  [ "$id" = "$ID" ] && [ "$commit" = "$TAG" ] && [ "$until" -gt "$(date +%s)" ]
}

# A worker installs only in its turn, so the company's machines go one at a time and none while a turn runs on it. The
# build is here already. A word left from before this wait is for another request and goes first. The wait ends with
# the word, with a newer request, which the next pass takes, or after a day.
wait_turn() {
  local waited=0
  rm -f "$CONTROL/go.json"
  step wait "Waiting for its turn to install."
  while true; do
    if told_to_go; then return 0; fi
    if [ "$(jq -r '.id // empty' "$CONTROL/request.json" 2> /dev/null || true)" != "$ID" ]; then
      stop_with failed "A newer build came first, so this one was left." finished
      return 1
    fi
    if [ "$waited" -ge "$TURN_WAIT" ]; then
      stop_with failed "The company server did not give this machine its turn within a day." finished
      return 1
    fi
    waited=$((waited + 2))
    sleep 2
  done
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

manual_subnet_heal_command() {
  local project=$1 base suffix
  if joined; then
    printf 'the Hornhoof install command (or HORNHOOF_SERVER_DIR=%s install.sh worker)' "$SERVER_DIR"
    return 0
  fi
  case "$project" in
    hornhoof-?*)
      suffix=${project#hornhoof-}
      base=$(basename "$SERVER_DIR")
      if [ "$base" = "hornhoof-$suffix" ]; then
        printf 'install.sh server --name %s in %s' "$suffix" "$SERVER_DIR"
        return 0
      fi
      ;;
  esac
  printf 'install.sh server in %s' "$SERVER_DIR"
}

warn_subnet_overlap() {
  local relayed addrs ids nets project hits sub host cmd
  if [ -n "$WORK" ] && [ -f "$WORK/install.log" ]; then
    relayed=$(grep "^Docker network .* overlaps this computer's network" "$WORK/install.log" 2> /dev/null || true)
    if [ -n "$relayed" ]; then
      while IFS= read -r sub; do
        [ -n "$sub" ] && say "$sub"
      done <<< "$relayed"
      return 0
    fi
  fi
  [ -n "$SERVER_DIR" ] || return 0
  addrs=$(
    {
      env_value HORNHOOF_ADDRESSES | tr ',' '\n'
      if [ -f "$CONTROL/addresses.json" ]; then jq -r '.addresses[]? // empty' "$CONTROL/addresses.json" 2> /dev/null || true; fi
    } | awk 'NF'
  )
  [ -n "$addrs" ] || return 0
  ids=$(docker network ls -q 2> /dev/null || true)
  [ -n "$ids" ] || return 0
  project=$(compose_project)
  [ -n "$project" ] || return 0
  # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per network
  nets=$(docker network inspect --format "$NETWORK_FORMAT" $ids 2> /dev/null || true)
  [ -n "$nets" ] || return 0
  hits=$(
    {
      printf '%s\n' "$addrs"
      printf -- '---\n'
      printf '%s\n' "$nets"
    } | awk -v project="$project" '
      function parse_range(tok,    slash, ip_part, p, n, oct, i, v, ip, size) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", tok)
        if (tok == "" || tok == "default") return 0
        slash = index(tok, "/")
        if (slash > 0) {
          ip_part = substr(tok, 1, slash - 1)
          p = substr(tok, slash + 1)
          if (p !~ /^[0-9]+$/) return 0
          p += 0
        } else {
          ip_part = tok
          p = -1
        }
        n = split(ip_part, oct, ".")
        if (n < 1 || n > 4) return 0
        for (i = 1; i <= n; i++) {
          if (oct[i] !~ /^[0-9]+$/) return 0
          v = oct[i] + 0
          if (v < 0 || v > 255) return 0
          oct[i] = v
        }
        for (i = n + 1; i <= 4; i++) oct[i] = 0
        if (oct[1] == 127 || oct[1] == 0 || oct[1] >= 224) return 0
        if (p < 0) p = n * 8
        if (p < 4 || p > 32) return 0
        ip = ((oct[1] * 256 + oct[2]) * 256 + oct[3]) * 256 + oct[4]
        size = 2 ^ (32 - p)
        R_START = int(ip / size) * size
        R_END = R_START + size - 1
        return 1
      }
      $0 == "---" { net_mode = 1; next }
      !net_mode {
        for (k = 1; k <= NF; k++) {
          if (parse_range($k)) {
            h_tok[++nh] = $k
            h_start[nh] = R_START
            h_end[nh] = R_END
          }
        }
        next
      }
      net_mode && NF {
        split($0, f, "|")
        if (f[3] != project && f[2] != (project "_default") && f[2] != (project "_internal")) next
        n = split(f[6], items, ";")
        for (i = 1; i <= n; i++) {
          if (items[i] == "") continue
          split(items[i], sg, ",")
          cidr = sg[1]
          if (cidr == "" || seen[cidr]++ || !parse_range(cidr)) continue
          s = R_START; e = R_END
          for (j = 1; j <= nh; j++) {
            if (s <= h_end[j] && h_start[j] <= e) {
              print cidr " " h_tok[j]
              break
            }
          }
        }
      }
    '
  ) || true
  [ -n "$hits" ] || return 0
  cmd=$(manual_subnet_heal_command "$project")
  while IFS=' ' read -r sub host; do
    [ -n "$sub" ] || continue
    say "Docker network $sub in $SERVER_DIR overlaps this computer's network ($host), and an automatic update cannot recreate the network it runs on. Run $cmd on this computer once to move it to a free subnet."
  done <<< "$hits"
}

check_new() {
  step health "Waiting for the new server to answer."
  if healthy "$TARGET"; then
    warn_subnet_overlap
    stop_with "done" "Hornhoof runs $VERSION now." finished
    swap_updater "$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")"
    return 0
  fi
  say "$VERSION did not answer within $HEALTH_WAIT seconds."
  go_back
}

go_back() {
  local back="Hornhoof runs the build from before the update again. The database was saved before it."
  # A worker has no database to put back.
  if worker; then back="This machine runs the build from before the update again."; fi
  step rollback "Going back to $PREVIOUS."
  if ! worker && [ "$(applied)" != "$BEFORE" ]; then
    say "$VERSION changed the database, so it goes back to the copy saved before the update."
    RESTORE=1
    SAYS_MIGRATIONS=1
    write_status running rollback
    drop_slots || {
      stop_with failed "Could not drop the copies' slots, so the database was not put back. Run install.sh server in $SERVER_DIR, and see docker compose logs keeper." finished
      return 0
    }
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
  forget_kind
}

update_running() { [ "$(jq -r '.state // empty' "$CONTROL/status.json" 2> /dev/null || true)" = running ]; }

# The update under way, as status.json says it.
read_status() {
  ID=$(jq -r '.id // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9-')
  VERSION=$(jq -r '.version // empty' "$CONTROL/status.json" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  STEP=$(jq -r '.step // empty' "$CONTROL/status.json")
  LOG="$(jq -r '.log // empty' "$CONTROL/status.json")
"
  # What it said of the database, when it had said anything: an update of an updater from before says nothing.
  SAYS_MIGRATIONS=$(jq -r 'if has("migrations") then "1" else "" end' "$CONTROL/status.json" 2> /dev/null || true)
  MIGRATIONS=$(jq -r '.migrations // empty | tostring' "$CONTROL/status.json" 2> /dev/null | tr -cd '0-9' || true)
  RESTORE=$(jq -r 'if .restore == true then "1" else "" end' "$CONTROL/status.json" 2> /dev/null || true)
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
    # Stopped at the dump of an update that asked the copies: no migration ran yet, and the keeper's word about the
    # dump stands, since the step never left backup. It goes on from there, with nothing downloaded or asked again.
    backup)
      if [ -n "$SAYS_MIGRATIONS" ]; then
        BEFORE=$(applied)
        save_and_install
      else
        update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST"
      fi
      ;;
    pull | promise | wait) update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST" ;;
    install)
      step install "Installing $VERSION."
      install_new
      ;;
    health) check_new ;;
    *) go_back ;;
  esac
}

# An update this updater was stopped in, or was handed by an older one, goes on by the note of it. A restore it was
# stopped in goes first.
interrupted() {
  if ! worker && [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ]; then restore_left || true; fi
  update_running || return 0
  read_status
  if ! recall; then
    forget_kind
    stop_with failed "The updater stopped during the update. Check that Hornhoof answers, then try again."
    return 0
  fi
  WORK=$(mktemp -d)
  if handed_over; then go_on_handed_over; else go_on; fi
  rm -rf "$WORK"
  WORK=''
  NODES_FREE=''
  forget_kind
}

# psql_on <database> <arguments>: psql in the db container, which stops at the first statement that fails.
psql_on() {
  local name=$1
  shift
  docker exec "$DBC" psql -U hornhoof -d "$name" -v ON_ERROR_STOP=1 -q "$@"
}

# psql_alone <database> <psql arguments>: the same for what a restore does from the moment it closes the database in
# use. The copy commits wait for loses its connection there with every other session, and no copy follows these
# statements, so each is committed here alone: left to wait for that copy, the restore would stand still for good.
psql_alone() {
  local name=$1
  shift
  psql_on "$name" -c 'SET synchronous_commit = local' "$@"
}

# The databases of Hornhoof there are now, as words; fails when the database server does not say.
db_names() { psql_on postgres -tAc "SELECT COALESCE(string_agg(datname, ' '), '') FROM pg_database WHERE datname LIKE 'hornhoof%'" 2> /dev/null; }

# The stamp a restore's copies go by, as this wrote it: digits and a line, so the name of a database made of it is
# the same however the database server folds letters.
plain_stamp() {
  case "$1" in '' | *[!0-9_]*) return 1 ;; esac
  [ "${#1}" -eq 15 ]
}

plain_number() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }

# The number of the database named hornhoof now. A database keeps its number under every name, so the one that was in
# use is told by it for good.
number_in_use() { psql_on postgres -tAc "SELECT oid FROM pg_database WHERE datname = 'hornhoof'" 2> /dev/null; }

# restore_says <state> <step> <line> [kept]: restore-status.json, written whole and then moved. dumpedAt: from when the
# restored database is, as the order has it; the app marks the restore by it once the order is gone.
restore_says() {
  printf '%s\n' "$3"
  jq -n --arg attempt "$R_ATTEMPT" --arg id "$R_ID" --arg state "$1" --arg step "$2" --arg line "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg kept "${4:-}" --arg dumped "$R_DUMPED" \
    '{attempt: $attempt, id: $id, state: $state, step: $step, line: $line, at: $at, kept: (if $kept == "" then null else $kept end)} + (if $dumped == "" then {} else {dumpedAt: $dumped} end)' > "$CONTROL/restore-status.json.new"
  mv "$CONTROL/restore-status.json.new" "$CONTROL/restore-status.json"
}

# restore_ended <state> <step> <line> [kept]: the last word of a restore; its order and its journal go.
restore_ended() {
  restore_says "$@"
  rm -f "$CONTROL/restore-journal.json" "$CONTROL/restore.json"
}

# journal <change>: the last change a restore made, written whole and then moved, so a start after any stop knows what
# to put back.
journal() {
  jq -n --arg attempt "$R_ATTEMPT" --arg id "$R_ID" --arg dumped "$R_DUMPED" --arg stamp "$R_STAMP" --arg old "$R_OLD" --arg did "$1" \
    '{attempt: $attempt, id: $id, dumpedAt: $dumped, stamp: $stamp, old: $old, did: $did}' > "$CONTROL/restore-journal.json.new" && mv "$CONTROL/restore-journal.json.new" "$CONTROL/restore-journal.json"
}

# The dump and the settings a restore was given in the clear go in every outcome.
restore_wipe() { rm -f "$CONTROL/restore/$R_ATTEMPT.sql.gz" "$CONTROL/restore/$R_ATTEMPT.env.json"; }

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

# setting <name> <file>: one of the three settings a backup carries, as the file has it; nothing when it has none. It
# fails for a value that cannot stand in .env as it is, so none with a control character, a space, a quote, # or $
# passes. The value never goes on a command line.
setting() {
  local value re
  value=$(jq -r --arg name "$1" '.[$name] // "" | if type == "string" then . else "?" end' "$2" 2> /dev/null && printf x) || return 1
  # What jq printed, less the line end it added: a value that ends with one of its own keeps it, and does not pass.
  value=${value%x}
  value=${value%$'\n'}
  [ -n "$value" ] || return 0
  case "$1" in
    HORNHOOF_SECRET) re='^[A-Za-z0-9+/]{43}=$' ;;
    NODE_KEY) re='^[A-Za-z0-9+/=_-]{32,200}$' ;;
    RELAY_URL) re='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' ;;
    *) return 1 ;;
  esac
  [[ "$value" =~ $re ]] || return 1
  printf '%s' "$value"
}

# as_env <file>: the file becomes the server's settings, with the owner the settings have and for that owner alone.
as_env() {
  local owner
  # shellcheck disable=SC2012 # the owner and the group as numbers, which BusyBox and macOS print alike
  owner=$(ls -n "$SERVER_DIR/.env" | awk '{ print $3 ":" $4 }')
  chown "$owner" "$1" && chmod 600 "$1" && mv "$1" "$SERVER_DIR/.env"
}

# write_env <secret> <node key> <relay>: .env with those over their lines, or added, and every other line as it was.
# An empty one leaves its line as it is.
write_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && NEW_SECRET="$1" NEW_NODE_KEY="$2" NEW_RELAY="$3" awk '
    BEGIN { new["HORNHOOF_SECRET"] = ENVIRON["NEW_SECRET"]; new["NODE_KEY"] = ENVIRON["NEW_NODE_KEY"]; new["RELAY_URL"] = ENVIRON["NEW_RELAY"] }
    {
      name = $0
      sub(/=.*/, "", name)
      if (index($0, "=") > 0 && (name in new) && new[name] != "") {
        if (!(name in put)) print name "=" new[name]
        put[name] = 1
        next
      }
      print
    }
    END {
      if (new["HORNHOOF_SECRET"] != "" && !("HORNHOOF_SECRET" in put)) print "HORNHOOF_SECRET=" new["HORNHOOF_SECRET"]
      if (new["NODE_KEY"] != "" && !("NODE_KEY" in put)) print "NODE_KEY=" new["NODE_KEY"]
      if (new["RELAY_URL"] != "" && !("RELAY_URL" in put)) print "RELAY_URL=" new["RELAY_URL"]
    }' "$file" > "$file.new") && as_env "$file.new"
}

# put_env <name>: .env with the line of that name saying PUT_VALUE, or with the line added, and every other line as it
# was. The value comes by the environment, so it stands on no command line.
put_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && PUT_NAME="$1" awk '
    BEGIN { name = ENVIRON["PUT_NAME"]; value = ENVIRON["PUT_VALUE"] }
    index($0, name "=") == 1 { if (!put) print name "=" value; put = 1; next }
    { print }
    END { if (!put) print name "=" value }' "$file" > "$file.new") && as_env "$file.new"
}

# drop_env <name>...: .env without the lines of those names, and every other line as it was.
drop_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && DROP_NAMES=" $* " awk '
    BEGIN { names = ENVIRON["DROP_NAMES"] }
    { name = $0; sub(/=.*/, "", name); if (index(names, " " name " ") == 0) print }' "$file" > "$file.new") && as_env "$file.new"
}

# A password for this machine's own database: 24 letters and digits.
new_password() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24; }

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
  (umask 077 && printf "The company's settings cannot be written here, so this machine stays a worker.\n" > "$CONTROL/role.failed.new") &&
    owned "$CONTROL/role.failed.new" 600 && mv "$CONTROL/role.failed.new" "$CONTROL/role.failed" || true
  say "This machine stays a worker: could not $1."
}

# The settings a copy needs go into .env: the company's three, each checked as a backup's are, a password for its own
# database when it has none, and the role and the profiles that start the database, the app and this machine's own
# built-in node. No value is said.
data_settings() {
  local from="$CONTROL/role-secrets.json" secret node_key relay
  (umask 077 && jq '.secrets // {}' "$CONTROL/role.json" > "$from" 2> /dev/null) || return 1
  secret=$(setting HORNHOOF_SECRET "$from") && node_key=$(setting NODE_KEY "$from") && relay=$(setting RELAY_URL "$from") || return 1
  [ -n "$secret" ] && [ -n "$relay" ] || return 1
  write_env "$secret" "$node_key" "$relay" || return 1
  if [ -z "$(env_value POSTGRES_PASSWORD)" ]; then PUT_VALUE=$(new_password) put_env POSTGRES_PASSWORD || return 1; fi
  PUT_VALUE=data put_env HORNHOOF_ROLE && PUT_VALUE=data,builtin put_env COMPOSE_PROFILES
}

# The keeper of a worker that the company server gave the data left role.json {id, secrets}: this machine becomes one
# that keeps a copy. The settings of before stay beside the new ones until everything runs, so an updater that stopped
# in the middle finishes or undoes it.
become_data() {
  [ -f "$CONTROL/role.json" ] || return 0
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  (umask 077 && cp "$SERVER_DIR/.env" "$SERVER_DIR/.env.before-data") || { stay_worker 'keep its settings of before'; return 0; }
  data_settings || { rm -f "$CONTROL/role-secrets.json"; stay_worker "write the company's settings"; return 0; }
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

# A name of a database, and a count from 1, as a request of the keeper may hold them: nothing else goes on a command line.
plain_database() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
}
plain_count() {
  [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]]
}

# load_schema <attempt> <database> <port>: the leader's schema, and the count of its migrations, read through the
# keeper's door as the role that only reads, and loaded into that database here in one piece. It prints why it could
# not. The password is read from the request into this one command's environment: it stands on no command line and in
# no line said, and goes on into the file the copy's subscription reads it from, in the database's own folder.
load_schema() {
  local attempt=$1 database=$2 port=$3 request="$CONTROL/schema.json" db tables dump
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || { printf "This machine's database does not run."; return 1; }
  tables=$(docker exec "$db" psql -U hornhoof -d "$database" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2> /dev/null) ||
    { printf "This machine's database could not be asked."; return 1; }
  [ "$tables" = 0 ] || { printf 'The database is not empty.'; return 1; }
  dump="$CONTROL/schema/$attempt.sql"
  (
    umask 077
    PGPASSWORD=$(jq -r '.password // empty' "$request" 2> /dev/null) || exit 1
    export PGPASSWORD
    docker exec -e PGPASSWORD "$db" pg_dump -h keeper -p "$port" -U hornhoof_replica --schema-only --no-owner --no-publications --no-subscriptions --no-privileges hornhoof > "$dump" 2> /dev/null &&
      docker exec -e PGPASSWORD "$db" pg_dump -h keeper -p "$port" -U hornhoof_replica --data-only --table=drizzle.__drizzle_migrations hornhoof >> "$dump" 2> /dev/null &&
      # The schema comes with no rights, since the leader's roles are not this machine's. A function is open to
      # everyone until it is closed, and a keeper leads on no database whose network functions are: they are closed
      # as the leader's own migration closes them, so a copy that takes the server over may lead.
      printf '%s\n' 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC;' >> "$dump"
  ) || { rm -f "$dump"; printf "The company server's schema could not be read."; return 1; }
  docker exec -i "$db" psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d "$database" < "$dump" > /dev/null 2>&1 ||
    { rm -f "$dump"; printf 'The schema could not be loaded into the database.'; return 1; }
  rm -f "$dump"
  write_passfile "$db" || { printf "The password file of the copy could not be written."; return 1; }
}

# write_passfile: the password of the role that only reads, from the request, into the file the copy's subscription
# reads it from, in the database's own folder. It stands on no command line and in no line said.
write_passfile() {
  local db=$1 request="$CONTROL/schema.json"
  # shellcheck disable=SC2016 # PGDATA is the database container's own, read there.
  jq -r '"*:*:*:hornhoof_replica:" + (.password // "")' "$request" 2> /dev/null |
    docker exec -i -u postgres "$db" sh -c 'umask 077 && cat > "$PGDATA/replica.pgpass"' > /dev/null 2>&1
}

# passfile_alone: for a copy that joins a slot of the leader's and holds every table already. It prints why it could
# not.
passfile_alone() {
  local db
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || { printf "This machine's database does not run."; return 1; }
  write_passfile "$db" || { printf "The password file of the copy could not be written."; return 1; }
}

# The keeper of a machine that keeps a copy asks, with schema.json {attempt, database, port, password}, for the leader's
# schema in a database of this machine: the copy then fills it by itself. This answers in schema/<attempt>.done, or
# .failed with a line, and removes the request. A request that names what no database, port or attempt is called is
# dropped. With only: "passfile" it asks for the password file alone, whatever was answered under that attempt before:
# a copy that joins the slot a new leader made for it holds its tables already.
schema_request() {
  local request="$CONTROL/schema.json" attempt database port only reason
  [ -f "$request" ] || return 0
  [ -n "$SERVER_DIR" ] || return 0
  attempt=$(jq -r '.attempt // empty | tostring' "$request" 2> /dev/null || true)
  database=$(jq -r '.database // empty | tostring' "$request" 2> /dev/null || true)
  port=$(jq -r '.port // empty | tostring' "$request" 2> /dev/null || true)
  only=$(jq -r '.only // empty | tostring' "$request" 2> /dev/null || true)
  if ! plain_count "$attempt" || ! plain_database "$database" || ! plain_count "$port" || { [ -n "$only" ] && [ "$only" != passfile ]; }; then
    rm -f "$request"
    return 0
  fi
  if [ "$only" = passfile ]; then
    mkdir -p "$CONTROL/schema" && owned "$CONTROL/schema" 700 || return 0
    rm -f "$CONTROL/schema/$attempt.done" "$CONTROL/schema/$attempt.failed"
  elif [ -f "$CONTROL/schema/$attempt.done" ] || [ -f "$CONTROL/schema/$attempt.failed" ]; then
    rm -f "$request"
    return 0
  fi
  mkdir -p "$CONTROL/schema" && owned "$CONTROL/schema" 700 || return 0
  if reason=$(if [ "$only" = passfile ]; then passfile_alone; else load_schema "$attempt" "$database" "$port"; fi); then
    (umask 077 && : > "$CONTROL/schema/$attempt.done") && owned "$CONTROL/schema/$attempt.done" 600 || true
  else
    (umask 077 && printf '%s\n' "$reason" > "$CONTROL/schema/$attempt.failed") && owned "$CONTROL/schema/$attempt.failed" 600 || true
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
uploads_dir() { mkdir -p "$CONTROL/uploads" && owned "$CONTROL/uploads" 700; }

# upload_said <name> <done | failed> [line]: how an upload, or its load, ended, for the keeper alone to read.
upload_said() {
  local file="$CONTROL/uploads/$1.$2"
  (umask 077 && printf '%s' "${3:+$3
}" > "$file") && owned "$file" 600
}

# make_upload <id> <db container>: every table of the company's three schemas in the database in use here, as CSV with
# its header, one file a table, in one packed file for the keeper to send. UPLOAD_WHY says why it could not.
UPLOAD_WHY=''
make_upload() {
  local id=$1 db=$2 dir="$CONTROL/uploads/$1.tables" file="$CONTROL/uploads/$1.tar.gz" tables table names=''
  rm -rf "$dir" "$file.part"
  UPLOAD_WHY='The folder for the upload could not be made.'
  (umask 077 && mkdir "$dir") || return 1
  UPLOAD_WHY="This machine's database could not be asked."
  tables=$(docker exec "$db" psql -U hornhoof -d hornhoof -At -c "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'net', 'net_local') ORDER BY 1" 2> /dev/null) &&
    [ -n "$tables" ] || return 1
  UPLOAD_WHY='A table could not be read.'
  for table in $tables; do
    plain_table "$table" || return 1
    (umask 077 && docker exec "$db" psql -U hornhoof -d hornhoof -v ON_ERROR_STOP=1 -q -c "COPY $(quoted_table "$table") TO STDOUT (FORMAT csv, HEADER true)" > "$dir/$table.csv" 2> /dev/null) || return 1
    names="$names $table.csv"
  done
  UPLOAD_WHY='The upload could not be packed.'
  # shellcheck disable=SC2086 # names is a list of file names made of checked table names.
  (umask 077 && tar -czf "$file.part" -C "$dir" $names 2> /dev/null) && owned "$file.part" 600 && mv "$file.part" "$file" || return 1
  rm -rf "$dir"
}

# The keeper of a machine that stopped holding the company's data asks, with upload.json {id}, for everything its
# database holds, to send it to the company server. This answers in uploads/<id>.done beside uploads/<id>.tar.gz, or
# in .failed with a line, and removes the request. Only a machine that keeps a copy makes one.
upload_request() {
  local request="$CONTROL/upload.json" id db
  [ -f "$request" ] || return 0
  [ -n "$SERVER_DIR" ] && [ -f "$CONTROL/replica.json" ] || return 0
  id=$(jq -r '.id // empty | tostring' "$request" 2> /dev/null || true)
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
    rm -rf "$CONTROL/uploads/$id.tables" "$CONTROL/uploads/$id.tar.gz.part" "$CONTROL/uploads/$id.tar.gz"
    upload_said "$id" failed "$UPLOAD_WHY" || true
    say "Could not make the upload of this machine's copy: $UPLOAD_WHY"
  fi
  rm -f "$request"
}

# unpack_upload <file> <folder> <most bytes>: the files of an upload, each the rows of one table and nothing else: no
# other name, no folder, no link, and no more than it may unpack to.
unpack_upload() {
  local file=$1 dir=$2 max=$3 n names name
  UPLOAD_WHY='The folder to unpack the upload in could not be made.'
  rm -rf "$dir"
  (umask 077 && mkdir "$dir") || return 1
  UPLOAD_WHY='The upload unpacks to more than it may.'
  n=$( (gunzip -c "$file" 2> /dev/null || true) | head -c "$((max + 1))" | wc -c | tr -d ' ')
  [ "$n" -le "$max" ] || return 1
  UPLOAD_WHY='The upload cannot be read.'
  names=$(tar -tzf "$file" 2> /dev/null) && [ -n "$names" ] || return 1
  UPLOAD_WHY='The upload holds a file that is no table of the company.'
  while IFS= read -r name; do
    plain_table "${name%.csv}" && [ "$name" != "${name%.csv}" ] || return 1
  done <<< "$names"
  UPLOAD_WHY='The upload cannot be read.'
  (umask 077 && tar -xzf "$file" -C "$dir" 2> /dev/null) || return 1
  UPLOAD_WHY='The upload holds what is no file.'
  [ -z "$(find "$dir" -mindepth 1 ! -type f 2> /dev/null; find "$dir" -type f -links +1 2> /dev/null)" ]
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

# load_upload <file> <database> <most bytes unpacked>: what a machine uploaded becomes a database of this server, under
# another name until it is whole: this server's own schema, and each file as the rows of its table, with no trigger
# run. No statement of the machine's runs: its bytes reach the database only as rows. UPLOAD_WHY says why it could not.
load_upload() {
  local file=$1 database=$2 max=$3 loading="hornhoof_uploading_${2#hornhoof_upload_}" dir="$CONTROL/uploads/loading" schema="$CONTROL/uploads/loading.sql"
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
  local request="$CONTROL/load.json" file database max name old ok=''
  [ -f "$request" ] || return 0
  if worker || [ -z "$SERVER_DIR" ]; then return 0; fi
  file=$(jq -r '.file // empty | tostring' "$request" 2> /dev/null || true)
  database=$(jq -r '.database // empty | tostring' "$request" 2> /dev/null || true)
  max=$(jq -r '.unpackMax // empty | tostring' "$request" 2> /dev/null || true)
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
  UPLOAD_WHY='The request names no database of an upload.'
  if upload_name "$database" && plain_number "$max" && [ "${#max}" -le 15 ] && load_upload "$CONTROL/uploads/$name.tar.gz" "$database" "$max"; then ok=1; fi
  rm -rf "$CONTROL/uploads/loading" "$CONTROL/uploads/loading.sql" "$CONTROL/uploads/$name.tar.gz"
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
      rm -rf "$CONTROL/dumps" "$CONTROL/restore" "$CONTROL/schema" "$CONTROL/uploads" &&
        rm -f "$SERVER_DIR"/backups/hornhoof-*.sql.gz "$SERVER_DIR"/backups/hornhoof-*.tunnel.json "$CONTROL/schema.json" "$CONTROL/dump.json" "$CONTROL/upload.json"
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
  local request="$CONTROL/wipe.json" id step next checked server
  [ -f "$request" ] || return 0
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  id=$(jq -r '.id // empty | tostring' "$request" 2> /dev/null || true)
  if ! plain_id "$id" || { [ -z "$(env_value HORNHOOF_ROLE)" ] && [ ! -f "$CONTROL/replica.json" ]; }; then
    rm -f "$request"
    return 0
  fi
  server=$(jq -r '.server // empty | tostring' "$request" 2> /dev/null || true)
  if [ -z "$(env_value COMPOSE_FILE)" ] && ! company_address "$server"; then
    [ "$WIPE_SAID" = address ] || say "The request to wipe this machine names no address of the company to reach afterwards, so nothing is wiped."
    WIPE_SAID=address
    return 0
  fi
  step=$(jq -r '.step // "check" | tostring' "$request" 2> /dev/null || true)
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
    (umask 077 && jq -n --arg id "$id" --arg step "$step" --arg server "$server" '{id: $id, step: $step} + (if $server == "" then {} else {server: $server} end)' > "$request.new") &&
      owned "$request.new" 600 && mv "$request.new" "$request" || return 0
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
        (umask 077 && jq -n --arg id "$id" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id: $id, at: $at}' > "$CONTROL/wiped.json.new") &&
          owned "$CONTROL/wiped.json.new" 600 && mv "$CONTROL/wiped.json.new" "$CONTROL/wiped.json" || return 0
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
  local file="$CONTROL/restore-carry.json"
  (umask 077 && sed -n 2p "$1" | jq -ce --arg attempt "$R_ATTEMPT" 'select(type == "object") | {attempt: $attempt, carry: .}' > "$file.new") && owned "$file.new" 600 && mv "$file.new" "$file"
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
  local env="$CONTROL/restore/$R_ATTEMPT.env.json" out="$WORK/cutover.out" secret node_key relay term machine cluster
  SWAP_LINE="The backup's settings cannot be written, so nothing changed."
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
  local file="$CONTROL/restore-journal.json" status="$CONTROL/restore-status.json" did step
  if [ -f "$file" ]; then
    R_ATTEMPT=$(jq -r '.attempt // empty' "$file" 2> /dev/null || true)
    R_ID=$(jq -r '.id // empty' "$file" 2> /dev/null || true)
    R_DUMPED=$(jq -r '.dumpedAt // empty' "$file" 2> /dev/null | tr -cd '0-9A-Za-z:.+-' | cut -c1-40 || true)
    R_STAMP=$(jq -r '.stamp // empty' "$file" 2> /dev/null || true)
    R_OLD=$(jq -r '.old // empty' "$file" 2> /dev/null || true)
    did=$(jq -r '.did // empty' "$file" 2> /dev/null || true)
    if ! plain_id "$R_ATTEMPT" || ! plain_id "$R_ID" || ! plain_stamp "$R_STAMP" || ! plain_number "$R_OLD"; then
      [ -n "$JOURNAL_SAID" ] || printf 'restore-journal.json cannot be read, so the restore it is of stays as it is.\n'
      JOURNAL_SAID=1
      return 0
    fi
  else
    [ "$(jq -r '.state // empty' "$status" 2> /dev/null || true)" = running ] || return 1
    step=$(jq -r '.step // empty' "$status" 2> /dev/null || true)
    case "$step" in load | swap) ;; *) return 1 ;; esac
    R_ATTEMPT=$(jq -r '.attempt // empty' "$status" 2> /dev/null || true)
    R_ID=$(jq -r '.id // empty' "$status" 2> /dev/null || true)
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

# restore_run <with carry>: load, swap, start.
restore_run() {
  restore_says running load 'Loading the backup.'
  restore_stop
  if ! load_copy "$DBC" "$CONTROL/restore/$R_ATTEMPT.sql.gz"; then
    restore_undo 'The backup did not load, so nothing changed.' load
    return 0
  fi
  rm -f "$CONTROL/restore/$R_ATTEMPT.sql.gz"
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
  local file="$CONTROL/restore.json" status="$CONTROL/restore-status.json" carry waiting
  if worker || [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/.env" ]; then return 0; fi
  if restore_left; then return 0; fi
  [ -f "$file" ] || return 0
  waiting=$(jq -r '.id // empty' "$CONTROL/request.json" 2> /dev/null || true)
  if plain_id "$waiting" && [ "$waiting" != "$(jq -r '.id // empty' "$CONTROL/status.json" 2> /dev/null || true)" ]; then return 0; fi
  if update_running; then return 0; fi
  R_ATTEMPT=$(jq -r '.attempt // empty' "$file" 2> /dev/null || true)
  R_ID=$(jq -r '.id // empty' "$file" 2> /dev/null || true)
  plain_id "$R_ATTEMPT" && plain_id "$R_ID" || return 0
  if [ "$(jq -r '.attempt // empty' "$status" 2> /dev/null || true)" = "$R_ATTEMPT" ]; then
    case "$(jq -r '.state // empty' "$status" 2> /dev/null || true)" in
      'done' | failed)
        rm -f "$file"
        return 0
        ;;
    esac
  fi
  [ -f "$CONTROL/restore/$R_ATTEMPT.sql.gz" ] && [ -f "$CONTROL/restore/$R_ATTEMPT.env.json" ] || return 0
  R_DUMPED=$(jq -r '.dumpedAt // empty' "$file" 2> /dev/null | tr -cd '0-9A-Za-z:.+-' | cut -c1-40 || true)
  carry=$(jq -r 'if .carry == true then "1" else "" end' "$file" 2> /dev/null || true)
  R_STAMP=''
  R_OLD=''
  DBC=$(compose ps -q db 2> /dev/null || true)
  [ -n "$DBC" ] || return 0
  WORK=$(mktemp -d)
  restore_run "$carry"
  rm -rf "$WORK"
  WORK=''
}

is_old_node() {
  case "$1" in
    *[!A-Za-z0-9_.-]*) return 1 ;;
    hornhoof-*-*-old-?*) return 0 ;;
    *) return 1 ;;
  esac
}

node_healthy() {
  [ "$(docker inspect --format '{{.State.Running}} {{.State.Restarting}}' "$1" 2> /dev/null || true)" = 'true false' ]
}

# Renamed -old-* node containers never run again: auto-restart comes off at once, and each goes once the node container
# it was renamed from runs and is not restarting.
sweep_old_node() {
  local name=$1 base
  if [ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name" 2> /dev/null || true)" != no ]; then
    docker update --restart=no "$name" > /dev/null 2>&1 || true
  fi
  base=${name%-old-*}
  if node_healthy "$base"; then
    docker rm -f "$name" > /dev/null 2>&1 || true
  fi
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
    if is_old_node "$name"; then
      sweep_old_node "$name" >&2
      continue
    fi
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
    curl -sS --max-time 10 --config - -X "$1" -H 'content-type: application/json' -d "$body" -o "$2" -w '%{http_code}' "$(nodes_url)" 2> /dev/null
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
# On a worker the installer moves the company's nodes with the core. One whose work would not end then stays on its
# image, so now and again the installer of this updater's own build looks at the nodes alone: each on another image than
# the one .env names goes to it once it is free, and the others are left as they are.
# The installer waits for each such node's work to end, however long that takes, so it runs beside this loop, one look
# at a time, and says what it did in nodes.log of the control folder. A run that looks once waits for it: its
# container goes when it ends, and an installer cut off between removing a node and starting it would lose the node.
worker_nodes() {
  local now
  now=$(date +%s)
  [ "$now" -ge "$NODES_AT" ] || return 0
  NODES_AT=$((now + NODES_RETRY))
  if nodes_look_runs; then return 0; fi
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] && [ -f "$INSTALLER" ] || return 0
  own "$NODE_IMAGE" "$(env_value HORNHOOF_NODE_REF)" || return 0
  (HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_FROM_UPDATER=1 HORNHOOF_UPDATER_REV="$UPDATER_REV" HORNHOOF_WORKER_NODES=1 \
    HORNHOOF_VERSION="$(env_value HORNHOOF_VERSION)" HORNHOOF_APP_REF="$(env_value HORNHOOF_APP_REF)" HORNHOOF_NODE_REF="$(env_value HORNHOOF_NODE_REF)" \
    HORNHOOF_UPDATER_REF="$(env_value HORNHOOF_UPDATER_REF)" bash "$INSTALLER" worker > "$CONTROL/nodes.log" 2>&1 ||
    printf 'Could not move the nodes of this machine to its build: see nodes.log in the control folder.\n') &
  NODES_LOOK=$!
  if [ -n "$ONCE" ]; then wait "$NODES_LOOK" || true; fi
}

# Whether the look at a worker's nodes still runs.
nodes_look_runs() { [ -n "$NODES_LOOK" ] && kill -0 "$NODES_LOOK" 2> /dev/null; }

# Two installers never move one node at once: a worker's install waits for the look at its nodes to end. The machine
# has its turn by then, so no new work comes to its nodes and the look ends soon.
after_nodes_look() {
  nodes_look_runs || return 0
  step install "Waiting for the look at this machine's nodes to end."
  while nodes_look_runs; do sleep 1; done
}

catch_up_nodes() {
  local now code answer poll behind
  if joined; then
    worker_nodes
    return 0
  fi
  # A machine the company was installed on that follows another now has no server of its own to ask about its nodes:
  # they move with its next install.
  if worker; then return 0; fi
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
    # Only a Hornhoof server's own refusal of a path it does not know says it is from before. Another 404, as the public
    # link gives for a moment while the machine that leads fences itself, is a server away: the next look asks again.
    404)
      if jq -e '.error.code == "not_found"' "$answer" > /dev/null 2>&1; then
        printf 'This server is from before nodes wait for their work, so they stay on their image and what they run goes on.\n'
        NODES_AT=$((now + NODES_RETRY))
      fi
      ;;
  esac
  rm -f "$answer"
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

# live_subnet <network>: the first subnet Docker gave that network, empty when it names none; fails when there is no
# such network.
live_subnet() {
  local line cfg
  line=$(docker network inspect --format "$NETWORK_FORMAT" "$1" 2> /dev/null | head -n 1 || true)
  [ -n "$line" ] || return 1
  cfg=${line##*|}
  cfg=${cfg%%;*}
  printf '%s' "${cfg%%,*}"
}

# The subnets the project's networks have in Docker, OLD_DEFAULT and OLD_INTERNAL, each empty when there is no such
# network; fails when Docker has neither.
OLD_DEFAULT=''
OLD_INTERNAL=''
live_networks() {
  local project found=''
  project=$(compose_project)
  if OLD_DEFAULT=$(live_subnet "${project}_default"); then found=1; else OLD_DEFAULT=''; fi
  if OLD_INTERNAL=$(live_subnet "${project}_internal"); then found=1; else OLD_INTERNAL=''; fi
  [ -n "$found" ]
}

# Whether the networks Docker has are not the ones the compose file asks for: the file names their subnets, and the
# settings hold none for a network that is there, or another subnet than it has. Compose takes such a network for
# changed and removes it to make it again, which it cannot while other containers are on it, so it would start nothing.
old_networks() {
  local want_default want_internal
  grep -q 'HORNHOOF_SUBNET' "$SERVER_DIR/compose.yaml" 2> /dev/null || return 1
  live_networks || return 1
  want_default=$(env_value HORNHOOF_SUBNET)
  want_internal=$(env_value HORNHOOF_INTERNAL_SUBNET)
  { [ -n "$OLD_DEFAULT" ] && [ "$want_default" != "$OLD_DEFAULT" ]; } || { [ -n "$OLD_INTERNAL" ] && [ "$want_internal" != "$OLD_INTERNAL" ]; }
}

# Whether compose refused because Docker would not remove a network of the project that containers are still on. Its
# file asks for the network otherwise than it was made, in a way Docker does not show, as a network made with no
# subnets named, which Docker shows with the subnet it gave.
endpoints_refused() { grep -q 'has active endpoints' "$1" 2> /dev/null && live_networks; }

# new_networks <log>: the settings name the subnets the networks have where they name none, so every address on them
# stays, and the project stops whole with its networks, the containers its file no longer names too, its data staying
# in its volumes. The built-in node hears first that it stops for an update, as when the installer stops it. The next
# up makes the networks again with those subnets. ADDED_SUBNETS names the settings it wrote.
ADDED_SUBNETS=''
new_networks() {
  local node
  if [ -n "$OLD_DEFAULT" ] && [ -z "$(env_value HORNHOOF_SUBNET)" ]; then
    PUT_VALUE=$OLD_DEFAULT put_env HORNHOOF_SUBNET || return 1
    ADDED_SUBNETS="$ADDED_SUBNETS HORNHOOF_SUBNET"
  fi
  if [ -n "$OLD_INTERNAL" ] && [ -z "$(env_value HORNHOOF_INTERNAL_SUBNET)" ]; then
    PUT_VALUE=$OLD_INTERNAL put_env HORNHOOF_INTERNAL_SUBNET || return 1
    ADDED_SUBNETS="$ADDED_SUBNETS HORNHOOF_INTERNAL_SUBNET"
  fi
  node=$(compose ps -q node 2> /dev/null || true)
  [ -z "$node" ] || docker exec "$node" node /app/apps/node/dist/main.js prepare-stop hornhoof_update > /dev/null 2>&1 || true
  compose down --remove-orphans >> "$1" 2>&1
}

# old_build_up <log>: the build from before starts whole again, with the compose file and the settings it had, on
# networks made as that file makes them, since its updater goes back with its own file. Only the subnets new_networks
# wrote leave the settings. That updater finds the way back marked and goes back by itself, with the database it had,
# which runs again with it.
old_build_up() {
  local ok=''
  WORK=$(mktemp -d)
  if unpack "$PREVIOUS" "$BACK_APP" && cp "$WORK/$PREVIOUS/compose.yaml" "$SERVER_DIR/compose.yaml"; then ok=1; fi
  rm -rf "$WORK"
  WORK=''
  [ -n "$ok" ] || return 1
  if [ -n "$ADDED_SUBNETS" ]; then
    # shellcheck disable=SC2086 # setting names, one word each
    drop_env $ADDED_SUBNETS || return 1
  fi
  compose down --remove-orphans >> "$1" 2>&1 || true
  HORNHOOF_APP_REF="$BACK_APP" HORNHOOF_NODE_REF="$BACK_NODE" HORNHOOF_UPDATER_REF="$BACK_UPDATER" compose up -d --no-build >> "$1" 2>&1
}

# compose_said <log>: why compose refused, for the update's log: its last lines, without the value of any key, secret,
# password or ticket the settings hold, each cut short.
compose_said() {
  local text line name value
  text=$(awk 'NF' "$1" | tail -n 3)
  while IFS= read -r line || [ -n "$line" ]; do
    name=${line%%=*}
    value=${line#*=}
    case "$name" in *KEY* | *SECRET* | *PASSWORD* | *TOKEN* | *TICKET*) ;; *) continue ;; esac
    [ "${#value}" -ge 8 ] || continue
    text=${text//"$value"/<hidden>}
  done < "$SERVER_DIR/.env"
  while IFS= read -r line; do
    [ -z "$line" ] || say "$(printf 'Compose said: %s' "$line" | cut -c1-240)"
  done <<< "$text"
}

# The helper container this build's installer starts when an older updater runs it. Compose replaces that updater, and
# the installer waiting in it, with this build's, which finds the update by the older one's note. If it does not say so
# in time, the older updater starts again, finds step rollback and goes back, by itself. On networks other than the
# compose file asks for, as Docker shows them or as compose says when it refuses, the project stops first and its
# networks are made again, once, and then the way back brings the build from before up whole, as nothing of it runs any
# more.
take_over() {
  local said fresh=''
  update_running || return 0
  read_status
  { [ "$STEP" = install ] && recall; } || return 0
  said=$(mktemp)
  if old_networks; then
    fresh=1
  elif compose up -d --no-build --wait updater > "$said" 2>&1 && taken_over; then
    rm -f "$said"
    return 0
  elif endpoints_refused "$said"; then
    compose_said "$said"
    fresh=1
  fi
  if [ -n "$fresh" ]; then
    say "The networks of this server are made again with the subnets they have, so Hornhoof stops for a moment."
    write_status running install
    : > "$said"
    if new_networks "$said" && compose up -d --no-build --wait db updater >> "$said" 2>&1 && taken_over; then
      rm -f "$said"
      return 0
    fi
  fi
  say "This build's updater did not start, so the build from before goes back."
  compose_said "$said"
  write_status running rollback
  : > "$said"
  if [ -n "$fresh" ]; then
    if old_build_up "$said"; then
      rm -f "$said"
      return 0
    fi
    compose_said "$said"
    rm -f "$said"
    stop_with failed "No updater could start, and the build from before did not start again either, so Hornhoof is stopped. Run install.sh server in $SERVER_DIR." finished
    return 0
  fi
  if HORNHOOF_UPDATER_REF="$BACK_UPDATER" compose up -d --no-build updater > "$said" 2>&1; then
    rm -f "$said"
    return 0
  fi
  compose_said "$said"
  rm -f "$said"
  stop_with failed "No updater could start. Hornhoof still runs the build from before; run install.sh server in $SERVER_DIR." finished
}

# Whether the machine's owner keeps access to the computer open now, by the time its keeper wrote, which ends it by
# itself.
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
# command on the computer itself. A command past its time, or still running when access is closed, is stopped;
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
    if is_old_node "$name"; then
      sweep_old_node "$name" >&2
      continue
    fi
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

# The machine's own addresses on its local networks, for the keeper to report: where the other machines of the company
# dial this one. A container sees only Docker's own network, so one on the host's network reads them, on Linux alone;
# the interfaces Docker and its bridges made are left out. Written whole and then moved, and a look that failed leaves
# what was there.
# What the machine is, where no installer run on the computer itself has said: asked of the Docker engine, once it
# answers. A server that came to this build by Update from a release from before machines had names has no such line
# in its .env, and this container is not the computer. An engine that runs in a machine of its own (Docker Desktop,
# OrbStack) says nothing of the computer it runs on, so only another engine is believed: its system is Linux and its
# name is the computer's. Written as host.json {os, hostname} for the keeper to report; a name that is no host's name
# is left empty.
HOST_ASKED=''
learn_host() {
  local said system name
  [ -z "$HOST_OS" ] && [ -z "$HOST_ASKED" ] || return 0
  said=$(docker info --format '{{.OperatingSystem}}|{{.Name}}' 2> /dev/null) || return 0
  [ -n "$said" ] || return 0
  HOST_ASKED=1
  system=${said%%|*}
  name=${said#*|}
  case "$system" in '' | *'Docker Desktop'* | *OrbStack*) return 0 ;; esac
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$ ]] || name=''
  jq -cn --arg hostname "$name" '{os: "linux", hostname: $hostname}' > "$CONTROL/host.json.new" 2> /dev/null || return 0
  mv "$CONTROL/host.json.new" "$CONTROL/host.json"
  HOST_OS=linux
}

write_addresses() {
  local now out ids nets='' list
  learn_host
  [ "$HOST_OS" = linux ] || return 0
  now=$(date +%s)
  [ "$now" -ge "$ADDRESSES_AT" ] || return 0
  ADDRESSES_AT=$((now + ADDRESSES_EVERY))
  out=$(docker run --rm --network host --entrypoint ip "$COMPUTER_IMAGE" -4 -o addr show scope global 2> /dev/null) || return 0
  if [ -n "$out" ]; then
    ids=$(docker network ls -q 2> /dev/null || true)
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per network
      nets=$(docker network inspect --format "$NETWORK_FORMAT" $ids 2> /dev/null || true)
    fi
  fi
  list=$(
    {
      printf '%s\n' "$nets"
      printf -- '---\n'
      printf '%s\n' "$out"
    } | awk '
      $0 == "---" { addr_mode = 1; next }
      !addr_mode && NF {
        split($0, f, "|")
        if (f[1] != "") skip_if["br-" substr(f[1], 1, 12)] = 1
        if (f[4] != "") skip_if[f[4]] = 1
        n = split(f[6], items, ";")
        for (i = 1; i <= n; i++) {
          if (items[i] == "") continue
          split(items[i], sg, ",")
          if (sg[2] != "") skip_ip[sg[2]] = 1
          split(sg[1], cp, "/")
          if (split(cp[1], oct, ".") == 4 && oct[4] == "0") {
            skip_ip[oct[1] "." oct[2] "." oct[3] ".1"] = 1
          }
        }
        next
      }
      addr_mode && $3 == "inet" {
        iface = $2
        sub(/:.*/, "", iface)
        if (iface ~ /^(docker|br-|veth|virbr|cni|podman|flannel|calico|nerdctl)/ || skip_if[iface] || skip_if[$2]) next
        split($4, a, "/")
        if (a[1] != "" && !skip_ip[a[1]]) print a[1]
      }
    ' | jq -Rnc '[inputs | select(length > 0)]' 2> /dev/null
  ) || return 0
  jq -cn --argjson at "$now" --argjson addresses "$list" '{at: $at, addresses: $addresses}' > "$CONTROL/addresses.json.new" 2> /dev/null || return 0
  mv "$CONTROL/addresses.json.new" "$CONTROL/addresses.json"
}

case "${1:-}" in
  nodes) nodes_mode "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  start-nodes)
    start_nodes "${2:-}" "${3:-}" "${4:-}"
    exit 0
    ;;
esac

if [ "${1:-}" = --take-over ]; then
  take_over
  exit 0
fi
mkdir -p "$CONTROL"
touch "$CONTROL/alive"
interrupted
finish_become
if [ "${1:-}" = --once ]; then
  ONCE=1
  write_addresses
  handle_request
  become_data
  wipe_request
  match_role
  schema_request
  upload_request
  load_request
  sweep_dumps
  dump_request
  restore_request
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
# The machine's addresses are read apart from an update too, which may wait for its turn for hours while the keeper
# takes a list for stale after a few minutes.
(while true; do
  write_addresses || true
  sleep 5
done) &
ADDRS=$!
trap 'kill $ALIVE $RUNS $ADDRS $NODES_LOOK 2> /dev/null || true' EXIT
while true; do
  handle_request
  become_data
  wipe_request
  match_role
  schema_request
  upload_request
  load_request
  sweep_dumps
  dump_request
  restore_request
  catch_up_nodes || printf 'Could not look at the nodes.\n'
  sleep 2
done
