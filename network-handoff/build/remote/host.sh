#!/bin/bash
# The side of remote.sh that runs on home-api. That machine also runs other people's projects, so every Docker action goes
# through the small functions below, which refuse a name without the hnb- prefix, and every listing keeps only hnb- names.
# Usage: host.sh <prepare|start|stream|wait|remove|remove_images|clean|status|build_image> [args...]
set -euo pipefail

TESTS_HOME=$HOME/hornhoof-network-tests
BASE=$TESTS_HOME/base
RUNS=$TESTS_HOME/runs
IMAGES=$TESTS_HOME/images
CONTEXT=$TESTS_HOME/build-context
PREPARE_LOCK=$TESTS_HOME/prepare.lock
SAME_PATH=/home/altera/hornhoof-network
TREES=(hornhoof hornhoof-edge network-build)
RUN_IMAGE=hnb-build:1
DIND_IMAGE=hnb-dind:29.7.1
DIND_SOURCE=docker:29.7.1-dind@sha256:e8faad5a8dc5279dff929afc5449f2791736912fff9f99351d742db2fad01b4c
NODE_BASE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
INNER_DOCKER=tcp://127.0.0.1:2375
IMAGE_PATH=/home/altera/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CPUS=3
BUILD_PROTOCOL='npm run build -w @hornhoof/protocol'

log() { echo "remote: $*" >&2; }
dk() { sudo -n docker "$@"; }

must_be_ours() {
  case "$1" in
    hnb-*) ;;
    *) log "refusing to touch $1: it is not ours"; exit 70 ;;
  esac
}

rm_container() { must_be_ours "$1"; dk rm -f -v "$1" > /dev/null 2>&1 || true; }
rm_volume() { must_be_ours "$1"; dk volume rm "$1" > /dev/null 2>&1 || true; }
rm_network() { must_be_ours "$1"; dk network rm "$1" > /dev/null 2>&1 || true; }
rm_image() { must_be_ours "$1"; dk rmi "$1" > /dev/null 2>&1 || true; }

only_ours() { grep -E '^hnb-' || true; }
list_containers() { dk ps -a --filter 'name=^hnb-' --format '{{.Names}}' | only_ours; }
list_volumes() { dk volume ls --filter 'name=^hnb-' --format '{{.Name}}' | only_ours; }
list_networks() { dk network ls --filter 'name=^hnb-' --format '{{.Name}}' | only_ours; }
list_images() { dk images --filter 'reference=hnb-*' --format '{{.Repository}}:{{.Tag}}' | only_ours; }

image_present() { dk image inspect "$1" --format . > /dev/null 2>&1; }
ensure_network() { dk network create "$1" > /dev/null 2>&1 || true; }

ensure_image() {
  [ -z "$(dk images -q "$1")" ] || return 0
  [ -f "$IMAGES/$2" ] || { log "no image file $2 on home-api: run remote.sh image first"; exit 66; }
  log "loading $1"
  dk load -i "$IMAGES/$2" > /dev/null
}

check_disk() {
  local free
  free=$(df --output=avail -BG "$TESTS_HOME" | tail -1 | tr -dc 0-9)
  [ "$free" -ge "$1" ] && return 0
  log "disk too full for a run: $free GB free, a run needs $1 GB"
  exit 75
}

lock_sum() { sha256sum < "$BASE/$1/package-lock.json" | cut -d' ' -f1; }
mark_of() { printf '%s' "$BASE/.lock-sha256-$1"; }

deps_are_stale() {
  [ "$(cat "$(mark_of "$1")" 2> /dev/null)" != "$(lock_sum "$1")" ] ||
    [ ! -d "$BASE/$1/node_modules" ] ||
    [ ! -d "$BASE/$1/packages/protocol/dist" ]
}

npm_in_base() {
  local tree=$1 stamp=$2 command=$3
  log "in the base of $tree: $command"
  ensure_network "hnb-net-$stamp"
  dk run --rm --name "hnb-npm-$stamp" --user 1000:1000 --network "hnb-net-$stamp" --cpus "$CPUS" --memory 8g \
    --env HOME=/home/altera --env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -v "$BASE/$tree:$SAME_PATH/hornhoof" --workdir "$SAME_PATH/hornhoof" \
    "$RUN_IMAGE" nice -n 10 bash -c "$command" >&2
}

# A lane nearly always has the main base's lock. Hard links then save a full install; npm ci unlinks before it writes, so
# a later install on either side leaves the other alone.
link_main_modules() {
  local tree=$1
  [ "$tree" != hornhoof ] && [ -d "$BASE/hornhoof/node_modules" ] &&
    [ "$(cat "$(mark_of hornhoof)" 2> /dev/null)" = "$(lock_sum "$tree")" ] || return 1
  (cd "$BASE/$tree" && find . -name node_modules -prune -exec rm -rf {} +)
  link_big_folders "$BASE/hornhoof" "$BASE/$tree"
}

# The mark goes first and comes back last, so that an install that fails or is killed is repeated by the next run.
install_deps() {
  local tree=$1 stamp=$2 command="npm ci && $BUILD_PROTOCOL"
  deps_are_stale "$tree" || return 0
  rm -f "$(mark_of "$tree")"
  if link_main_modules "$tree"; then
    command=$BUILD_PROTOCOL
    [ ! -d "$BASE/$tree/packages/protocol/dist" ] || command=""
  fi
  [ -z "$command" ] || npm_in_base "$tree" "$stamp" "$command"
  lock_sum "$tree" > "$(mark_of "$tree")"
}

# Tools write some files in place: mutator its source and metrics, tsc its dist, git its logs. A hard link would carry such
# a write into the base and every other snapshot, so only what is big and never written in place stays linked.
copy_real() { rsync -a --exclude=node_modules --exclude=relay/test/.bin "$1/" "$2/"; }

link_big_folders() {
  local folder
  (cd "$1" && find . \( -name node_modules -o -path ./relay/test/.bin \) -prune -print) | while IFS= read -r folder; do
    mkdir -p "$2/$(dirname "$folder")"
    cp -al "$1/$folder" "$2/$folder"
  done
}

# A lane with the main lock waits for the main install and links it, so that lanes do not each install the same modules.
install_main_for_lane() {
  local tree=$1 stamp=$2
  [ "$tree" = hornhoof ] || [ "$(lock_sum "$tree")" != "$(lock_sum hornhoof)" ] || install_deps hornhoof "$stamp"
}

copy_tree() {
  copy_real "$BASE/$1" "$2"
  link_big_folders "$BASE/$1" "$2"
}

# A lane is a --shared clone: its alternates file names the real repository's path, and in the container that path is the
# lane itself. So the snapshot takes the real repository's objects in and drops the file. Objects never change, so links do.
own_git_objects() {
  local from=$BASE/$1/.git/objects to=$2/.git/objects
  rm -f "$to/info/alternates"
  rsync -a --ignore-existing --exclude=/info --link-dest="$from" "$from/" "$to/"
}

snapshot_repo() {
  local repo=$1 tree=$2 dir=$3
  copy_tree "$tree" "$dir/$repo"
  [ "$tree" = "$repo" ] || own_git_objects "$repo" "$dir/$repo"
}

snapshot() {
  local dir=$RUNS/$1 edge_tree=$2 hornhoof_tree=$3
  mkdir -p "$dir/tmp"
  chmod 1777 "$dir/tmp"
  snapshot_repo hornhoof-edge "$edge_tree" "$dir"
  snapshot_repo hornhoof "$hornhoof_tree" "$dir"
  copy_tree network-build "$dir/network-build"
  mkdir -p "$dir/network-build/tmp"
}

prepare() {
  local name=$1 stamp=$2 dind=$3 min_free=$4 edge_tree=$5 hornhoof_tree=$6
  exec 7> "$PREPARE_LOCK"
  flock 7
  check_disk "$min_free"
  ensure_image "$RUN_IMAGE" hnb-build.tar
  [ "$dind" = 0 ] || ensure_image "$DIND_IMAGE" hnb-dind.tar
  install_main_for_lane "$hornhoof_tree" "$stamp"
  install_deps "$hornhoof_tree" "$stamp"
  snapshot "$name" "$edge_tree" "$hornhoof_tree"
}

set_mounts() {
  local dir=$RUNS/$1 tree
  MOUNTS=(-v "$dir/tmp:/tmp")
  for tree in "${TREES[@]}"; do
    MOUNTS+=(-v "$dir/$tree:$SAME_PATH/$tree")
  done
}

wait_for_inner_docker() {
  local _
  for _ in $(seq 90); do
    dk exec "$1" docker version > /dev/null 2>&1 && return 0
    sleep 1
  done
  log "the inner Docker did not start"
  exit 71
}

# dockerd answers on loopback only. Its default of 0.0.0.0 would give any neighbour on the network a root Docker with no
# password. The test container shares this network namespace, so it reaches 127.0.0.1 and nothing else does.
start_dind() {
  local stamp=$1 dind=hnb-dind-$1
  dk volume create "$dind" > /dev/null
  dk run --detach --name "$dind" --privileged --network "hnb-net-$stamp" --cpus "$CPUS" --memory 24g --env DOCKER_TLS_CERTDIR= \
    -v "$dind:/var/lib/docker" "${MOUNTS[@]}" \
    "$DIND_IMAGE" dockerd --host=unix:///var/run/docker.sock "--host=$INNER_DOCKER" --tls=false > /dev/null
  wait_for_inner_docker "$dind"
}

set_docker_access() {
  local stamp=$1 dind=$2
  if [ "$dind" = 1 ]; then
    DOCKER_ACCESS=(--network "container:hnb-dind-$stamp" --env "DOCKER_HOST=$INNER_DOCKER")
  else
    DOCKER_ACCESS=(--network "hnb-net-$stamp" --env "PATH=$SAME_PATH/network-build/nodocker:$IMAGE_PATH"
      --env "DOCKER_HOST=unix://$SAME_PATH/network-build/tmp/no-docker.sock")
  fi
}

start_test_container() {
  local name=$1 command=$2
  dk run --detach --init --name "hnb-run-$name" --user 1000:1000 --cpus "$CPUS" --memory 24g --pids-limit 16384 \
    --cap-drop ALL --security-opt no-new-privileges --log-driver json-file --log-opt max-size=500m --log-opt max-file=2 \
    --env HOME=/home/altera --env "VITEST_MAX_WORKERS=$CPUS" --env "MUTATOR_WORKERS=$CPUS" \
    "${DOCKER_ACCESS[@]}" "${MOUNTS[@]}" --workdir "$SAME_PATH" \
    "$RUN_IMAGE" bash -c 'exec 2>&1; exec nice -n 10 bash -c "$1"' hnb-run "$command" > /dev/null
}

start() {
  local name=$1 stamp=$2 dind=$3 command
  command=$(printf '%s' "$4" | base64 -d)
  set_mounts "$name"
  ensure_network "hnb-net-$stamp"
  [ "$dind" = 0 ] || start_dind "$stamp"
  set_docker_access "$stamp" "$dind"
  start_test_container "$name" "$command"
}

# Skipping the lines already received lets a broken connection resume without clocks or lost output. Line buffered, because
# tail on a pipe holds its output in 4096-byte blocks and logs would stay empty for many minutes.
stream() { dk logs --follow "$1" 2>&1 | stdbuf -oL tail -n "+$(($2 + 1))"; }
wait_container() { must_be_ours "$1"; dk wait "$1"; }

remove_folder() {
  local dir=$RUNS/$1
  [ -d "$dir" ] || return 0
  rm -rf "$dir" 2> /dev/null && return 0
  log "taking back files that a root process left in $1"
  ensure_image "$DIND_IMAGE" hnb-dind.tar
  dk run --rm --network none --entrypoint chown -v "$dir:/x" "$DIND_IMAGE" -R 1000:1000 /x
  chmod -R u+rwX "$dir"
  rm -rf "$dir"
}

# It waits for a prepare still running here, which a killed caller may have left behind, so that the prepare cannot
# recreate the folder after it was removed.
remove_run() {
  local name=$1 stamp=$2
  rm_container "hnb-npm-$stamp"
  rm_container "hnb-run-$name"
  rm_container "hnb-dind-$stamp"
  rm_volume "hnb-dind-$stamp"
  rm_network "hnb-net-$stamp"
  exec 7> "$PREPARE_LOCK"
  flock 7
  remove_folder "$name"
}

remove_images() {
  rm_image "$RUN_IMAGE"
  rm_image "$DIND_IMAGE"
}

is_live() {
  local name=$1 stamp
  shift
  for stamp in "$@"; do
    case "$name" in *-"$stamp") return 0 ;; esac
  done
  return 1
}

remove_gone_lanes() {
  local kept=",$1," folder name
  for folder in "$BASE"/*/; do
    [ -d "$folder" ] || continue
    name=$(basename "$folder")
    case "$name" in hornhoof|hornhoof-edge|network-build) continue ;; esac
    case "$kept" in *",$name,"*) continue ;; esac
    log "lane $name is gone here: removing its base"
    rm -rf "$folder"
    rm -f "$(mark_of "$name")"
  done
}

# clean <lanes that still exist, comma separated> [stamps of live runs...]
clean() {
  local lanes=$1 name folder
  shift
  for name in $(list_containers); do is_live "$name" "$@" || rm_container "$name"; done
  for name in $(list_volumes); do is_live "$name" "$@" || rm_volume "$name"; done
  for name in $(list_networks); do is_live "$name" "$@" || rm_network "$name"; done
  for folder in "$RUNS"/*; do
    [ -d "$folder" ] || continue
    name=${folder##*/}
    is_live "$name" "$@" || remove_folder "$name"
  done
  remove_gone_lanes "$lanes"
}

show_folders() {
  du -sh "$BASE"/* "$IMAGES"/* 2> /dev/null || true
  du -sh "$RUNS"/* 2> /dev/null || true
}

status() {
  echo "== containers"; dk ps -a --filter 'name=^hnb-' --format '{{.Names}}  {{.Status}}' | only_ours
  echo "== volumes"; list_volumes
  echo "== networks"; list_networks
  echo "== images"; list_images
  echo "== folders"; show_folders
  echo "== disk"; df -h "$TESTS_HOME"
}

# Pulls what is not on the machine and remembers it, so that only what this build brought is removed afterwards.
pull_brought() {
  image_present "$1" && return 0
  dk pull "$1" >&2
  BROUGHT+=("$1")
}

make_dind_image() {
  pull_brought "$DIND_SOURCE"
  dk tag "$DIND_SOURCE" "$DIND_IMAGE"
  dk save "$DIND_IMAGE" > "$IMAGES/hnb-dind.tar.tmp"
  mv "$IMAGES/hnb-dind.tar.tmp" "$IMAGES/hnb-dind.tar"
  dk run --rm --entrypoint tar "$DIND_IMAGE" -C / -cf - usr/local/bin/docker usr/local/libexec/docker/cli-plugins > "$CONTEXT/docker-cli.tar"
}

provision() {
  dk run --name "hnb-image-build-$BUILD_STAMP" --network "hnb-net-$BUILD_STAMP" \
    -v "$BASE/hornhoof:$SAME_PATH/hornhoof:ro" -v "$BASE/network-build:$SAME_PATH/network-build:ro" -v "$CONTEXT:/ctx:ro" \
    "$NODE_BASE" bash /ctx/provision.sh >&2
}

commit_builder() {
  dk commit \
    --change 'ENV HOME=/home/altera' --change "ENV PATH=$IMAGE_PATH" --change 'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' \
    --change 'ENTRYPOINT []' --change 'CMD ["bash"]' --change 'USER 1000:1000' --change "WORKDIR $SAME_PATH" \
    "hnb-image-build-$BUILD_STAMP" "$RUN_IMAGE" > /dev/null
}

# docker run and docker commit, not docker build: a builder cache cannot be pruned by owner on a shared machine.
make_run_image() {
  pull_brought "$NODE_BASE"
  provision
  commit_builder
  dk save "$RUN_IMAGE" > "$IMAGES/hnb-build.tar.tmp"
  mv "$IMAGES/hnb-build.tar.tmp" "$IMAGES/hnb-build.tar"
}

# On success and on failure alike: the build leaves the two image files and nothing else.
remove_what_the_build_left() {
  local image
  rm_container "hnb-image-build-$BUILD_STAMP"
  rm_network "hnb-net-$BUILD_STAMP"
  rm -rf "$CONTEXT"
  rm -f "$IMAGES/hnb-build.tar.tmp" "$IMAGES/hnb-dind.tar.tmp"
  rm_image "$RUN_IMAGE"
  rm_image "$DIND_IMAGE"
  for image in "${BROUGHT[@]}"; do dk rmi "$image" > /dev/null 2>&1 || true; done
}

build_image() {
  BUILD_STAMP=$1
  BROUGHT=()
  trap remove_what_the_build_left EXIT
  mkdir -p "$IMAGES" "$CONTEXT"
  ensure_network "hnb-net-$BUILD_STAMP"
  make_dind_image
  make_run_image
  ls -la "$IMAGES" >&2
}

renice -n 10 -p $$ > /dev/null 2>&1 || true
command=${1:?usage: host.sh <subcommand> [args...]}
shift
case "$command" in
  prepare) prepare "$@" ;;
  start) start "$@" ;;
  stream) stream "$@" ;;
  wait) wait_container "$@" ;;
  remove) remove_run "$@" ;;
  remove_images) remove_images ;;
  clean) clean "$@" ;;
  status) status ;;
  build_image) build_image "$@" ;;
  *) log "unknown subcommand $command"; exit 64 ;;
esac
