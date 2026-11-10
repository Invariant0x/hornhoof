#!/bin/bash
# batch-review.sh <batch> <slice> <repo> '<commits>' '<plan-file>#<task> ...' [note-file]: builds one slice's review package and brief.
# Prints the two paths. A reader sees its slice's commits, the shared contracts, and the task texts they were written from.
set -eu
ROOT=/home/altera/hornhoof-network; B=$ROOT/network-build
batch=$1; slice=$2; repo=$3; commits=$4; tasks=$5; note=${6:-}
diff=$B/runs/batch$batch-$slice.diff; brief=$B/briefs/batch$batch-$slice-review.md
{
  echo "# Review package: batch $batch, slice $slice"; echo
  for c in $commits; do git -C "$ROOT/$repo" show --format='## %h %s%n%n%b' --stat --patch -U8 "$c" -- . ':(exclude)apps/server/drizzle/meta/*_snapshot.json' ':(exclude)package-lock.json'; echo; done
} > "$diff"
{
  sed '/^# How you work (writer)/,$d' "$B/briefs/build-rulings.md"; echo
  cat "$B/briefs/review-howto.md"; echo
  cat <<NOTES
# This review: conveyor v4, one review per batch

- You read batch $batch, slice $slice, in \`$ROOT/$repo\` on the branch batch-$batch, read only. The package is \`$diff\`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: \`packages/protocol\`, \`apps/server/src/db/schema.ts\`, the relay contract table in plan 1, and \`$B/parallel-map.md\` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in \`$B/runs/\`.
NOTES
  [ -n "$note" ] && { echo; cat "$note"; }
  echo; echo "# The tasks"; echo
  for t in $tasks; do
    plan=${t%%#*}; n=${t##*#}
    gc=$(grep -n '^## Global Constraints' "$plan" | head -1 | cut -d: -f1); gce=$(awk -v s="$gc" 'NR>s && /^## / {print NR-1; exit}' "$plan")
    echo "## $(basename "$plan" .md), Task $n"; echo
    sed -n "${gc},${gce}p" "$plan"; echo
    awk -v n="$n" '$0 ~ "^### Task "n":"{f=1} f && /^### Task / && $0 !~ "^### Task "n":"{f=0} f' "$plan"; echo
  done
} | sed "s/invariant0x@icloud\.com/<owner's address, the lead's alone>/g; s#/Users/0x/Projects/hornhoof-edge#$ROOT/hornhoof-edge#g; s#/Users/0x/Projects/Hornhoof-archive#$ROOT/hornhoof#g" > "$brief"
echo "$diff ($(wc -c < "$diff") bytes)"; echo "$brief ($(wc -c < "$brief") bytes)"
