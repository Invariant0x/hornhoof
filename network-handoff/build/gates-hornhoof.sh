#!/bin/bash
# Quality gates for Hornhoof on one task's changed files. Usage:
#   gates-hornhoof.sh <base-ref> <app: server|node|web|...> '<vitest test files, relative to the app>' [--no-tests]
# Runs the scoped tests under coverage (lcov), then crapper and dryer on the task's changed source files of that app.
set -euo pipefail
ROOT=/home/altera/hornhoof-network
REPO=$ROOT/hornhoof
BASE=${1:?base ref}; APP=${2:?app}; TESTS=${3:?test files}; MODE=${4:-}
cd "$REPO"
committed=$(git diff --name-only --diff-filter=d "$BASE"...HEAD)
pending=$( (git ls-files --others --exclude-standard; git diff --name-only --diff-filter=d HEAD) || true)
files=$(printf '%s\n%s\n' "$committed" "$pending" | grep -E "^apps/$APP/.*\.(ts|tsx)$" | grep -v '\.test\.tsx\?$' | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)
echo "== files: $(echo $files)"
[ -n "$files" ] || { echo "== no source files of apps/$APP in this task"; exit 0; }
if [ "$MODE" != "--no-tests" ]; then
  mkdir -p target/coverage/typescript
  # Every changed file is measured, test helpers too, or a helper's function scores as if nothing reached it.
  includes=(--coverage.include='src/**')
  for f in $files; do includes+=("--coverage.include=${f#apps/$APP/}"); done
  # shellcheck disable=SC2086
  (cd "apps/$APP" && VITEST_MAX_WORKERS=2 "$ROOT/network-build/heavy.sh" npx vitest run $TESTS --maxWorkers=2 --testTimeout=90000 \
    --coverage --coverage.reporter=lcovonly --coverage.reportsDirectory="$REPO/target/coverage/typescript" "${includes[@]}") 2>&1 | tail -8
  # lcov paths are relative to the app; crapper reads them relative to the repository root.
  sed -i -E "s#^SF:(apps/$APP/)?#SF:apps/$APP/#" target/coverage/typescript/lcov.info
fi
echo "== crapper (every function the task added or changed must be under 10)"
# shellcheck disable=SC2086
"$ROOT/quality/bin/crapper" --root "$REPO" --use-existing-coverage $files || true
echo "== dryer --threshold 0.8"
# shellcheck disable=SC2086
"$ROOT/quality/bin/dryer" --root "$REPO" --threshold 0.8 $files || true
