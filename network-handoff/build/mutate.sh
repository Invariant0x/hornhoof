#!/bin/bash
# mutate.sh <repo> <base> <file> '<scoped test command>': the task's mutator gate, on the file's changed lines only.
# Takes both heavy slots. MUTATOR_WORKERS says how many workers run at once, 2 by default; remote.sh sets 4 on home-api.
# Exit 0 all killed, 3 a survivor, 2 the baseline failed.
set -u
ROOT=/home/altera/hornhoof-network
repo=$1; base=$2; file=$3; tests=$4
lines=$("$ROOT/network-build/changed-lines.sh" "$repo" "$base" "$file")
[ -n "$lines" ] || { echo "no changed lines in $file"; exit 0; }
HEAVY_SLOTS=2 "$ROOT/network-build/heavy.sh" "$ROOT/quality/bin/mutator" --root "$repo" --use-existing-coverage --mutate-all \
  --lines "$lines" --max-workers "${MUTATOR_WORKERS:-2}" --timeout-factor 3 --test-command "$tests" "$file"
