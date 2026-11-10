#!/bin/bash
# batch.sh start <repo> <n> <lane>...: staging branch batch-<n> from the repo's main line, with each lane's task commits on it, in order.
# batch.sh land <repo> <n>: fast-forward the main line to the batch, after its check is green. No merge commits, no rewrite.
# The main line is `network` in hornhoof and `main` in hornhoof-edge.
set -euo pipefail
ROOT=/home/altera/hornhoof-network
identity=(-c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com)
main_line() { case "$1" in hornhoof) echo network ;; hornhoof-edge) echo main ;; *) echo "unknown repo $1" >&2; exit 2 ;; esac; }
cmd=$1; repo=$2; n=$3; shift 3
real=$ROOT/$repo; line=$(main_line "$repo")
case "$cmd" in
  start)
    git -C "$real" switch -q -c "batch-$n" "$line"
    for lane in "$@"; do
      dir=$ROOT/wt/$lane
      commits=$(git -C "$dir" rev-list --reverse lanebase..HEAD)
      git -C "$real" fetch -q "$dir" HEAD
      # shellcheck disable=SC2086
      git -C "$real" "${identity[@]}" cherry-pick --allow-empty $commits > /dev/null
      echo "$lane: $(wc -w <<<"$commits") commit(s)"
    done
    git -C "$real" diff --stat "$line" | tail -1 ;;
  land)
    git -C "$real" switch -q "$line"
    git -C "$real" merge -q --ff-only "batch-$n"
    git -C "$real" branch -q -d "batch-$n"
    git -C "$real" log --format='%h %s' -3 | cut -c1-80 ;;
  *) sed -n 2,4p "$0"; exit 2 ;;
esac
