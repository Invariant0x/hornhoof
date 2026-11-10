#!/bin/bash
# mutate-helper.sh <repo> <base> <file under test/> '<scoped test command>': as mutate.sh, for a test helper the mutator skips.
set -u
ROOT=/home/altera/hornhoof-network
repo=$1; base=$2; file=$3; tests=$4
lines=$("$ROOT/network-build/changed-lines.sh" "$repo" "$base" "$file")
[ -n "$lines" ] || { echo "no changed lines in $file"; exit 0; }
export TREE_SITTER_LANGUAGE_PACK_CACHE_DIR="$ROOT/quality/grammars"
HEAVY_SLOTS=2 "$ROOT/network-build/heavy.sh" "$ROOT/quality/ub/mutator/.venv/bin/python" -I "$ROOT/network-build/mutator-helper.py" --root "$repo" --use-existing-coverage --mutate-all \
  --lines "$lines" --max-workers "${MUTATOR_WORKERS:-2}" --timeout-factor 3 --test-command "$tests" "$file"
