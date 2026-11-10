#!/bin/bash
# A lane is one writer's own clone of a repository, so that writers work side by side without touching each other.
# Only the lead lands a lane in the real repository, one at a time, after its review and an integration run.
#   lane.sh add <name> <hornhoof|hornhoof-edge>   clone into wt/<name>, carrying the real tree's uncommitted work
#   lane.sh refresh <name>                        move the lane onto the real tree's present state, keeping its own work
#   lane.sh package <name> <out.diff>             what the lane changed, for reviewers
#   lane.sh land <name>                           apply the lane's work to the real tree, uncommitted; the lead checks and commits
#   lane.sh commit <name> <message-file>          the writer's hand-in or WIP commit on its branch task-<name>
# The tag lanebase marks where the lane started; a lane's base for gates is `lanebase`. Its commit never leaves the clone.
set -euo pipefail
ROOT=/home/altera/hornhoof-network
lane_dir() { echo "$ROOT/wt/$1"; }
repo_of() { cat "$(lane_dir "$1")/.lane-repo"; }
identity=(-c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com)

copy_dependencies() { # Hard links keep it fast and small; relative links inside node_modules then point into the lane.
  local real=$1 lane=$2 dir
  (cd "$real" && find . -name node_modules -type d -prune) | while read -r dir; do
    mkdir -p "$lane/$(dirname "$dir")"; [ -e "$lane/$dir" ] || cp -al "$real/$dir" "$lane/$dir"
  done
  [ -d "$real/packages/protocol/dist" ] && cp -a "$real/packages/protocol/dist" "$lane/packages/protocol/" || true
  if [ -d "$real/relay/test/.bin" ]; then rm -rf "$lane/relay/test/.bin"; cp -al "$real/relay/test/.bin" "$lane/relay/test/.bin"; fi
}

mark_base() { # Takes the real tree's uncommitted work as the lane's starting point.
  local real=$1 lane=$2 patch
  git -C "$real" add -N . 2>/dev/null || true
  patch=$(git -C "$real" diff --binary HEAD)
  git -C "$real" reset -q 2>/dev/null || true
  if [ -n "$patch" ]; then printf '%s\n' "$patch" | git -C "$lane" apply --index --binary; fi
  git -C "$lane" add -A
  if ! git -C "$lane" diff --cached --quiet; then git -C "$lane" "${identity[@]}" commit -q -m "lane base, never leaves this clone"; fi
  git -C "$lane" tag -f lanebase > /dev/null
}

add() {
  local name=$1 repo=$2
  local real=$ROOT/$repo lane; lane=$(lane_dir "$name")
  [ ! -e "$lane" ] || { echo "lane $name exists" >&2; exit 1; }
  mkdir -p "$ROOT/wt"
  git clone -q --shared --branch "$(git -C "$real" rev-parse --abbrev-ref HEAD)" "$real" "$lane"
  echo "$repo" > "$lane/.lane-repo"; echo .lane-repo >> "$lane/.git/info/exclude"
  printf '.metrics/\ntarget/\n.coverage*\n' >> "$lane/.git/info/exclude"
  git -C "$lane" switch -q -c "task-$name"
  mark_base "$real" "$lane"
  copy_dependencies "$real" "$lane"
  echo "$lane (branch task-$name, base: lanebase, on $(git -C "$real" rev-parse --short HEAD) plus the real tree's uncommitted work)"
}

lane_diff() { local lane=$1; git -C "$lane" add -N .; git -C "$lane" diff --binary lanebase; git -C "$lane" reset -q; }

refresh() {
  local name=$1 lane real work; lane=$(lane_dir "$name"); real=$ROOT/$(repo_of "$name")
  work=$(mktemp "$ROOT/network-build/tmp/lane-XXXXXX.diff"); lane_diff "$lane" > "$work"
  git -C "$lane" fetch -q origin
  git -C "$lane" switch -q -f -C "task-$name" "origin/$(git -C "$real" rev-parse --abbrev-ref HEAD)"
  git -C "$lane" clean -fdq
  mark_base "$real" "$lane"
  [ -s "$work" ] && git -C "$lane" apply --3way --binary "$work" || true
  git -C "$lane" reset -q; rm -f "$work"
  echo "$lane refreshed; conflict markers, if any, are the lane's to settle"
}

package() { local lane; lane=$(lane_dir "$1"); {
  echo "# Review package: lane $1"; echo; lane_diff "$lane" | git -C "$lane" apply --stat -; echo; echo "## Diff"
  git -C "$lane" add -N .; git -C "$lane" diff -U10 lanebase -- . ':(exclude)apps/server/drizzle/meta/*_snapshot.json'; git -C "$lane" reset -q
} > "$2"; wc -c "$2"; }

commit_lane() { # lane.sh commit <name> <message-file>: the writer's hand-in or WIP commit, on its task branch; Ivan's identity stays in this one script.
  local lane; lane=$(lane_dir "$1")
  git -C "$lane" add -A
  git -C "$lane" "${identity[@]}" commit -q -F "$2"
  git -C "$lane" log -1 --format='%h %s' | cut -c1-90
}

land() { local lane real; lane=$(lane_dir "$1"); real=$ROOT/$(repo_of "$1"); lane_diff "$lane" | git -C "$real" apply --3way --binary; git -C "$real" reset -q; git -C "$real" status --short; }

case "${1:-}" in
  add) add "$2" "$3" ;; refresh) refresh "$2" ;; package) package "$2" "$3" ;; land) land "$2" ;; commit) commit_lane "$2" "$3" ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
