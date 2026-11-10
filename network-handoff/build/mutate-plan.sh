#!/bin/bash
# mutate-plan.sh <repo> <base> <map-file>: the mutator gate, run once at the end of phase 1, inside remote.sh run, on the riskiest
# pure logic only, with fast tests (ledger, Ivan's rulings): the map names those files and their tests. <base> is the series' start, or the last run's commit for a rerun on fixed lines.
# The map has a line per changed source file: <path><TAB><the tests that reach it>, so that a site runs only the tests it needs.
# A changed file with no line in the map is listed and skipped: its tests must be named, not guessed.
set -u
ROOT=/home/altera/hornhoof-network/network-build
repo=$1; base=$2; map=$3
git -C "$repo" add -N . 2>/dev/null
git -C "$repo" diff --name-only --diff-filter=d "$base" | grep -E '\.(py|ts|tsx)$' | grep -vE '(\.test\.tsx?|/test_[^/]*\.py)$' | while read -r file; do
  tests=$(awk -F'\t' -v f="$file" '$1 == f {print $2}' "$map")
  case "$file" in
    */test/*) runner=mutate-helper.sh ;;
    *) runner=mutate.sh ;;
  esac
  if [ -z "$tests" ]; then echo "NOT IN MAP: $file"; continue; fi
  echo "== $file"; "$ROOT/$runner" "$repo" "$base" "$file" "$tests" 2>&1 | tail -12
done
