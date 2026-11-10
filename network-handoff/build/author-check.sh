#!/bin/bash
# author-check.sh <base>: the one command a writer runs before hand-in, from the root of its lane, inside remote.sh run.
# Related tests with coverage, types, lint, crapper under 10 on changed functions, dryer 0.8. crapper reads the coverage of this
# same run; there is no second coverage run. Its log, on that commit, is the task's evidence, and nobody reruns it. Hornhoof only;
# the relay's is author-check-relay.sh.
# A change that an import graph cannot see runs the whole package: protocol (server, node, web), templates (server), migrations,
# schema, scripts, the install and update path, env and fixtures (server), string tables (web).
set -uo pipefail
ROOT=/home/altera/hornhoof-network
base=${1:?base ref}
fail=0
step() { echo "== $1"; }
git add -N . 2>/dev/null
changed=$(git diff --name-only --diff-filter=d "$base")
git reset -q 2>/dev/null
step "changed files"; echo "$changed"

whole_packages() {
  local apps=""
  grep -qE '^packages/protocol/' <<<"$changed" && apps="apps/server apps/node apps/web"
  grep -qE '^(templates/|apps/server/drizzle/|apps/server/src/db/schema\.ts|scripts/|apps/updater/|compose|Dockerfile|apps/.*/Dockerfile|apps/server/test/(helpers|fake-relay|global-setup)\.ts|apps/server/test/(install|updater)-stubs/)' <<<"$changed" && apps="$apps apps/server"
  grep -qE '^apps/web/src/(i18n|locales?)/' <<<"$changed" && apps="$apps apps/web"
  tr ' ' '\n' <<<"$apps" | sort -u | grep . || true
}
whole=$(whole_packages)

# A red run must name its failing tests; vitest prints them far above its last lines, and a writer without the names reruns everything.
names_and_end() {
  local out; out=$(mktemp); cat > "$out"
  sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -a -E '^ *FAIL ' | cut -c1-200 | sort -u | head -40
  tail -12 "$out"; rm -f "$out"
}

run_app() { # Tests that reach this app's changed files, or all of them; coverage only of the changed files.
  local app=$1 files includes=() cover short=${1##*/}
  files=$(grep "^$app/.*\.tsx\?$" <<<"$changed" | sed "s#^$app/##" || true)
  grep -qx "$app" <<<"$whole" || [ -n "$files" ] || return 0
  cover=$PWD/target/coverage/typescript/$short
  for f in $files; do includes+=("--coverage.include=$f"); done
  step "$app tests"
  if grep -qx "$app" <<<"$whole"; then
    (cd "$app" && npx vitest run --testTimeout=90000 --coverage --coverage.reporter=lcovonly --coverage.reportsDirectory="$cover" "${includes[@]}") 2>&1 | names_and_end || fail=1
  else
    # shellcheck disable=SC2086
    (cd "$app" && npx vitest related $files --run --passWithNoTests --testTimeout=90000 --coverage --coverage.reporter=lcovonly --coverage.reportsDirectory="$cover" "${includes[@]}") 2>&1 | names_and_end || fail=1
  fi
  [ -f "$cover/lcov.info" ] && sed -i -E "s#^SF:($app/)?#SF:$app/#" "$cover/lcov.info"
}

step "types"; npm run typecheck:tests 2>&1 | tail -3 || fail=1
step "lint"; npm run lint 2>&1 | tail -3 || fail=1
for app in packages/protocol apps/server apps/node apps/web; do run_app "$app"; done
sources=$(grep -E '\.(ts|tsx|js|mjs|py)$' <<<"$changed" | grep -vE '\.test\.tsx?$|/test_[^/]*\.py$' || true)
if [ -n "$sources" ]; then
  step "crapper"
  # shellcheck disable=SC2086
  "$ROOT/quality/bin/crapper" --root . --use-existing-coverage $sources > /dev/null 2>&1
  # shellcheck disable=SC2086
  TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=$ROOT/quality/grammars "$ROOT/quality/ub/crapper/.venv/bin/python" -I "$ROOT/network-build/crap-changed.py" . "$base" $sources || fail=1
  step "dryer"
  # shellcheck disable=SC2086
  "$ROOT/quality/bin/dryer" --root . --threshold 0.8 $sources | tail -8
  grep -q ':score' .metrics/dry.edn 2>/dev/null && fail=1
fi
[ "$fail" = 0 ] && echo "AUTHOR CHECK OK at $(git rev-parse --short HEAD)" || echo "AUTHOR CHECK RED at $(git rev-parse --short HEAD)"
exit "$fail"
