#!/bin/sh
# Quality gates for the relay repo on one task's files: coverage.py (relay.py measured in its subprocesses too),
# crapper, dryer. Usage: gates-relay.sh <base-ref> [--no-tests]
#   <base-ref>: the commit the task started from.
#   --no-tests: reuse target/coverage/python/lcov.info from the last run.
# Writes .metrics/ and target/coverage/ in the relay repo (both git-ignored through .git/info/exclude).
set -eu
ROOT=/home/altera/hornhoof-network
REPO=$ROOT/hornhoof-edge
PY="$ROOT/quality/py312/bin/python"
BASE=${1:?base ref}
cd "$REPO"
committed=$(git diff --name-only --diff-filter=d "$BASE"...HEAD)
pending=$( (git ls-files --others --exclude-standard; git diff --name-only --diff-filter=d HEAD 2>/dev/null) || true)
files=$(printf '%s\n%s\n' "$committed" "$pending" | grep '\.py$' | grep -v '/test_[^/]*\.py$' | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)
echo "== files: $(echo $files)"
[ -n "$files" ] || { echo "== no python source files in this task"; exit 0; }
if [ "${2:-}" != "--no-tests" ]; then
  mkdir -p "$ROOT/network-build/tmp"
  work=$(mktemp -d "$ROOT/network-build/tmp/relay-cov.XXXXXX")
  cat > "$work/rc" <<RC
[run]
patch = subprocess
parallel = true
sigterm = true
source = relay, pages
data_file = $work/.coverage
RC
  echo "== coverage run (whole relay suite)"
  COVERAGE_RCFILE="$work/rc" nice -n 10 "$PY" -m coverage run -m unittest discover -s relay/test > "$work/tests.log" 2>&1 || { tail -30 "$work/tests.log"; echo "== TESTS FAILED"; exit 1; }
  tail -3 "$work/tests.log"
  COVERAGE_RCFILE="$work/rc" "$PY" -m coverage combine -q
  mkdir -p target/coverage/python
  COVERAGE_RCFILE="$work/rc" "$PY" -m coverage lcov -q -o target/coverage/python/lcov.info
  rm -rf "$work"
fi
echo "== crapper (every function the task added or changed must be under 10)"
"$ROOT/quality/bin/crapper" --root "$REPO" --use-existing-coverage $files || true
echo "== dryer --threshold 0.8"
"$ROOT/quality/bin/dryer" --root "$REPO" --threshold 0.8 $files || true
