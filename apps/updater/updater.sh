#!/usr/bin/env bash
# Hornhoof updater: swaps this server's images when someone updates from the web app.
#
#   updater.sh              watch the control folder for update requests
#   updater.sh --once       handle the waiting request, if any, then exit
#   updater.sh --take-over  put this build's updater in the place of an older one that runs an update, then exit
#   updater.sh nodes <server> <image> <host> [--once]   move that server's nodes on this computer to the server's build
#   updater.sh start-nodes <server> <image> <host>      start the one updater of that server's nodes here, on <image>
#
# What it does lies in parts of its own, in lib next to this file; the updater's image keeps them beside the statements
# of a restore:
#
#   update.sh     an update of this machine and its way back, and one an updater was stopped in
#   take-over.sh  an update an older updater began
#   backup.sh     the copies of the database, before an update and for the keeper's backups, and how long each stays
#   restore.sh    a backup the keeper puts back
#   handoff.sh    a machine that comes to keep the company's data, or gives it up and is wiped
#   computer.sh   the orchestrator's commands on this computer, and what the computer is
#   nodes.sh      the nodes of this server, on this computer and on others
#
# They share state.sh, the state of an update that a stop never loses, and server.sh, the server's folder, settings,
# compose project, images and database.
#
# This is revision 2, which each installer hears as HORNHOOF_UPDATER_REV and the note of an update keeps. An older
# updater says no revision, so an installer that needs this one takes over (take-over.sh).
#
# The updater holds the Docker socket, so it takes nothing from the request but the tag, which must be a plain image
# tag, and the digests, and only runs images of HORNHOOF_IMAGE and of its -node and -updater repositories. It runs on
# the bash that ships with macOS (3.2) for the tests, and on Alpine's in its image.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail

CONTROL="${HORNHOOF_CONTROL_DIR:-/control}"
SERVER_DIR="${HORNHOOF_SERVER_DIR:-}"
IMAGE="${HORNHOOF_IMAGE:-ghcr.io/invariant0x/hornhoof}"
NODE_IMAGE="${IMAGE}-node"
UPDATER_IMAGE="${IMAGE}-updater"
# The revision each installer hears and the note of an update keeps.
UPDATER_REV=2
# worker: this machine keeps none of the company's data. Its updater follows the company server's build: it downloads
# the build its keeper asks for, waits until the keeper passes on the server's word that it is this machine's turn, and
# installs then. It saves and restores no database, since it has none.
ROLE="${HORNHOOF_ROLE:-}"
# Where the statements of a restore lie in this image: cutover.sql, carry.sql and adopt.sql.
SQL_DIR="${HORNHOOF_SQL_DIR:-/usr/local/share/hornhoof-updater}"
# Whether this run looks once and ends.
ONCE=''

# The parts, in lib next to this file, or beside the statements of a restore in the updater's image.
PARTS="$(dirname "${BASH_SOURCE[0]}")/lib"
[ -f "$PARTS/state.sh" ] || PARTS="$SQL_DIR/lib"
# shellcheck source=lib/state.sh
. "$PARTS/state.sh"
# shellcheck source=lib/server.sh
. "$PARTS/server.sh"
# shellcheck source=lib/update.sh
. "$PARTS/update.sh"
# shellcheck source=lib/take-over.sh
. "$PARTS/take-over.sh"
# shellcheck source=lib/backup.sh
. "$PARTS/backup.sh"
# shellcheck source=lib/restore.sh
. "$PARTS/restore.sh"
# shellcheck source=lib/handoff.sh
. "$PARTS/handoff.sh"
# shellcheck source=lib/computer.sh
. "$PARTS/computer.sh"
# shellcheck source=lib/nodes.sh
. "$PARTS/nodes.sh"

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
heartbeats
computer_clear_legacy
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
(while sleep 5; do heartbeats; done) &
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
