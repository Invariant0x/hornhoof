#!/bin/bash
# hh-related.sh <base-ref>: a batch's landing check: tests that reach the files changed since <base>, per app, plus types and lint.
# The whole suite (hh-suite.sh) runs at a plan's end, and for a change to migrations, scripts or the install and update path.
# Run from a Hornhoof repository root, inside remote.sh run.
# hh-related.sh --plan: changed files on stdin, prints the runs it would make and runs nothing (test-hh-related.sh).
set -u
APPS=(apps/server apps/node apps/web packages/protocol)

# vitest follows imports inside one app only. The apps import the protocol through its built package and the server reads
# templates at run time, so a change to either reaches tests that `vitest related` cannot see.
runs_for() { # changed files on stdin; prints one "<app> whole" or "<app> related <files>" per app
  local changed app files; changed=$(cat)
  for app in "${APPS[@]}"; do
    if printf '%s\n' "$changed" | grep -q '^packages/protocol/'; then echo "$app whole"; continue; fi
    if [ "$app" = apps/server ] && printf '%s\n' "$changed" | grep -q '^templates/'; then echo "$app whole"; continue; fi
    files=$(printf '%s\n' "$changed" | grep "^$app/.*\.tsx\?$" | sed "s#^$app/##" | tr '\n' ' ' | sed 's/ $//')
    if [ -n "$files" ]; then echo "$app related $files"; fi
  done
}

run_app() { # <app> <whole|related> [files]: one app's tests; a red here must not hide another app's result
  local app=$1 kind=$2; shift 2
  echo "== $app ($kind)"
  # shellcheck disable=SC2068
  if [ "$kind" = whole ]; then (cd "$app" && npx vitest run --passWithNoTests --testTimeout=90000)
  else (cd "$app" && npx vitest related $@ --run --passWithNoTests --testTimeout=90000); fi
}

if [ "${1:-}" = --plan ]; then runs_for; exit 0; fi

base=${1:?base ref}
npm run typecheck:tests || exit 1
npm run lint || exit 1
git add -N . 2>/dev/null || true
changed=$(git diff --name-only --diff-filter=d "$base")
git reset -q 2>/dev/null || true

status=0
while read -r app kind files; do
  [ -n "$app" ] || continue
  # shellcheck disable=SC2086
  run_app "$app" "$kind" $files || { status=1; echo "== RED: $app"; }
done < <(printf '%s\n' "$changed" | runs_for)
exit $status
