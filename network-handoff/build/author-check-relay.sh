#!/bin/bash
# author-check-relay.sh <base> '<unittest modules the change reaches>': the relay's author check, from a lane's root inside
# remote.sh run. Scoped tests under coverage, crapper under 10 on changed functions, dryer 0.8, as author-check.sh does.
set -uo pipefail
ROOT=/home/altera/hornhoof-network
PY=$ROOT/quality/py312/bin/python
base=${1:?base ref}; modules=${2:?unittest modules}
fail=0
git add -N . 2>/dev/null; changed=$(git diff --name-only --diff-filter=d "$base"); git reset -q 2>/dev/null
echo "== changed files"; echo "$changed"
work=$(mktemp -d); printf '[run]\npatch = subprocess\nparallel = true\nsigterm = true\nsource = relay, pages\ndata_file = %s/.coverage\n' "$work" > "$work/rc"
echo "== tests under coverage"
# shellcheck disable=SC2086
COVERAGE_RCFILE=$work/rc "$PY" -m coverage run -m unittest $modules 2>&1 | tail -5 || fail=1
COVERAGE_RCFILE=$work/rc "$PY" -m coverage combine -q; mkdir -p target/coverage/python
COVERAGE_RCFILE=$work/rc "$PY" -m coverage lcov -q -o target/coverage/python/lcov.info
sources=$(grep '\.py$' <<<"$changed" | grep -v '/test_[^/]*\.py$' || true)
if [ -n "$sources" ]; then
  echo "== crapper"
  # shellcheck disable=SC2086
  "$ROOT/quality/bin/crapper" --root . --use-existing-coverage $sources > /dev/null 2>&1
  # shellcheck disable=SC2086
  TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=$ROOT/quality/grammars "$ROOT/quality/ub/crapper/.venv/bin/python" -I "$ROOT/network-build/crap-changed.py" . "$base" $sources || fail=1
  echo "== dryer"
  # shellcheck disable=SC2086
  "$ROOT/quality/bin/dryer" --root . --threshold 0.8 $sources | tail -6
  grep -q ':score' .metrics/dry.edn 2>/dev/null && fail=1
fi
rm -rf "$work"
[ "$fail" = 0 ] && echo "AUTHOR CHECK OK at $(git rev-parse --short HEAD)" || echo "AUTHOR CHECK RED at $(git rev-parse --short HEAD)"
exit "$fail"
