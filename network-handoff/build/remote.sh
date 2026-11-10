#!/bin/bash
# The one command the team uses to run heavy tests on the test machine home-api.
#   remote.sh run [--dind] <label> '<command>'   the command in a fresh container, in a snapshot of the code at this moment,
#                                                at the same absolute paths as here. Exit code and output are the command's.
#   remote.sh clean                              removes this build's leftovers that no live run owns.
#   remote.sh status                             shows only hnb- things, the disk and the slots.
#   remote.sh image                              builds hnb-build:1 and hnb-dind into image files on home-api.
# REMOTE_EDGE_TREE=<lane> and REMOTE_HORNHOOF_TREE=<lane> run from a lane (network-build/lane.sh) in place of the real tree,
# at the usual path in the container, and its coverage and metrics come back to the lane.
# The other half, which runs on home-api, is remote/host.sh.
set -u
ROOT=${HNB_ROOT:-/home/altera/hornhoof-network}
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
BUILD=$ROOT/network-build
STATE=$BUILD/tmp/remote
SLOTS=$STATE/slots
QUEUE=$STATE/queue
LIVE=$STATE/live
CONTROL=$BUILD/tmp/ssh-cm
TESTS=hornhoof-network-tests
POLL=${HNB_SLOT_POLL:-5}
RETRY_SECONDS=${HNB_RETRY_SECONDS:-10}
MAX_RETRIES=30
SLOT_NUMBERS="1 2 3"
MIN_FREE_GB=${HNB_MIN_FREE_GB:-15}
SSH_ARGS=(-F "$ROOT/.ssh/config" -o "ControlPath=$CONTROL" -o ControlMaster=no -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
RSYNC_SSH="ssh ${SSH_ARGS[*]}"
REPOS=(hornhoof hornhoof-edge)
REPO_FILTER=(--exclude=node_modules --exclude=__pycache__ --exclude=target/mutation-workers
  --exclude=/.claude --exclude=/.superpowers --exclude=/notes --exclude=/companies --exclude=/archive --exclude=/deploy.env --exclude=/.env)
SCRIPTS_FILTER=(--include=/*.sh --include=/*.py --include=/nodocker/*** --exclude=*)
RESULTS_FILTER=(--include=/target/ --include=/target/coverage/*** --include=/.metrics/*** --exclude=*)
EDGE_TREE=hornhoof-edge
EDGE_LOCAL=$ROOT/hornhoof-edge
HORNHOOF_TREE=hornhoof
HORNHOOF_LOCAL=$ROOT/hornhoof
RUN_STARTED=""
STREAM_PID=""
LIVE_FD=""
IMAGE_FD=""
SLOT_FD=""
TICKET=""

note() { echo "remote: $*" >&2; }
usage() { sed -n '2,8p' "$0" >&2; exit 2; }
host() { ssh "${SSH_ARGS[@]}" home-api bash "$TESTS/bin/host.sh" "$@"; }

# The machine takes about 3 seconds per connection, so one master carries them all. It starts before any lock is opened,
# so that it never inherits one and holds it for as long as it lives.
ensure_master() {
  mkdir -p "$BUILD/tmp"
  ssh "${SSH_ARGS[@]}" -O check home-api > /dev/null 2>&1 && return 0
  ssh -F "$ROOT/.ssh/config" -o "ControlPath=$CONTROL" -o ControlMaster=yes -o ControlPersist=600 -o BatchMode=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -N -f home-api < /dev/null > /dev/null 2>&1 || true
}

# Polling, not a blocking flock: bash runs a signal trap only between commands, and a waiting run must still die on SIGTERM.
poll_lock() {
  local mode=$1 fd=$2
  until flock -n "$mode" "$fd"; do sleep "$POLL"; done
}

new_stamp() { printf '%s-%s' "$(date -u +%Y%m%d-%H%M%S)" "$$"; }

hold_live() {
  mkdir -p "$LIVE"
  exec {LIVE_FD}> "$LIVE/$1"
  flock -n "$LIVE_FD"
}

# Installs the host's half, by rename: a run that is reading the old copy finishes with it.
install_host() {
  ssh "${SSH_ARGS[@]}" home-api "mkdir -p $TESTS/bin $TESTS/base/hornhoof $TESTS/base/hornhoof-edge $TESTS/base/network-build $TESTS/runs $TESTS/images && cat > $TESTS/bin/host.sh.$$ && mv $TESTS/bin/host.sh.$$ $TESTS/bin/host.sh" < "$SCRIPTS/remote/host.sh"
}

# 24 means files vanished while they were being read: writers are editing these trees, and the snapshot is of this moment.
rsync_tolerant() {
  rsync "$@"
  local rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 24 ]
}

# Against the real repository's base, so that a new lane sends only what differs from it.
sync_lane() {
  local lane=$1 tree=$2 repo=$3
  [ "$tree" != "$repo" ] || return 0
  rsync_tolerant -a --delete -z -e "$RSYNC_SSH" "${REPO_FILTER[@]}" "--link-dest=../$repo" "$lane/" "home-api:$TESTS/base/$tree/"
}

# The real trees go even for a lane: a lane's git objects live in them.
sync_trees() {
  local repo
  for repo in "${REPOS[@]}"; do
    rsync_tolerant -a --delete -z -e "$RSYNC_SSH" "${REPO_FILTER[@]}" "$ROOT/$repo/" "home-api:$TESTS/base/$repo/" || return 1
  done
  sync_lane "$EDGE_LOCAL" "$EDGE_TREE" hornhoof-edge || return 1
  sync_lane "$HORNHOOF_LOCAL" "$HORNHOOF_TREE" hornhoof || return 1
  rsync_tolerant -a --delete -e "$RSYNC_SSH" "${SCRIPTS_FILTER[@]}" "$BUILD/" "home-api:$TESTS/base/network-build/"
}

sync_and_prepare() {
  local sync_fd rc=0
  mkdir -p "$STATE"
  exec {sync_fd}> "$STATE/sync.lock"
  poll_lock -x "$sync_fd"
  install_host && sync_trees && host prepare "$NAME" "$STAMP" "$USE_DIND" "$MIN_FREE_GB" "$EDGE_TREE" "$HORNHOOF_TREE" || rc=1
  exec {sync_fd}>&-
  return "$rc"
}

try_any_slot() {
  local i
  for i in $SLOT_NUMBERS; do
    exec {SLOT_FD}> "$SLOTS/slot-$i"
    flock -n "$SLOT_FD" && return 0
    exec {SLOT_FD}>&-
  done
  return 1
}

# Waiters are served in the order of their calls: with polling alone a new run often passed one that had waited for an hour.
# A ticket whose run has died, whose live file nobody holds, says nothing and is dropped.
is_first_in_queue() {
  local ticket waiter
  for ticket in "$QUEUE"/*; do
    waiter=${ticket#"$QUEUE/"}
    waiter=${waiter#*--}
    [ "$waiter" != "$NAME" ] || return 0
    if [ -e "$LIVE/$waiter" ] && ! flock -n "$LIVE/$waiter" true; then return 1; fi
    rm -f "$ticket"
  done
  return 0
}

take_slot() {
  TICKET=$QUEUE/$STAMP--$NAME
  mkdir -p "$SLOTS" "$QUEUE"
  : > "$TICKET"
  until is_first_in_queue && try_any_slot; do sleep "$POLL"; done
  rm -f "$TICKET"
}

stream_with_retry() {
  local tries=0 rc
  while :; do
    host stream "hnb-run-$NAME" "$(wc -l < "$LOG")"
    rc=$?
    [ "$rc" = 255 ] || return "$rc"
    tries=$((tries + 1))
    [ "$tries" -le "$MAX_RETRIES" ] || return 255
    note "connection lost, reconnecting"
    sleep "$RETRY_SECONDS"
  done
}

# In the background with wait, because bash would hold a SIGTERM until a foreground pipeline ended. Only the command's
# output enters the log: its line count is what a reconnect skips.
follow_output() {
  stream_with_retry | tee -a "$LOG" &
  STREAM_PID=$!
  wait "$STREAM_PID"
  STREAM_PID=""
}

exit_code_of_run() {
  local tries=0 code rc
  while :; do
    code=$(host wait "hnb-run-$NAME")
    rc=$?
    if [ "$rc" = 0 ] && [ -n "$code" ]; then echo "$code"; return 0; fi
    tries=$((tries + 1))
    if [ "$rc" != 255 ] || [ "$tries" -gt "$MAX_RETRIES" ]; then echo 255; return 0; fi
    sleep "$RETRY_SECONDS"
  done
}

# --update keeps a result someone made here while the run went on, if theirs is newer.
pull_results_of() {
  rsync -rlt --omit-dir-times --update --prune-empty-dirs -e "$RSYNC_SSH" "${RESULTS_FILTER[@]}" \
    "home-api:$TESTS/runs/$NAME/$1/" "$2/" || note "could not bring back the results of $1"
}

pull_results() {
  pull_results_of hornhoof "$HORNHOOF_LOCAL"
  pull_results_of hornhoof-edge "$EDGE_LOCAL"
}

release_slot() {
  [ -z "$SLOT_FD" ] || exec {SLOT_FD}>&-
  SLOT_FD=""
}

# Whoever gets the exclusive lock holds the last run: every run keeps a shared lock from its start to its end.
remove_images_if_last() {
  [ -n "$IMAGE_FD" ] || return 0
  flock -n -x "$IMAGE_FD" && host remove_images
  exec {IMAGE_FD}>&-
  IMAGE_FD=""
}

finish_run() {
  [ -n "$RUN_STARTED" ] || return 0
  RUN_STARTED=""
  trap '' TERM INT HUP
  [ -z "$STREAM_PID" ] || kill "$STREAM_PID" 2> /dev/null
  host remove "$NAME" "$STAMP" || note "could not remove run $NAME: use remote.sh clean"
  [ -z "$TICKET" ] || rm -f "$TICKET"
  release_slot
  remove_images_if_last
  rm -f "$LIVE/$NAME"
}

refuse_lane() { note "not a lane of $2: $1"; exit 2; }

# A lane is a folder directly under wt/ whose .lane-repo names the repository it stands in for. Anything else is refused,
# because this path decides what is copied to someone else's server.
check_lane() {
  local path=$1 repo=$2 real name
  real=$(realpath -e -- "$path" 2> /dev/null) || refuse_lane "$path" "$repo"
  name=${real##*/}
  [ "$real" = "$(realpath "$ROOT")/wt/$name" ] || refuse_lane "$path" "$repo"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || refuse_lane "$path" "$repo"
  case "$name" in hornhoof|hornhoof-edge|network-build) refuse_lane "$path" "$repo" ;; esac
  [ "$(cat "$real/.lane-repo" 2> /dev/null)" = "$repo" ] || refuse_lane "$path" "$repo"
  LANE_PATH=$real
  LANE_NAME=$name
}

select_trees() {
  if [ -n "${REMOTE_EDGE_TREE:-}" ]; then
    check_lane "$REMOTE_EDGE_TREE" hornhoof-edge
    EDGE_TREE=$LANE_NAME
    EDGE_LOCAL=$LANE_PATH
  fi
  if [ -n "${REMOTE_HORNHOOF_TREE:-}" ]; then
    check_lane "$REMOTE_HORNHOOF_TREE" hornhoof
    HORNHOOF_TREE=$LANE_NAME
    HORNHOOF_LOCAL=$LANE_PATH
  fi
}

parse_run_args() {
  USE_DIND=0
  if [ "${1:-}" = --dind ]; then USE_DIND=1; shift; fi
  [ $# = 2 ] || usage
  LABEL=$1
  COMMAND=$2
  [[ "$LABEL" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || usage
}

start_run_state() {
  STAMP=$(new_stamp)
  NAME=$LABEL-$STAMP
  LOG=$BUILD/runs/remote-$NAME.log
  mkdir -p "$BUILD/runs" "$STATE"
  : > "$LOG"
  hold_live "$NAME"
  exec {IMAGE_FD}> "$STATE/image.lock"
  RUN_STARTED=1
  trap finish_run EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
}

cmd_run() {
  parse_run_args "$@"
  select_trees
  ensure_master
  start_run_state
  local started=$SECONDS code
  poll_lock -s "$IMAGE_FD"
  sync_and_prepare || { note "could not prepare the run"; exit 1; }
  note "snapshot $NAME ready after $((SECONDS - started)) s, waiting for a slot"
  take_slot
  host start "$NAME" "$STAMP" "$USE_DIND" "$(printf '%s' "$COMMAND" | base64 -w0)" || { note "could not start the container"; exit 1; }
  note "started after $((SECONDS - started)) s, log $LOG"
  follow_output
  code=$(exit_code_of_run)
  pull_results
  note "command exited $code after $((SECONDS - started)) s"
  exit "$code"
}

live_stamps() {
  local file
  for file in "$LIVE"/*; do
    [ -e "$file" ] || continue
    if flock -n "$file" true; then
      rm -f "$file"
    else
      printf '%s\n' "${file##*/}" | grep -oE '[0-9]{8}-[0-9]{6}-[0-9]+$'
    fi
  done
}

# It holds the sync lock so that no new run makes a folder between the list of live runs and the removal.
cmd_clean() {
  ensure_master
  mkdir -p "$STATE"
  local sync_fd stamps lanes
  exec {sync_fd}> "$STATE/sync.lock"
  poll_lock -x "$sync_fd"
  install_host
  stamps=$(live_stamps)
  lanes=$(ls "$ROOT/wt" 2> /dev/null | paste -sd,)
  # shellcheck disable=SC2086
  host clean "${lanes:--}" $stamps
  if [ -z "$stamps" ]; then
    exec {IMAGE_FD}> "$STATE/image.lock"
    remove_images_if_last
  fi
}

show_slots() {
  local i busy=0 file
  for i in $SLOT_NUMBERS; do
    file=$SLOTS/slot-$i
    [ -e "$file" ] || continue
    flock -n "$file" true || busy=$((busy + 1))
  done
  echo "== slots: $busy of 3 busy"
  ls "$LIVE" 2> /dev/null | sed 's/^/live: /'
  ls "$QUEUE" 2> /dev/null | sed 's/^[^ ]*--/waiting, oldest first: /'
}

cmd_status() {
  ensure_master
  install_host
  host status
  show_slots
}

cmd_image() {
  ensure_master
  local stamp sync_fd image_fd
  stamp=$(new_stamp)
  mkdir -p "$STATE"
  hold_live "image-$stamp"
  exec {sync_fd}> "$STATE/sync.lock" {image_fd}> "$STATE/image.lock"
  poll_lock -x "$sync_fd"
  poll_lock -x "$image_fd"
  install_host && sync_trees || exit 1
  ssh "${SSH_ARGS[@]}" home-api "mkdir -p $TESTS/build-context" || exit 1
  rsync -a -e "$RSYNC_SSH" "$SCRIPTS/remote/provision.sh" "home-api:$TESTS/build-context/provision.sh" || exit 1
  host build_image "$stamp"
  local rc=$?
  rm -f "$LIVE/image-$stamp"
  exit "$rc"
}

renice -n 10 -p $$ > /dev/null 2>&1
case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  clean) cmd_clean ;;
  status) cmd_status ;;
  image) cmd_image ;;
  *) usage ;;
esac
