#!/usr/bin/env bash
# Redirect the updater's container calls to the two Postgres clusters of this test.
set -o pipefail
. "$TEST_ROOT/apps/updater/lib/handoff.sh"
compose() { printf '%s\n' "$TEST_TARGET"; }
take() { cat -- "$1"; }
keeper_dir() { mkdir -p -- "$1"; }
publish() { local file=$1; shift 2; "$@" > "$file"; }
plain_count() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
plain_database() { [ "$1" = hornhoof ]; }
say() { printf '%s\n' "$1"; }
docker() {
  local i peer=''
  local args=("$@")
  for i in "${!args[@]}"; do
    if [ "${args[i]}" = keeper ]; then args[i]=$TEST_LEADER; peer=1; fi
  done
  if [ -z "$TEST_PG_BIN" ]; then command docker "${args[@]}"; return; fi
  while [ "${args[0]}" != "$TEST_TARGET" ]; do args=("${args[@]:1}"); done
  args=("${args[@]:1}")
  if [ "${args[0]}" = sh ]; then "${args[@]}"; return; fi
  if [ -z "$peer" ]; then args=("${args[0]}" -h "$TEST_TARGET" "${args[@]:1}"); fi
  "$TEST_PG_BIN/${args[0]}" "${args[@]:1}"
}
schema_request
