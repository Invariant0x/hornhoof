#!/bin/bash
# Tests for remote.sh and host.sh. Real rsync, real flock and the real scripts run against a fake ssh and a fake Docker, in
# a temporary folder, so that nothing here reaches home-api. Usage: test-remote.sh [name-substring]
# SC2034: check() evaluates its condition as a string, which shellcheck cannot follow. SC2010: file names here are this file's own.
# shellcheck disable=SC2034,SC2010
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BUILD=$(cd "$HERE/../.." && pwd)
REMOTE_SH=$BUILD/remote.sh
ORIG_PATH=$PATH
CONTAINER_ROOT=/home/altera/hornhoof-network
passed=0
failed=0
current=""

fail() { echo "  FAIL [$current]: $*"; failed=$((failed + 1)); }
check() { if eval "$2"; then passed=$((passed + 1)); else fail "$1"; fi; }
calls() { cat "$FAKE_STATE/calls.log" 2>/dev/null; }
tests_home() { printf '%s' "$FAKE_REMOTE_HOME/hornhoof-network-tests"; }

wait_for() {
  local _
  for _ in $(seq 150); do eval "$1" && return 0; sleep 0.1; done
  fail "timed out waiting for: $1"
  return 1
}

make_repo_common() {
  local repo=$1
  mkdir -p "$repo/target/coverage/python" "$repo/target/mutation-workers/run" "$repo/.metrics" "$repo/__pycache__" "$repo/node_modules/local"
  git init -q "$repo"
  echo source > "$repo/source.txt"
  echo lcov > "$repo/target/coverage/python/lcov.info"
  echo worker > "$repo/target/mutation-workers/run/file"
  echo crap > "$repo/.metrics/crap.edn"
  echo pyc > "$repo/__pycache__/x.pyc"
  echo local > "$repo/node_modules/local/index.js"
}

make_local_tree() {
  local root=$HNB_ROOT
  make_repo_common "$root/hornhoof"
  make_repo_common "$root/hornhoof-edge"
  mkdir -p "$root/hornhoof/packages/protocol/dist" "$root/hornhoof-edge/relay/test/.bin"
  echo lock-1 > "$root/hornhoof/package-lock.json"
  echo dist > "$root/hornhoof/packages/protocol/dist/index.js"
  echo binary > "$root/hornhoof-edge/relay/test/.bin/frpc"
  mkdir -p "$root/network-build/nodocker" "$root/network-build/runs" "$root/network-build/briefs" "$root/network-build/tmp"
  echo '#!/bin/sh' > "$root/network-build/heavy.sh"
  echo 'print()' > "$root/network-build/mutator-helper.py"
  echo '#!/bin/sh' > "$root/network-build/nodocker/docker"
  echo old > "$root/network-build/runs/old.log"
  echo brief > "$root/network-build/briefs/brief.md"
  mkdir -p "$root/.ssh" "$root/quality/uv-cache"
  echo private > "$root/.ssh/home-api"
  echo cache > "$root/quality/uv-cache/blob"
  commit_tracked "$root/hornhoof" source.txt package-lock.json
  commit_tracked "$root/hornhoof-edge" source.txt
}

commit_tracked() {
  local repo=$1
  shift
  git -C "$repo" add "$@"
  git -C "$repo" -c user.name=t -c user.email=t@example.invalid commit -q -m start
}

# As lane.sh add does: a --shared clone, its .lane-repo, the tag lanebase, its own dist.
make_lane() {
  local lane=$HNB_ROOT/wt/$1 real=$HNB_ROOT/$2
  mkdir -p "$HNB_ROOT/wt"
  git clone -q --shared "$real" "$lane"
  echo "$2" > "$lane/.lane-repo"
  git -C "$lane" tag lanebase
  if [ -d "$real/packages/protocol/dist" ]; then
    mkdir -p "$lane/packages/protocol"
    cp -a "$real/packages/protocol/dist" "$lane/packages/protocol/"
  fi
}

setup() {
  T=$(mktemp -d "$BUILD/tmp/remote-test.XXXXXX")
  export HNB_ROOT=$T/root HNB_SLOT_POLL=0.1 HNB_RETRY_SECONDS=0.1 FAKE_STATE=$T/docker FAKE_REMOTE_HOME=$T/remote-home FAKE_REMOTE_BIN=$T/remote-bin
  unset HNB_MIN_FREE_GB
  mkdir -p "$T/bin" "$FAKE_STATE/images" "$FAKE_REMOTE_BIN" "$(tests_home)/images" "$HNB_ROOT"
  cp "$HERE/fake-ssh" "$T/bin/ssh"
  cp "$HERE/fake-sudo" "$FAKE_REMOTE_BIN/sudo"
  cp "$HERE/fake-docker" "$FAKE_REMOTE_BIN/fake-docker"
  touch "$(tests_home)/images/hnb-build.tar" "$(tests_home)/images/hnb-dind.tar"
  export PATH=$T/bin:$ORIG_PATH
  make_local_tree
}

check_no_forbidden_calls() {
  check "no prune, no docker socket mounted" '! calls | grep -Eq "prune|(-v|--volume|--mount) [^ ]*docker\.sock"'
  check "nothing but hnb- is acted on" '! calls | grep -E "^docker (rm|stop|restart|kill|exec|inspect|logs|wait|volume rm|network rm)( |$)" | grep -Ev " hnb-" | grep -q .'
  check "no call names a foreign container" '! calls | grep -Eq "hornhoof-machine-1|k3d-tools-0"'
  check "fake saw nothing unknown" '[ ! -s "$FAKE_STATE/forbidden.log" ]'
}

teardown() {
  check_no_forbidden_calls
  local dir pid
  for dir in "$FAKE_STATE"/containers/*/; do
    [ -e "$dir/pid" ] || continue
    pid=$(cat "$dir/pid")
    kill -KILL -- "-$pid" 2>/dev/null
  done
  wait 2>/dev/null
  rm -rf "$T"
  export PATH=$ORIG_PATH
}

containers_named() { ls "$FAKE_STATE/containers" 2>/dev/null | grep -c "$1"; }
run_call() { calls | grep -E "^docker run .*--name hnb-run-$1"; }
image_loaded() { [ -e "$FAKE_STATE/images/$1" ]; }
snapshot_dir() { ls -d "$(tests_home)"/runs/"$1"-* 2>/dev/null | head -1; }

test_rejects_a_label_docker_or_a_folder_could_not_carry() {
  local bad rc
  for bad in 'Bad' '../x' 'a b' '-x' 'a/b' ''; do
    "$REMOTE_SH" run "$bad" 'true' > /dev/null 2>&1; rc=$?
    check "label [$bad] refused" '[ "$rc" = 2 ]'
  done
  check "nothing ran" '[ ! -s "$FAKE_STATE/calls.log" ]'
}

test_exit_code_stdout_and_log_are_the_commands() {
  local out rc log
  out=$("$REMOTE_SH" run lab 'echo hello-out; echo hello-err >&2; exit 7' 2> "$T/err"); rc=$?
  check "exit code is the command's" '[ "$rc" = 7 ]'
  check "stdout has stdout" '[[ "$out" == *hello-out* ]]'
  check "stderr of the command joins stdout" '[[ "$out" == *hello-err* ]]'
  check "the runner's own lines stay off stdout" '[[ "$out" != *remote:* ]]'
  log=$(ls "$HNB_ROOT"/network-build/runs/remote-lab-*.log 2>/dev/null | head -1)
  check "log exists" '[ -n "$log" ]'
  check "log has the output" 'grep -q hello-out "$log" && grep -q hello-err "$log"'
}

test_output_arrives_while_the_command_runs() {
  "$REMOTE_SH" run lab 'echo live-line; sleep 60' > "$T/out" 2> /dev/null & local pid=$!
  wait_for 'grep -q live-line "$T/out"'
  check "stdout has the line before the command ended" 'grep -q live-line "$T/out"'
  check "and the log has it" 'grep -q live-line "$HNB_ROOT"/network-build/runs/remote-lab-*.log'
  kill -TERM "$pid"; wait "$pid" 2> /dev/null
}

test_command_quoting_survives_the_trip() {
  local out
  out=$("$REMOTE_SH" run lab "printf '%s|' \"a  b\" 'c\$d' \"e'f\"" 2> /dev/null)
  check "quotes and dollars intact" '[[ "$out" == *"a  b|c\$d|e'"'"'f|"* ]]'
}

test_sync_sends_what_the_brief_lists_and_nothing_else() {
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  local base; base=$(tests_home)/base
  check "git goes" '[ -d "$base/hornhoof/.git" ] && [ -d "$base/hornhoof-edge/.git" ]'
  check "metrics go" '[ -f "$base/hornhoof/.metrics/crap.edn" ]'
  check "coverage goes" '[ -f "$base/hornhoof-edge/target/coverage/python/lcov.info" ]'
  check "test binaries go" '[ -f "$base/hornhoof-edge/relay/test/.bin/frpc" ]'
  check "local node_modules stay" '[ ! -e "$base/hornhoof/node_modules/local" ]'
  check "pycache stays" '[ ! -e "$base/hornhoof/__pycache__" ]'
  check "mutation workers stay" '[ ! -e "$base/hornhoof/target/mutation-workers" ]'
  check "scripts go" '[ -f "$base/network-build/heavy.sh" ] && [ -f "$base/network-build/mutator-helper.py" ]'
  check "nodocker goes" '[ -f "$base/network-build/nodocker/docker" ]'
  check "runs stay" '[ ! -e "$base/network-build/runs" ]'
  check "briefs stay" '[ ! -e "$base/network-build/briefs" ]'
  check "key is nowhere" '! find "$FAKE_REMOTE_HOME" -name "home-api" | grep -q . && ! grep -rqs private "$FAKE_REMOTE_HOME/hornhoof-network-tests/base"'
  check "uv cache is nowhere" '! find "$FAKE_REMOTE_HOME" -name "uv-cache" | grep -q .'
}

test_plain_run_is_isolated_as_the_brief_says() {
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  local call; call=$(run_call lab)
  check "uid" '[[ "$call" == *"--user 1000:1000"* ]]'
  check "cpus" '[[ "$call" == *"--cpus 3"* ]]'
  check "memory" '[[ "$call" == *"--memory 24g"* ]]'
  check "home" '[[ "$call" == *"HOME=/home/altera"* ]]'
  check "vitest workers match the cpus" '[[ "$call" == *"VITEST_MAX_WORKERS=3"* ]]'
  check "mutator workers match the cpus" '[[ "$call" == *"MUTATOR_WORKERS=3"* ]]'
  check "image" '[[ "$call" == *" hnb-build:1 "* ]]'
  check "nice" '[[ "$call" == *"nice -n 10"* ]]'
  check "nodocker first" '[[ "$call" == *"PATH=$CONTAINER_ROOT/network-build/nodocker:"* ]]'
  check "dead docker host" '[[ "$call" == *"DOCKER_HOST=unix://$CONTAINER_ROOT/network-build/tmp/no-docker.sock"* ]]'
  check "not privileged" '[[ "$call" != *"--privileged"* ]]'
  check "own network" '[[ "$call" == *"--network hnb-net-"* ]]'
  for tree in hornhoof hornhoof-edge network-build; do
    check "$tree at the same path" '[[ "$call" == *":$CONTAINER_ROOT/$tree "* ]]'
  done
  check "no dind in a plain run" '! calls | grep -q "name hnb-dind-"'
}

test_dind_run_gets_its_own_docker_and_no_guard() {
  "$REMOTE_SH" run --dind lab 'true' > /dev/null 2>&1
  local call dind; call=$(run_call lab); dind=$(calls | grep -E '^docker run .*--name hnb-dind-')
  check "dind privileged" '[[ "$dind" == *"--privileged"* ]]'
  check "dind tls off" '[[ "$dind" == *"DOCKER_TLS_CERTDIR="* ]]'
  check "dind own volume" '[[ "$dind" =~ -v\ hnb-dind-[^:]+:/var/lib/docker ]]'
  check "dind image is ours" '[[ "$dind" == *" hnb-dind:29.7.1 "* ]]'
  check "dind answers on loopback only" '[[ "$dind" == *"--host=tcp://127.0.0.1:2375"* ]] && [[ "$dind" != *"0.0.0.0"* ]]'
  check "dind has the snapshot" '[[ "$dind" == *":$CONTAINER_ROOT/hornhoof "* ]]'
  check "test shares its network" '[[ "$call" =~ --network\ container:hnb-dind- ]]'
  check "test talks to it" '[[ "$call" == *"DOCKER_HOST=tcp://127.0.0.1:2375"* ]]'
  check "test has no guard" '[[ "$call" != *nodocker* ]]'
  check "test itself is not privileged" '[[ "$call" != *"--privileged"* ]]'
  check "test runs as 1000" '[[ "$call" == *"--user 1000:1000"* ]]'
  check "all dind things gone" '[ -z "$(ls "$FAKE_STATE/containers" "$FAKE_STATE/volumes" "$FAKE_STATE/networks" 2>/dev/null | grep hnb-)" ]'
  check "dind image gone too" '! image_loaded hnb-dind_29.7.1'
}

test_snapshot_does_not_change_when_the_tree_does() {
  "$REMOTE_SH" run first 'sleep 60' > /dev/null 2>&1 & local pid=$!
  wait_for '[ "$(containers_named hnb-run-first)" = 1 ]'
  local snap; snap=$(snapshot_dir first)
  check "source is there" '[ "$(cat "$snap/hornhoof/source.txt")" = source ]'
  echo changed > "$HNB_ROOT/hornhoof/source.txt"
  "$REMOTE_SH" run second 'true' > /dev/null 2>&1
  check "base took the change" '[ "$(cat "$(tests_home)/base/hornhoof/source.txt")" = changed ]'
  check "snapshot kept the old file" '[ "$(cat "$snap/hornhoof/source.txt")" = source ]'
  local base; base=$(tests_home)/base/hornhoof
  check "dist is a real copy" '[ "$(stat -c %i "$snap/hornhoof/packages/protocol/dist/index.js")" != "$(stat -c %i "$base/packages/protocol/dist/index.js")" ]'
  check "source is a real copy, tools write it in place" '[ "$(stat -c %i "$snap/hornhoof/source.txt")" != "$(stat -c %i "$base/source.txt")" ]'
  check "git is a real copy" '[ "$(stat -c %i "$snap/hornhoof/.git/HEAD")" != "$(stat -c %i "$base/.git/HEAD")" ]'
  check "metrics are a real copy" '[ "$(stat -c %i "$snap/hornhoof/.metrics/crap.edn")" != "$(stat -c %i "$base/.metrics/crap.edn")" ]'
  check "node_modules are hard links" '[ "$(stat -c %i "$snap/hornhoof/node_modules/pkg/index.js")" = "$(stat -c %i "$base/node_modules/pkg/index.js")" ]'
  kill -TERM "$pid"; wait "$pid" 2>/dev/null
}

test_dependencies_install_only_when_the_lock_changes() {
  local npm_runs='calls | grep -c "name hnb-npm-"'
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "first run installs" '[ "$(eval "$npm_runs")" = 1 ]'
  check "install has no browser download" 'calls | grep "name hnb-npm-" | grep -q "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"'
  check "install runs npm ci and builds protocol" 'calls | grep "name hnb-npm-" | grep -q "npm ci" && calls | grep "name hnb-npm-" | grep -q "@hornhoof/protocol"'
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "same lock does not install" '[ "$(eval "$npm_runs")" = 1 ]'
  echo lock-2 > "$HNB_ROOT/hornhoof/package-lock.json"
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "changed lock installs" '[ "$(eval "$npm_runs")" = 2 ]'
}

test_failed_install_fails_the_run_and_cleans_up() {
  echo 9 > "$FAKE_STATE/foreground-rc"
  "$REMOTE_SH" run lab 'echo never' > "$T/out" 2>&1; local rc=$?
  check "run fails" '[ "$rc" != 0 ]'
  check "command did not run" '! grep -q never "$T/out"'
  check "no folder left" '[ -z "$(snapshot_dir lab)" ]'
  rm -f "$FAKE_STATE/foreground-rc"
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "next run installs again, the lock was not marked done" '[ "$(calls | grep -c "name hnb-npm-")" = 2 ]'
}

test_only_coverage_and_metrics_come_back() {
  local cmd='echo new > $SNAP/hornhoof/target/coverage/new.info; echo new > $SNAP/hornhoof-edge/.metrics/new.edn; echo leak > $SNAP/hornhoof/leak.txt; mkdir -p $SNAP/hornhoof/target/other; echo leak > $SNAP/hornhoof/target/other/x'
  "$REMOTE_SH" run lab "$cmd" > /dev/null 2>&1
  check "coverage came back" '[ -f "$HNB_ROOT/hornhoof/target/coverage/new.info" ]'
  check "metrics came back" '[ -f "$HNB_ROOT/hornhoof-edge/.metrics/new.edn" ]'
  check "other files did not" '[ ! -e "$HNB_ROOT/hornhoof/leak.txt" ] && [ ! -e "$HNB_ROOT/hornhoof/target/other" ]'
  check "local coverage is not wiped" '[ -f "$HNB_ROOT/hornhoof/target/coverage/python/lcov.info" ]'
  check "local workers are not wiped" '[ -f "$HNB_ROOT/hornhoof/target/mutation-workers/run/file" ]'
}

test_results_come_back_when_the_command_fails() {
  "$REMOTE_SH" run lab 'echo new > $SNAP/hornhoof/target/coverage/new.info; exit 3' > /dev/null 2>&1
  check "coverage came back" '[ -f "$HNB_ROOT/hornhoof/target/coverage/new.info" ]'
}

test_a_run_leaves_nothing_and_the_last_run_removes_the_image() {
  "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "container gone" '[ -z "$(ls "$FAKE_STATE/containers")" ]'
  check "network gone" '[ -z "$(ls "$FAKE_STATE/networks")" ]'
  check "folder gone" '[ -z "$(ls "$(tests_home)/runs")" ]'
  check "image gone" '! image_loaded hnb-build_1'
  check "image file stays" '[ -f "$(tests_home)/images/hnb-build.tar" ]'
  check "image was loaded from the file" 'calls | grep -q "^docker load -i .*hnb-build.tar"'
}

test_image_stays_while_another_run_lives() {
  "$REMOTE_SH" run long 'sleep 60' > /dev/null 2>&1 & local pid=$!
  wait_for '[ "$(containers_named hnb-run-long)" = 1 ]'
  "$REMOTE_SH" run short 'true' > /dev/null 2>&1
  check "image stays for the running run" 'image_loaded hnb-build_1'
  kill -TERM "$pid"; wait "$pid" 2>/dev/null
  check "image goes with the last run" '! image_loaded hnb-build_1'
}

test_sigterm_midway_leaves_nothing() {
  "$REMOTE_SH" run --dind lab 'echo first-line; sleep 60' > "$T/out" 2> /dev/null & local pid=$!
  wait_for '[ "$(containers_named hnb-run-lab)" = 1 ] && grep -q first-line "$T/out"'
  kill -TERM "$pid"; wait "$pid"; local rc=$?
  check "exit is 143" '[ "$rc" = 143 ]'
  check "containers gone" '[ -z "$(ls "$FAKE_STATE/containers")" ]'
  check "volume gone" '[ -z "$(ls "$FAKE_STATE/volumes")" ]'
  check "network gone" '[ -z "$(ls "$FAKE_STATE/networks")" ]'
  check "folder gone" '[ -z "$(ls "$(tests_home)/runs")" ]'
  check "image gone" '! image_loaded hnb-build_1 && ! image_loaded hnb-dind_29.7.1'
}

make_leftovers() {
  mkdir -p "$FAKE_STATE/containers/hnb-run-old-20200101-000000-1" "$FAKE_STATE/containers/hnb-dind-20200101-000000-1"
  mkdir -p "$FAKE_STATE/volumes/hnb-dind-20200101-000000-1" "$FAKE_STATE/networks/hnb-net-20200101-000000-1"
  mkdir -p "$(tests_home)/runs/old-20200101-000000-1/hornhoof"
}

test_clean_removes_leftovers_and_spares_live_runs_and_strangers() {
  "$REMOTE_SH" run live 'sleep 60' > /dev/null 2>&1 & local pid=$!
  wait_for '[ "$(containers_named hnb-run-live)" = 1 ]'
  make_leftovers
  "$REMOTE_SH" clean > /dev/null 2>&1
  check "old container gone" '[ "$(containers_named 20200101)" = 0 ]'
  check "old volume gone" '[ ! -e "$FAKE_STATE/volumes/hnb-dind-20200101-000000-1" ]'
  check "old network gone" '[ ! -e "$FAKE_STATE/networks/hnb-net-20200101-000000-1" ]'
  check "old folder gone" '[ ! -e "$(tests_home)/runs/old-20200101-000000-1" ]'
  check "live container stays" '[ "$(containers_named hnb-run-live)" = 1 ]'
  check "live folder stays" '[ -n "$(snapshot_dir live)" ]'
  check "image stays for the live run" 'image_loaded hnb-build_1'
  kill -TERM "$pid"; wait "$pid" 2>/dev/null
}

test_clean_removes_the_image_when_nothing_lives() {
  touch "$FAKE_STATE/images/hnb-build_1"
  "$REMOTE_SH" clean > /dev/null 2>&1
  check "image gone" '! image_loaded hnb-build_1'
  check "image file stays" '[ -f "$(tests_home)/images/hnb-build.tar" ]'
}

test_a_killed_caller_leaves_things_that_clean_can_take() {
  "$REMOTE_SH" run lab 'sleep 1' > /dev/null 2>&1 & local pid=$!
  wait_for '[ "$(containers_named hnb-run-lab)" = 1 ]'
  kill -KILL "$pid"; wait "$pid" 2>/dev/null
  wait_for '[ -e "$(ls -d "$FAKE_STATE"/containers/hnb-run-lab-*/rc 2>/dev/null | head -1)" ]'
  sleep 0.5
  "$REMOTE_SH" clean > /dev/null 2>&1
  check "container taken" '[ -z "$(ls "$FAKE_STATE/containers")" ]'
  check "folder taken" '[ -z "$(ls "$(tests_home)/runs")" ]'
  check "image taken" '! image_loaded hnb-build_1'
}

test_status_shows_only_our_things_and_the_disk() {
  make_leftovers
  local out; out=$("$REMOTE_SH" status 2>&1)
  check "shows ours" '[[ "$out" == *hnb-run-old-20200101-000000-1* ]]'
  check "hides others" '[[ "$out" != *hornhoof-machine-1* ]] && [[ "$out" != *k3d-tools-0* ]]'
  check "shows the disk" '[[ "$out" == *Filesystem* ]] || [[ "$out" == *Avail* ]]'
  check "shows the slots" '[[ "$out" == *"slots: 0 of 3 busy"* ]]'
}

test_at_most_three_runs_at_once() {
  local i pids=()
  for i in 1 2 3 4; do
    "$REMOTE_SH" run "lab$i" 'sleep 60' > /dev/null 2>&1 & pids+=($!)
  done
  wait_for '[ "$(containers_named hnb-run-)" = 3 ]'
  sleep 1
  check "the fourth waits" '[ "$(containers_named hnb-run-)" = 3 ]'
  check "the fourth has its snapshot already" '[ "$(ls "$(tests_home)/runs" | wc -l)" = 4 ]'
  local running; running=$(ls "$FAKE_STATE/containers" | head -1)
  "$FAKE_REMOTE_BIN/fake-docker" rm -f "$running"
  wait_for '[ "$(containers_named hnb-run-)" = 3 ] && [ -z "$(ls "$FAKE_STATE/containers" | grep "$running")" ]'
  for i in "${pids[@]}"; do kill -TERM "$i" 2>/dev/null; done
  for i in "${pids[@]}"; do wait "$i" 2>/dev/null; done
  check "all gone" '[ -z "$(ls "$FAKE_STATE/containers")" ]'
}

fill_the_slots() {
  local i
  for i in 1 2 3; do
    "$REMOTE_SH" run "busy$i" 'sleep 60' > /dev/null 2>&1 & FILLERS+=($!)
  done
  wait_for '[ "$(containers_named hnb-run-busy)" = 3 ]'
}

free_one_slot() {
  local running; running=$(ls "$FAKE_STATE/containers" | grep hnb-run-busy | head -1)
  "$FAKE_REMOTE_BIN/fake-docker" rm -f "$running"
}

stop_all() {
  local pid
  for pid in "$@"; do kill -TERM "$pid" 2> /dev/null; done
  for pid in "$@"; do wait "$pid" 2> /dev/null; done
}

test_the_oldest_waiter_gets_the_next_slot() {
  FILLERS=()
  fill_the_slots
  "$REMOTE_SH" run older 'sleep 60' > /dev/null 2>&1 & local older=$!
  wait_for '[ -n "$(snapshot_dir older)" ]'
  sleep 1.1
  "$REMOTE_SH" run newer 'sleep 60' > /dev/null 2>&1 & local newer=$!
  wait_for '[ -n "$(snapshot_dir newer)" ]'
  sleep 0.5
  free_one_slot
  wait_for '[ "$(containers_named hnb-run-older)" = 1 ]'
  sleep 1
  check "the newer one still waits" '[ "$(containers_named hnb-run-newer)" = 0 ]'
  stop_all "${FILLERS[@]}" "$older" "$newer"
  check "no ticket left" '[ -z "$(ls "$HNB_ROOT/network-build/tmp/remote/queue")" ]'
}

test_a_dead_waiter_does_not_block_the_queue() {
  FILLERS=()
  fill_the_slots
  "$REMOTE_SH" run dead 'sleep 60' > /dev/null 2>&1 & local dead=$!
  wait_for '[ -n "$(snapshot_dir dead)" ]'
  sleep 1.1
  "$REMOTE_SH" run alive 'sleep 60' > /dev/null 2>&1 & local alive=$!
  wait_for '[ -n "$(snapshot_dir alive)" ]'
  sleep 0.5
  kill -KILL "$dead"; wait "$dead" 2> /dev/null
  sleep 0.5
  free_one_slot
  wait_for '[ "$(containers_named hnb-run-alive)" = 1 ]'
  stop_all "${FILLERS[@]}" "$alive"
  "$REMOTE_SH" clean > /dev/null 2>&1
  check "clean takes the dead waiter's folder" '[ -z "$(snapshot_dir dead)" ]'
}

test_a_waiter_killed_by_sigterm_leaves_no_ticket() {
  FILLERS=()
  fill_the_slots
  "$REMOTE_SH" run waits 'sleep 60' > /dev/null 2>&1 & local waits=$!
  wait_for '[ -n "$(ls "$HNB_ROOT/network-build/tmp/remote/queue" 2> /dev/null)" ]'
  kill -TERM "$waits"; wait "$waits" 2> /dev/null
  check "ticket gone" '[ -z "$(ls "$HNB_ROOT/network-build/tmp/remote/queue")" ]'
  stop_all "${FILLERS[@]}"
}

test_a_dropped_connection_does_not_lose_the_exit_code() {
  touch "$FAKE_STATE/drop-stream"
  local out rc
  out=$("$REMOTE_SH" run lab 'sleep 0.3; echo after-drop; exit 5' 2> /dev/null); rc=$?
  check "exit code kept" '[ "$rc" = 5 ]'
  check "output kept" '[[ "$out" == *after-drop* ]]'
}

test_refuses_to_start_on_a_full_disk() {
  HNB_MIN_FREE_GB=999999999 "$REMOTE_SH" run lab 'echo never' > "$T/out" 2>&1; local rc=$?
  check "refused" '[ "$rc" != 0 ]'
  check "said why" 'grep -qi "disk" "$T/out"'
  check "no container" '! calls | grep -q "name hnb-run-"'
  check "no folder" '[ -z "$(snapshot_dir lab)" ]'
}

test_missing_image_file_is_a_clear_error() {
  rm -f "$(tests_home)/images/hnb-build.tar"
  "$REMOTE_SH" run lab 'echo never' > "$T/out" 2>&1; local rc=$?
  check "refused" '[ "$rc" != 0 ]'
  check "names the fix" 'grep -q "remote.sh image" "$T/out"'
}

test_image_build_leaves_only_the_files() {
  "$REMOTE_SH" image > "$T/out" 2>&1; local rc=$?
  check "builds" '[ "$rc" = 0 ]'
  check "through docker run and commit" 'calls | grep -q "^docker commit "'
  check "no builder" '! calls | grep -Eq "^docker (build|buildx|builder)"'
  check "build container gone" '[ -z "$(ls "$FAKE_STATE/containers")" ]'
  check "base pulled, then removed since we brought it" 'calls | grep -q "^docker pull node:22" && calls | grep -q "^docker rmi node:22"'
  check "image files exist" '[ -f "$(tests_home)/images/hnb-build.tar" ] && [ -f "$(tests_home)/images/hnb-dind.tar" ]'
  check "our images removed" 'calls | grep -q "^docker rmi hnb-build:1" && calls | grep -q "^docker rmi hnb-dind:29.7.1"'
  check "no build folder" '[ ! -e "$(tests_home)/build-context" ]'
}

test_image_build_keeps_a_base_someone_else_had() {
  touch "$FAKE_STATE/images/node_22.23.4-bookworm-slim_sha256_4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da"
  "$REMOTE_SH" image > "$T/out" 2>&1
  check "not pulled" '! calls | grep -q "^docker pull node:22"'
  check "not removed" '! calls | grep -q "^docker rmi node:22"'
}

test_image_build_that_fails_leaves_nothing() {
  echo 9 > "$FAKE_STATE/provision-rc"
  "$REMOTE_SH" image > "$T/out" 2>&1; local rc=$?
  check "fails" '[ "$rc" != 0 ]'
  check "the base it brought is gone" 'calls | grep -q "^docker rmi node:22"'
  check "builder gone" 'calls | grep -q "^docker rm -f -v hnb-image-build-"'
  check "network gone" '[ -z "$(ls "$FAKE_STATE/networks")" ]'
  check "no half-written image file" '[ ! -e "$(tests_home)/images/hnb-build.tar.tmp" ]'
  check "no build folder" '[ ! -e "$(tests_home)/build-context" ]'
}

test_lane_tree_stands_in_for_the_real_one_at_the_usual_path() {
  make_lane one hornhoof-edge
  echo lane-content > "$HNB_ROOT/wt/one/source.txt"
  local out call
  out=$(REMOTE_EDGE_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run lab 'cat $SNAP/hornhoof-edge/source.txt; cat $SNAP/hornhoof/source.txt' 2> /dev/null)
  call=$(run_call lab)
  check "sees the lane's file" '[[ "$out" == *lane-content* ]]'
  check "the other repository is the real one" '[[ "$out" == *source* ]]'
  check "mounted at the usual path" '[[ "$call" == *":$CONTAINER_ROOT/hornhoof-edge "* ]]'
  check "the lane has its own base" '[ "$(cat "$(tests_home)/base/one/source.txt")" = lane-content ]'
  check "the real base is untouched" '[ "$(cat "$(tests_home)/base/hornhoof-edge/source.txt")" = source ]'
  check "the lane's marker went with it" '[ -f "$(tests_home)/base/one/.lane-repo" ]'
}

test_hornhoof_lane_stands_in_too() {
  make_lane two hornhoof
  echo lane-content > "$HNB_ROOT/wt/two/source.txt"
  local out
  out=$(REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'cat $SNAP/hornhoof/source.txt' 2> /dev/null)
  check "sees the lane's file" '[[ "$out" == *lane-content* ]]'
}

test_lane_results_come_back_to_the_lane_only() {
  make_lane one hornhoof-edge
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run lab 'mkdir -p $SNAP/hornhoof-edge/target/coverage $SNAP/hornhoof-edge/.metrics; echo new > $SNAP/hornhoof-edge/target/coverage/new.info; echo new > $SNAP/hornhoof-edge/.metrics/new.edn' > /dev/null 2>&1
  check "coverage in the lane" '[ -f "$HNB_ROOT/wt/one/target/coverage/new.info" ]'
  check "metrics in the lane" '[ -f "$HNB_ROOT/wt/one/.metrics/new.edn" ]'
  check "nothing in the real tree" '[ ! -e "$HNB_ROOT/hornhoof-edge/target/coverage/new.info" ] && [ ! -e "$HNB_ROOT/hornhoof-edge/.metrics/new.edn" ]'
}

test_lane_git_stands_on_its_own_in_the_container() {
  make_lane one hornhoof-edge
  local head; head=$(git -C "$HNB_ROOT/hornhoof-edge" rev-parse HEAD)
  local cmd='cd $SNAP/hornhoof-edge; [ -e .git/objects/info/alternates ] && echo still-has-alternates; GIT_NO_LAZY=1 git cat-file -e lanebase^{commit} && echo has-lanebase; git cat-file -e '"$head"' && echo has-real-commit'
  local out
  out=$(REMOTE_EDGE_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run lab "$cmd" 2> /dev/null)
  check "alternates are gone: their path is the lane itself in the container" '[[ "$out" != *still-has-alternates* ]]'
  check "lanebase is readable" '[[ "$out" == *has-lanebase* ]]'
  check "the real repository s objects came along" '[[ "$out" == *has-real-commit* ]]'
  check "the local lane keeps its alternates" '[ -e "$HNB_ROOT/wt/one/.git/objects/info/alternates" ]'
}

test_two_lanes_at_once_do_not_share_a_snapshot() {
  make_lane one hornhoof-edge
  make_lane two hornhoof-edge
  echo content-one > "$HNB_ROOT/wt/one/source.txt"
  echo content-two > "$HNB_ROOT/wt/two/source.txt"
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run first 'sleep 60' > /dev/null 2>&1 & local a=$!
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run second 'sleep 60' > /dev/null 2>&1 & local b=$!
  wait_for '[ "$(containers_named hnb-run-)" = 2 ]'
  local snap_a snap_b; snap_a=$(snapshot_dir first); snap_b=$(snapshot_dir second)
  check "two folders" '[ -n "$snap_a" ] && [ -n "$snap_b" ] && [ "$snap_a" != "$snap_b" ]'
  check "first has its lane" '[ "$(cat "$snap_a/hornhoof-edge/source.txt")" = content-one ]'
  check "second has its lane" '[ "$(cat "$snap_b/hornhoof-edge/source.txt")" = content-two ]'
  kill -TERM "$a" "$b"; wait "$a" "$b" 2>/dev/null
}

test_hornhoof_lane_links_the_main_modules_when_the_lock_is_the_same() {
  "$REMOTE_SH" run main 'true' > /dev/null 2>&1
  make_lane two hornhoof
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'sleep 60' > /dev/null 2>&1 & local pid=$!
  wait_for '[ "$(containers_named hnb-run-lab)" = 1 ]'
  local base; base=$(tests_home)/base
  check "no second install" '[ "$(calls | grep -c "name hnb-npm-")" = 1 ]'
  check "lane base links the main modules" '[ "$(stat -c %i "$base/two/node_modules/pkg/index.js")" = "$(stat -c %i "$base/hornhoof/node_modules/pkg/index.js")" ]'
  check "the snapshot has them" '[ -f "$(snapshot_dir lab)/hornhoof/node_modules/pkg/index.js" ]'
  kill -TERM "$pid"; wait "$pid" 2>/dev/null
}

test_hornhoof_lane_with_the_main_lock_shares_a_first_install() {
  make_lane two hornhoof
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "one install" '[ "$(calls | grep -c "name hnb-npm-")" = 1 ]'
  check "in the main base" 'calls | grep "name hnb-npm-" | grep -q "base/hornhoof:$CONTAINER_ROOT/hornhoof "'
  local base; base=$(tests_home)/base
  check "linked into the lane" '[ "$(stat -c %i "$base/two/node_modules/pkg/index.js")" = "$(stat -c %i "$base/hornhoof/node_modules/pkg/index.js")" ]'
}

test_hornhoof_lane_with_another_lock_installs_in_its_own_base() {
  "$REMOTE_SH" run main 'true' > /dev/null 2>&1
  make_lane two hornhoof
  echo lock-of-the-lane > "$HNB_ROOT/wt/two/package-lock.json"
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "installs" '[ "$(calls | grep -c "name hnb-npm-")" = 2 ]'
  check "in the lane base, at the usual path" 'calls | grep "name hnb-npm-" | tail -1 | grep -q "base/two:$CONTAINER_ROOT/hornhoof "'
  "$REMOTE_SH" run main 'true' > /dev/null 2>&1
  check "the main base did not reinstall" '[ "$(calls | grep -c "name hnb-npm-")" = 2 ]'
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  check "nor the lane, its lock is unchanged" '[ "$(calls | grep -c "name hnb-npm-")" = 2 ]'
}

test_a_tree_that_is_no_lane_is_refused() {
  make_lane one hornhoof-edge
  make_lane hornhoof hornhoof
  mkdir -p "$T/elsewhere"; echo hornhoof-edge > "$T/elsewhere/.lane-repo"
  local rc
  REMOTE_EDGE_TREE=$T/elsewhere "$REMOTE_SH" run lab 'true' > /dev/null 2>&1; rc=$?
  check "outside wt" '[ "$rc" = 2 ]'
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run lab 'true' > /dev/null 2>&1; rc=$?
  check "a lane of the other repository" '[ "$rc" = 2 ]'
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/none "$REMOTE_SH" run lab 'true' > /dev/null 2>&1; rc=$?
  check "missing" '[ "$rc" = 2 ]'
  REMOTE_HORNHOOF_TREE=$HNB_ROOT/wt/hornhoof "$REMOTE_SH" run lab 'true' > /dev/null 2>&1; rc=$?
  check "a name the main base uses" '[ "$rc" = 2 ]'
  check "nothing ran" '[ ! -s "$FAKE_STATE/calls.log" ]'
}

test_clean_removes_the_base_of_a_lane_gone_here() {
  make_lane one hornhoof-edge
  make_lane two hornhoof-edge
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/one "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  REMOTE_EDGE_TREE=$HNB_ROOT/wt/two "$REMOTE_SH" run lab 'true' > /dev/null 2>&1
  rm -rf "$HNB_ROOT/wt/one"
  "$REMOTE_SH" clean > /dev/null 2>&1
  local base; base=$(tests_home)/base
  check "gone lane removed" '[ ! -e "$base/one" ]'
  check "living lane stays" '[ -d "$base/two" ]'
  check "main bases stay" '[ -d "$base/hornhoof" ] && [ -d "$base/hornhoof-edge" ] && [ -d "$base/network-build" ]'
}

copy_with_root() { sed "s#^ROOT=.*#ROOT=$HNB_ROOT#; s#^root=.*#root=$HNB_ROOT/network-build#" "$1" > "$2"; chmod 755 "$2"; }

test_mutate_scripts_read_the_worker_count() {
  local build=$HNB_ROOT/network-build name
  mkdir -p "$HNB_ROOT/quality/bin"
  printf '#!/bin/sh\necho "$@"\n' > "$build/changed-lines.sh"
  printf '#!/bin/sh\necho "ARGS $*"\n' > "$build/heavy.sh"
  chmod 755 "$build/changed-lines.sh" "$build/heavy.sh"
  for name in mutate.sh mutate-helper.sh; do
    copy_with_root "$BUILD/$name" "$build/$name"
    check "$name defaults to 2" '"$build/$name" r b f t | grep -q -- "--max-workers 2 "'
    check "$name takes 4" 'MUTATOR_WORKERS=4 "$build/$name" r b f t | grep -q -- "--max-workers 4 "'
  done
}

test_heavy_keeps_its_guard_except_for_a_runs_own_inner_docker() {
  local build=$HNB_ROOT/network-build
  copy_with_root "$BUILD/heavy.sh" "$build/heavy.sh"
  local out
  out=$(LIGHT=1 DOCKER_HOST=unix:///var/run/docker.sock "$build/heavy.sh" sh -c 'echo "$DOCKER_HOST|$PATH"')
  check "guard holds against the host socket" '[[ "$out" == "unix://$build/tmp/no-docker.sock|$build/nodocker:"* ]]'
  out=$(LIGHT=1 "$build/heavy.sh" sh -c 'echo "$DOCKER_HOST|$PATH"')
  check "guard holds by default" '[[ "$out" == "unix://$build/tmp/no-docker.sock|$build/nodocker:"* ]]'
  out=$(LIGHT=1 DOCKER_HOST=tcp://127.0.0.1:2375 "$build/heavy.sh" sh -c 'echo "$DOCKER_HOST|$PATH"')
  check "inner docker passes" '[[ "$out" == "tcp://127.0.0.1:2375|"* ]] && [[ "$out" != *nodocker* ]]'
}

main() {
  local filter=${1:-} name
  mkdir -p "$BUILD/tmp"
  for name in $(declare -F | awk '{print $3}' | grep '^test_'); do
    [[ "$name" == *"$filter"* ]] || continue
    current=$name
    echo "- $name"
    setup
    "$name"
    teardown
  done
  echo "passed $passed, failed $failed"
  [ "$failed" = 0 ]
}

main "$@"
