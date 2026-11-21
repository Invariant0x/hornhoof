#!/usr/bin/env bash
# Hornhoof installer.
#
#   curl -fsSL <server>/install.sh | bash -s -- --join <code>   connect this machine and start the nodes in the code
#   install.sh                                                   update the nodes already on this machine
#   install.sh server                                            install or update the Hornhoof server
#   install.sh server --name <name>                              another company's server on this computer, in ~/hornhoof-<name>
#   install.sh --uninstall                                       remove this machine's nodes, and the company's core here
#   install.sh --uninstall [--name <name>]                       back up and remove a local server installation
#   install.sh worker                                            for the updater of a machine that joined: move its core
#
# A join also brings the company's small core to the machine: front, the keeper and the updater, in a folder of the
# company's own under the home folder, with no database and no secret of the company. The join's answer says so with a
# line "core <folder> <ticket> <port> <company>", which the keeper there redeems once; "core-here <port>" when this
# computer is the server's own, which has all of Hornhoof already; and "build <tag> <app> <node> <updater>" for the exact
# images of the build the server runs. The machine's nodes then reach the company at their own machine's front door.
#
# Server installs pin the build in .env as HORNHOOF_VERSION (HORNHOOF_VERSION=<tag> picks one, latest otherwise) and
# take compose.yaml from that build of the image. .env also names the exact app, node and updater images compose
# starts: by the build's tag, or as HORNHOOF_APP_REF, HORNHOOF_NODE_REF and HORNHOOF_UPDATER_REF give them. The updater
# service runs the installer of the build it moves to with HORNHOOF_FROM_UPDATER=1: no questions and no Docker setup,
# the compose file it brings, the images it checked by digest, and this server's nodes on this machine move to the
# same build. HORNHOOF_PULLED=1 says the images are on this computer already, so it downloads none of them. An updater
# that does not say HORNHOOF_UPDATER_REV=2 or later hands the update to the updater of this build first.
#
# Several companies can share a computer: each node carries the address of the server it works for, and an
# update or an uninstall touches only that server's nodes.
#
# On a computer that is not the server's own, joining and updating also start one updater for that server's nodes there, in
# a container of the updater image of the server's build (see apps/updater/lib/nodes.sh). It moves them to the server's build as
# their work ends, through the copy of this script inside its image, run with HORNHOOF_FROM_UPDATER=1 and the plan of one node
# in HORNHOOF_NODES_ONLY, and it goes with the nodes on --uninstall.
#
# The server fills in its own address when it serves this file, and the node image of its own build: by digest, by its
# commit's tag while the registry cannot say which digest, or "local" for a build CI did not make, which has no image
# published. A script downloaded on its own and a local build take the latest image; HORNHOOF_NODE_IMAGE comes before
# them all. The script arrives through a pipe, so every question is read from the terminal. It runs on the bash that
# ships with macOS (3.2).
set -euo pipefail

SERVER="${HORNHOOF_SERVER:-__HORNHOOF_SERVER__}"
TTY="${HORNHOOF_TTY:-/dev/tty}"
STATE_DIR="${HORNHOOF_HOME:-$HOME/.hornhoof}"
BUILD_IMAGE="__HORNHOOF_NODE_IMAGE__"
case "$BUILD_IMAGE" in
  __HORNHOOF_* | local) DEFAULT_IMAGE=ghcr.io/invariant0x/hornhoof-node:latest ;;
  *) DEFAULT_IMAGE=$BUILD_IMAGE ;;
esac
IMAGE="${HORNHOOF_NODE_IMAGE:-$DEFAULT_IMAGE}"
# The updater image of the server's build, which the server names as it does the node image, and the hash its own computer
# goes by (see host_id), which it fills in when it knows it. The updater of the nodes reads these lines too.
UPDATER_BUILD="__HORNHOOF_UPDATER_IMAGE__"
SERVER_HOST_ID="__HORNHOOF_HOST_ID__"
case "$UPDATER_BUILD" in __HORNHOOF_* | local) UPDATER_BUILD='' ;; esac
case "$SERVER_HOST_ID" in __HORNHOOF_*) SERVER_HOST_ID='' ;; esac
COMPOSE_URL="${HORNHOOF_COMPOSE_URL:-}"
APP_IMAGE=ghcr.io/invariant0x/hornhoof
BASE_DIR="${HORNHOOF_DIR:-$HOME/hornhoof}"
SERVER_DIR=$BASE_DIR
NAME=''
PIN="${HORNHOOF_VERSION:-}"
FROM_UPDATER="${HORNHOOF_FROM_UPDATER:-}"
# On Windows install.ps1 runs this script in a container, after it took the step that sets up Docker. The container has no
# browser, so a sign-in link goes into LINK_FILE, which install.ps1 watches and opens in the browser of Windows.
FROM_WINDOWS="${HORNHOOF_FROM_WINDOWS:-}"
LINK_FILE="${HORNHOOF_LINK_FILE:-/tmp/hornhoof-open-url}"
# How long a joined node may take to get its plan's sign-in from Hornhoof, in seconds.
SIGNIN_WAIT="${HORNHOOF_SIGNIN_WAIT:-20}"
# How long a machine's new core may take to get its place in the company from the server, in seconds.
CORE_WAIT="${HORNHOOF_CORE_WAIT:-120}"
# How long a server that was just started may take to answer and to take changes, in seconds.
ANSWER_WAIT="${HORNHOOF_ANSWER_WAIT:-120}"
COMPOSE_SRC="${HORNHOOF_COMPOSE_FILE:-}"
PULLED="${HORNHOOF_PULLED:-}"
APP_REF="${HORNHOOF_APP_REF:-}"
NODE_REF="${HORNHOOF_NODE_REF:-}"
UPDATER_REF="${HORNHOOF_UPDATER_REF:-}"
# An updater says so once the server let the work of the nodes on this computer end, or was told to stop it.
NODES_FREE="${HORNHOOF_NODES_FREE:-}"
# The ones of them it may replace, when the server said so of each: builtin, and the plan of each other node. The others go
# on with what they run. Empty: all of them.
NODES_ONLY="${HORNHOOF_NODES_ONLY:-}"
# A security update replaces the nodes now, and what they run stops with them.
URGENT=''
# The nodes this run left as they are, since it could not learn when their work ends.
LEFT=''

# Docker's and Homebrew's install scripts at the commits Hornhoof was tested with. They run as root or ask for the
# password, so each runs only when its SHA-256 is the one written here.
DOCKER_SCRIPT_URL=https://raw.githubusercontent.com/docker/docker-install/ada7a567e59b3935bd601bb21e422da50e80e376/install.sh
DOCKER_SCRIPT_SHA256="${HORNHOOF_DOCKER_SCRIPT_SHA256:-2b102d809152ea157a59f171319f489d971273b2d26dd7e9a6d1d737ce89289d}"
BREW_SCRIPT_URL=https://raw.githubusercontent.com/Homebrew/install/8c82c081753d4263da0cfe615ef8d9433425f22b/install.sh
BREW_SCRIPT_SHA256="${HORNHOOF_BREW_SCRIPT_SHA256:-5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148}"

LABEL=hornhoof.subscription
SERVER_LABEL=hornhoof.server
NODE_MAIN=/app/apps/node/dist/main.js
FIRST_PORT=8080
FIRST_PEER_PORT=8180
USAGE='Usage: install.sh [--join <code> [--owner-key <key>]] [--urgent] | server [--name <name>] [--urgent] | worker | --uninstall [--name <name>]'
UNREADABLE='Hornhoof sent a line this installer cannot read. Update Hornhoof and get a new command.'

OS=''
ARCH=''
DOCKER=(docker)
SUDO_SAID=''
# A person who watches in a terminal sees the headers in color. Output that goes anywhere else, or NO_COLOR, gets none.
COLOR_STEP=''
COLOR_DONE=''
COLOR_OFF=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  COLOR_STEP=$(printf '\033[1;36m')
  COLOR_DONE=$(printf '\033[1;32m')
  COLOR_OFF=$(printf '\033[0m')
fi
RULE='----------------------------------------------------------------'

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# step <number> <title> <what happens>: a header a person follows the run by, with what happens in the step in plain
# words. The updater runs with no one watching, so it shows none.
step() {
  [ -z "$FROM_UPDATER" ] || return 0
  say ''
  say "${COLOR_STEP}Step $1 of 4: $2${COLOR_OFF}"
  say "$3"
}

# ask <question> <default>: one line from the terminal, the default on Enter.
ask() {
  local answer=''
  printf '%s' "$1" >&2
  IFS= read -r answer < "$TTY" || true
  printf '%s' "${answer:-$2}"
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

detect_system() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) fail "Hornhoof nodes run on Linux and macOS only. This system reports $(uname -s)." ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64 | amd64) ARCH=x86_64 ;;
    *) fail "Hornhoof runs on arm64 and x86_64 processors only. This one reports $(uname -m)." ;;
  esac
}

# --- Docker -------------------------------------------------------------------------------------

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# checked_script <url> <sha256>: downloads a script into a file of its own and prints the file's path, or fails when
# the script is not exactly the one pinned.
checked_script() {
  local file
  file=$(mktemp)
  if curl -fsSL "$1" -o "$file" && [ "$(sha256_of "$file" 2> /dev/null || true)" = "$2" ]; then
    printf '%s' "$file"
    return 0
  fi
  rm -f "$file"
  return 1
}

docker_works() {
  if docker info > /dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  if [ "$OS" = linux ] && [ "$(id -u)" != 0 ] && command -v docker > /dev/null 2>&1 && command -v sudo > /dev/null 2>&1; then
    if [ -z "$SUDO_SAID" ]; then
      say "Your user may not use Docker directly here, so Hornhoof runs it through sudo. sudo may ask for your password."
      SUDO_SAID=1
    fi
    # shellcheck disable=SC2024 # the terminal is the person's input here, not a file sudo should read
    if sudo docker info > /dev/null 2>&1 < "$TTY"; then
      DOCKER=(sudo docker)
      return 0
    fi
  fi
  return 1
}

wait_for_docker() {
  local i=0
  while [ "$i" -lt 60 ]; do
    docker_works && return 0
    # Colima's socket, for a shell that has no Docker context for it yet.
    if [ "$OS" = darwin ] && [ -S "$HOME/.colima/default/docker.sock" ]; then export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"; fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

install_colima() {
  local script
  if ! command -v brew > /dev/null 2>&1; then
    say "Installing Homebrew, which Hornhoof uses to install Docker. Homebrew asks for your Mac password."
    script=$(checked_script "$BREW_SCRIPT_URL" "$BREW_SCRIPT_SHA256") ||
      fail "Homebrew's install script did not download, or it is not the one Hornhoof checked, so it did not run. Install Homebrew from https://brew.sh, then run this command again."
    /bin/bash "$script" < "$TTY" || fail "Homebrew did not install. Install it from https://brew.sh, then run this command again."
    rm -f "$script"
    if ! command -v brew > /dev/null 2>&1; then
      for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -x "$b" ]; then
          eval "$("$b" shellenv)"
          break
        fi
      done
    fi
    command -v brew > /dev/null 2>&1 || fail "Homebrew is installed but this terminal cannot find it yet. Open a new terminal and run this command again."
  fi
  say "Installing Colima and the Docker command line with Homebrew."
  brew install colima docker || fail "Homebrew could not install Colima. Run brew doctor, fix what it reports, then run this command again."
  size_colima
  say "Starting Colima and setting it to start when you log in."
  brew services start colima || fail "Colima did not start. Run colima start to see why, then run this command again."
}

# Colima starts with 2 processors and 2 GB of memory, too little for agents that build and test. A new one gets all of
# the Mac's processors and three quarters of its memory; one set up before, in any folder or profile, keeps what its
# owner gave it.
size_colima() {
  [ -n "$(colima list --json 2> /dev/null)" ] && return 0
  local cpus gb
  cpus=$(sysctl -n hw.ncpu 2> /dev/null || echo 2)
  gb=$(($(sysctl -n hw.memsize 2> /dev/null || echo 0) * 3 / 4 / 1073741824))
  [ "$cpus" -ge 2 ] 2> /dev/null || cpus=2
  [ "$gb" -ge 2 ] || gb=2
  say "Setting up Colima with $cpus processors and $gb GB of memory. The first start downloads its system and can take a few minutes."
  colima start --cpu "$cpus" --memory "$gb" || fail "Colima did not start. Run colima start to see why, then run this command again."
  colima stop || true
}

install_docker_engine() {
  local script
  say "Installing Docker Engine with Docker's official script. This needs admin rights, so sudo may ask for your password."
  script=$(checked_script "$DOCKER_SCRIPT_URL" "$DOCKER_SCRIPT_SHA256") ||
    fail "Docker's install script did not download, or it is not the one Hornhoof checked, so it did not run. Install Docker as described at https://docs.docker.com/engine/install/, then run this command again."
  # This installer may itself arrive through a pipe, so the script gets no input of its own.
  as_root sh "$script" < /dev/null ||
    fail "Docker did not install. Install it as described at https://docs.docker.com/engine/install/, then run this command again."
  rm -f "$script"
}

# Docker Desktop or OrbStack that is installed but not running starts like any app, the one the Docker command line
# belongs to first. Docker Desktop starts at login only when its owner turns that on, so the person hears how.
start_docker_app() {
  local first=Docker second=OrbStack app
  if [ "$(docker context show 2> /dev/null)" = orbstack ]; then
    first=OrbStack
    second=Docker
  fi
  for app in "$first" "$second"; do
    open -g -a "$app" > /dev/null 2>&1 || continue
    if [ "$app" = Docker ]; then
      say "Starting Docker Desktop. If it opens a window, answer it there; the first start can take a minute."
      say "So Hornhoof comes back after a restart, turn on Start Docker Desktop when you sign in to your computer, under Settings, General in Docker Desktop."
    else
      say "Starting OrbStack. If it opens a window, answer it there."
    fi
    return 0
  done
  return 1
}

ensure_docker() {
  say "Checking Docker."
  docker_works && return 0
  if [ "$OS" = darwin ]; then
    if command -v docker > /dev/null 2>&1 && ! command -v colima > /dev/null 2>&1; then
      start_docker_app || fail "Docker is installed but not running. Start Docker Desktop or OrbStack, then run this command again."
    else
      install_colima
    fi
  else
    command -v docker > /dev/null 2>&1 || install_docker_engine
    if ! docker_works; then
      say "Starting the Docker service. This needs admin rights, so sudo may ask for your password."
      as_root systemctl enable --now docker < "$TTY" || fail "The Docker service did not start. Run sudo systemctl status docker to see why."
    fi
  fi
  say "Waiting for Docker to start."
  wait_for_docker || fail "Docker did not start within 2 minutes. Start it by hand, then run this command again."
}

# --- Nodes --------------------------------------------------------------------------------------

program_name() {
  case "$1" in
    claude) echo "Claude" ;;
    codex) echo "Codex" ;;
    kimi) echo "Kimi" ;;
    glm) echo "GLM Coding Plan" ;;
    antigravity) echo "Antigravity" ;;
    machine) echo "Test runs, no plan" ;;
    *) echo "$1" ;;
  esac
}

check_server() {
  case "$SERVER" in
    __HORNHOOF_* | '') fail "This installer does not know its Hornhoof server. Copy the install command from Hornhoof again." ;;
  esac
  say "Checking that Hornhoof answers at $SERVER."
  curl -fsS --max-time 15 "$SERVER/api/health" > /dev/null 2>&1 ||
    fail "Hornhoof does not answer at $SERVER/api/health from this machine. If that address only works on the server itself, set PUBLIC_URL in the server's .env to an address this machine can reach, restart Hornhoof, and copy the install command again."
}

pull_image() {
  local code=0
  if [ "$BUILD_IMAGE" = local ] && [ -z "${HORNHOOF_NODE_IMAGE:-}" ]; then
    say "This Hornhoof is a local build with no node image published for it, so this machine gets the latest node image, which may not match it."
  fi
  if [ -z "$FROM_UPDATER" ]; then say "The first time, this is a large download that can take 10 to 20 minutes on a slow connection."; fi
  say "Getting the node image $IMAGE."
  # Docker shows a person in a terminal how far the download is; anywhere else its lines would only fill the output.
  if [ -t 1 ]; then "${DOCKER[@]}" pull "$IMAGE" || code=$?; else "${DOCKER[@]}" pull "$IMAGE" > /dev/null || code=$?; fi
  if [ "$code" -ne 0 ]; then
    if "${DOCKER[@]}" image inspect "$IMAGE" > /dev/null 2>&1; then
      say "Using the local image."
    elif [ "$IMAGE" = "$BUILD_IMAGE" ]; then
      fail "Could not download $IMAGE, the node image of this Hornhoof's build. Check the internet connection. If this Hornhoof was updated in the last few minutes, the image may not be published yet. Then run this command again."
    else
      fail "Could not download $IMAGE. Check the internet connection, then run this command again."
    fi
  fi
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

machine_id() {
  mkdir -p "$STATE_DIR"
  if ! grep -Eq '^[0-9a-f]{32}$' "$STATE_DIR/machine" 2> /dev/null; then
    random_hex 16 > "$STATE_DIR/machine"
  fi
  cat "$STATE_DIR/machine"
}

# A node in a container reaches the host's localhost as host.docker.internal.
NODE_SERVER=''
LOCAL_SERVER=''
node_server() {
  NODE_SERVER=$(printf '%s' "$SERVER" | sed -E 's#^(https?://)(localhost|127\.0\.0\.1)([:/]|$)#\1host.docker.internal\3#')
  if [ "$NODE_SERVER" != "$SERVER" ]; then LOCAL_SERVER=1; fi
}

# This computer's name as Hornhoof lists it.
host_name() {
  local host
  host=$(hostname 2> /dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-120)
  printf '%s' "${host:-machine}"
}

# What the join brought for the company's core here: CORE says it brought any, with the folder, the ticket the keeper
# redeems once, the web port of the company's server and the company, or CORE_HERE, the web port of the server's own
# front when this computer is the server's. BUILD_TAG is the build the server runs, whose three images are then in
# APP_REF, NODE_REF and UPDATER_REF.
CORE=''
CORE_FOLDER=''
CORE_TICKET=''
CORE_PORT=''
CORE_COMPANY=''
CORE_HERE=''
BUILD_TAG=''
# The key of the person who runs the join command, as the command carried it. It goes into the core's settings with the
# ticket, for the keeper to pin, and nowhere else: it is never sent to the server.
OWNER_KEY=''

# by_digest_of <repository> <image>: the image is one of that very repository, named by its digest.
by_digest_of() { [ "${2%%@*}" = "$1" ] && [[ "${2#*@}" =~ ^sha256:[0-9a-f]{64}$ ]]; }

a_port() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; [ "${#1}" -le 5 ] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }

# take_build <tag> <app> <node> <updater> <rest>: the images of the server's build, each by its digest in Hornhoof's
# own repository, since they run with this computer's Docker.
take_build() {
  [ -z "$5" ] || return 1
  [[ "$1" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || return 1
  by_digest_of "$APP_IMAGE" "$2" && by_digest_of "$APP_IMAGE-node" "$3" && by_digest_of "$APP_IMAGE-updater" "$4" || return 1
  BUILD_TAG=$1
  APP_REF=$2
  NODE_REF=$3
  UPDATER_REF=$4
}

# take_core <folder> <ticket> <port> <company> <rest>
take_core() {
  [ -z "$5" ] || return 1
  [[ "$1" =~ ^hornhoof-[a-z0-9-]{1,64}$ ]] && [[ "$2" =~ ^[A-Za-z0-9_-]{43}$ ]] && a_port "$3" || return 1
  [[ "$4" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  CORE=1
  CORE_FOLDER=$1
  CORE_TICKET=$2
  CORE_PORT=$3
  CORE_COMPANY=$4
}

# take_core_here <port> <rest>
take_core_here() {
  [ -z "$2" ] && a_port "$1" || return 1
  CORE=1
  CORE_HERE=$1
}

# Lines "<node> <provider> <key>", turned into "id:provider:key" words. A machine that joins without a plan gets one
# node of its own, with "machine" for its provider. The lines of the core come before them.
JOINED=''
join_machine() {
  local code=$1 machine host body request status id provider key more rest
  case "$code" in
    '' | *[!A-Za-z0-9_-]*) fail "This command is not valid. Copy it again from Hornhoof." ;;
  esac
  machine=$(machine_id)
  host=$(host_name)
  say "Connecting this machine ($host) to Hornhoof."
  body=$(mktemp)
  request=$(mktemp)
  printf '{"code":"%s","machineId":"%s","hostname":"%s","os":"%s","arch":"%s","core":true}' "$code" "$machine" "$host" "$OS" "$ARCH" > "$request"
  status=$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' -H 'content-type: application/json' -H 'accept: text/plain' \
    --data-binary "@$request" "$SERVER/api/nodes/join") || status=000
  rm -f "$request"
  case "$status" in
    200) ;;
    410)
      rm -f "$body"
      fail "This command was already used or is older than 24 hours. Get a new one in Hornhoof under Subscriptions."
      ;;
    404)
      rm -f "$body"
      fail "This command is not valid. Copy it again from Hornhoof."
      ;;
    409)
      # A node that has a key keeps it: a second command never takes a working node over.
      if grep -q already_on_machine "$body"; then
        rm -f "$body"
        fail "This machine already runs what this command connects, and keeps it as it is. To update its nodes, run: curl -fsSL $SERVER/install.sh | bash"
      fi
      rm -f "$body"
      fail "This command is for another of your machines. Run it on the machine you got it for: Hornhoof shows which one under Machines."
      ;;
    000)
      rm -f "$body"
      fail "Could not reach $SERVER. Check the connection, then run this command again."
      ;;
    *)
      rm -f "$body"
      fail "Hornhoof answered $status to the join. Try again in a minute, or get a new command in Hornhoof."
      ;;
  esac
  while read -r id provider key more rest; do
    case "$id" in
      build)
        take_build "$provider" "$key" "$more" "${rest%% *}" "${rest#"${rest%% *}"}" || fail "$UNREADABLE"
        continue
        ;;
      core)
        take_core "$provider" "$key" "$more" "${rest%% *}" "${rest#"${rest%% *}"}" || fail "$UNREADABLE"
        continue
        ;;
      core-here)
        take_core_here "$provider" "$key$more$rest" || fail "$UNREADABLE"
        continue
        ;;
    esac
    case "$id$provider$key$more$rest" in *[!A-Za-z0-9_-]*) fail "$UNREADABLE" ;; esac
    [ -z "$more" ] || fail "$UNREADABLE"
    case "$provider" in claude | codex | kimi | glm | antigravity | machine) ;; *) continue ;; esac
    [ -n "$id" ] && [ -n "$key" ] && JOINED="$JOINED $id:$provider:$key"
  done < "$body"
  rm -f "$body"
  # A command for the core alone brings no node, and is a join all the same.
  [ -n "$JOINED$CORE" ] || fail "Hornhoof returned no subscriptions for this command. Get a new one in Hornhoof under Subscriptions."
}

node_name() { printf 'hornhoof-%s-%s' "$2" "${1:0:8}"; }

# This computer as the server may know it: a hash of the key a join from here sends, which lets no one join as it. The
# server tells by it that its built-in node runs on one of the company's machines, which the pool then counts once.
host_id() {
  local machine
  machine=$(machine_id)
  if command -v sha256sum > /dev/null 2>&1; then
    printf 'hornhoof-host:%s' "$machine" | sha256sum | cut -c1-64
  elif command -v shasum > /dev/null 2>&1; then
    printf 'hornhoof-host:%s' "$machine" | shasum -a 256 | cut -c1-64
  fi
}

# Docker on a Mac runs in a smaller system of its own, so each node hears what the Mac itself has, to show it next to
# what the node can use: "NAME=value" lines for its processor, cores and memory. On Linux a node sees its machine. An updater
# runs in a container, where no Mac is to be seen, so the node it replaces keeps what it was told.
host_facts() {
  local cpu cpus mem
  if [ "$OS" != darwin ]; then
    if [ -n "$FROM_UPDATER" ] && [ -n "${1:-}" ]; then
      "${DOCKER[@]}" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2> /dev/null | grep -E '^HORNHOOF_HOST_(CPU|CPUS|MEMORY)=' || true
    fi
    # On Windows install.ps1 runs this script in a container, and hands over what the computer has in the same words.
    if [ -z "$FROM_UPDATER" ]; then env | grep -E '^HORNHOOF_HOST_(CPU=[A-Za-z0-9 ()@.,_-]{1,200}|CPUS=[0-9]+|MEMORY=[0-9]+)$' || true; fi
    return 0
  fi
  cpu=$(sysctl -n machdep.cpu.brand_string 2> /dev/null | tr -cd 'A-Za-z0-9 ()@.,_-' | cut -c1-200 || true)
  cpus=$(sysctl -n hw.ncpu 2> /dev/null || true)
  mem=$(sysctl -n hw.memsize 2> /dev/null || true)
  if [ -n "$cpu" ]; then printf 'HORNHOOF_HOST_CPU=%s\n' "$cpu"; fi
  case "$cpus" in '' | *[!0-9]*) ;; *) printf 'HORNHOOF_HOST_CPUS=%s\n' "$cpus" ;; esac
  case "$mem" in '' | *[!0-9]*) ;; *) printf 'HORNHOOF_HOST_MEMORY=%s\n' "$mem" ;; esac
}

HOST_ENV=()
host_env() {
  local fact
  HOST_ENV=()
  while IFS= read -r fact; do
    [ -n "$fact" ] && HOST_ENV+=(-e "$fact")
  done < <(host_facts "$1")
}

# node_hosts <name>: the --add-host words of a node, in NODE_HOSTS: the one for a server on localhost, and every one its
# container has now. A node joined on the server's own computer reaches the core's front through host.docker.internal
# while its label names the company's own address, so only its container says it needs that name. Each host once.
# It ends with 1 when the container is there but Docker does not say its hosts, and with 2 when one of them is not a word
# it passes on: a new container without them could lose its way to the core.
NODE_HOSTS=()
node_hosts() {
  local host hosts seen=' '
  NODE_HOSTS=()
  if ! hosts=$("${DOCKER[@]}" inspect --format '{{range .HostConfig.ExtraHosts}}{{println .}}{{end}}' "$1" 2> /dev/null); then
    # A node that has no container yet has no hosts to keep.
    if "${DOCKER[@]}" inspect --format '{{.Id}}' "$1" > /dev/null 2>&1; then return 1; fi
    hosts=''
  fi
  if [ -n "$LOCAL_SERVER" ]; then hosts=$(printf 'host.docker.internal:host-gateway\n%s' "$hosts"); fi
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    [[ "$host" =~ ^[A-Za-z0-9._-]+[:=][A-Za-z0-9.:_-]+$ ]] || return 2
    case "$seen" in *" $host "*) continue ;; esac
    seen="$seen$host "
    NODE_HOSTS+=(--add-host "$host")
  done <<< "$hosts"
}

# keep_hosts <name>: node_hosts, or the update stops here, before anything of the node is touched, and it goes on running.
keep_hosts() {
  local code=0
  node_hosts "$1" || code=$?
  case "$code" in
    0) ;;
    2) fail "$1 was started with a host name this installer cannot carry over, so $1 stays as it is and goes on running. Without it, it could lose its way to the company's core." ;;
    *) fail "Could not read the host names $1 was started with, so $1 stays as it is and goes on running. Without them, it could lose its way to the company's core. Run this command again." ;;
  esac
}

STARTED=''
prepare_node_stop() {
  local name=$1 reason=$2
  "${DOCKER[@]}" exec "$name" node "$NODE_MAIN" prepare-stop "$reason" > /dev/null 2>&1 || true
  "${DOCKER[@]}" stop --time 5 "$name" > /dev/null 2>&1 || true
}
# What a failed start tells the person. Once the join used the code, running it again only gets a 410.
RETRY='Run this command again.'

is_old_node() {
  case "$1" in
    *[!A-Za-z0-9_.-]*) return 1 ;;
    hornhoof-*-*-old-?*) return 0 ;;
    *) return 1 ;;
  esac
}

node_healthy() {
  [ "$("${DOCKER[@]}" inspect --format '{{.State.Running}} {{.State.Restarting}}' "$1" 2> /dev/null || true)" = 'true false' ]
}

next_old_node() {
  local cand="$1-old-$$" n=1
  while "${DOCKER[@]}" inspect --format '{{.Id}}' "$cand" > /dev/null 2>&1; do
    cand="$1-old-$${n:+_$n}"
    n=$((n + 1))
  done
  printf '%s' "$cand"
}

restore_old_node() {
  local name=$1 old=$2
  "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
  [ -n "$old" ] || return 0
  "${DOCKER[@]}" rename "$old" "$name" > /dev/null 2>&1 || true
  "${DOCKER[@]}" update --restart=unless-stopped "$name" > /dev/null 2>&1 || true
  "${DOCKER[@]}" start "$name" > /dev/null 2>&1 || true
}

# start_node <name> <id> <provider> [key]: the key goes into the node's volume through stdin, never on a command line.
start_node() {
  local name=$1 id=$2 provider=$3 key=${4:-} old='' started=1
  keep_hosts "$name"
  if [ -n "$key" ]; then
    printf '%s %s %s %s\n' "$NODE_SERVER" "$id" "$provider" "$key" |
      "${DOCKER[@]}" run --rm -i --network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "$name:/data" "$IMAGE" set-key ||
      fail "Could not save the key for $name. $RETRY"
  fi
  say "Starting $name."
  host_env "$name"
  prepare_node_stop "$name" "${5:-node_update}"
  if "${DOCKER[@]}" inspect --format '{{.Id}}' "$name" > /dev/null 2>&1; then
    old=$(next_old_node "$name")
    if "${DOCKER[@]}" rename "$name" "$old" > /dev/null 2>&1; then
      "${DOCKER[@]}" update --restart=no "$old" > /dev/null 2>&1 || true
      if [ "$("${DOCKER[@]}" inspect --format '{{.State.Running}}' "$old" 2> /dev/null || true)" = true ]; then
        "${DOCKER[@]}" stop --time 5 "$old" > /dev/null 2>&1 || true
      fi
    else
      old=''
      "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
    fi
  fi
  # Root inside the container only: the node runs its agents as a user of their own, keeps its key and programs from
  # them and checks which agent calls its tools. Nothing from the host is mounted and no new privileges can be gained.
  # Docker's AppArmor profile on newer Linux, as Debian 13, would stop that root from looking into and stopping its
  # agents' programs, so the node runs outside it; Docker skips the option where AppArmor is off, as on a Mac.
  "${DOCKER[@]}" run -d --name "$name" --label "$LABEL=$id" --label "$SERVER_LABEL=$SERVER" --restart unless-stopped --cap-drop ALL \
    --user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETGID --cap-add SETUID --cap-add SYS_PTRACE \
    --security-opt no-new-privileges --security-opt apparmor=unconfined --shm-size 2g -v "$name:/data" ${NODE_HOSTS[@]+"${NODE_HOSTS[@]}"} \
    ${HOST_ENV[@]+"${HOST_ENV[@]}"} "$IMAGE" > /dev/null || started=''
  if [ -z "$started" ] || ! node_healthy "$name"; then
    restore_old_node "$name" "$old"
    fail "Could not start $name (docker logs $name shows why). $RETRY"
  fi
  if [ -n "$old" ]; then
    "${DOCKER[@]}" rm -f "$old" > /dev/null 2>&1 || true
  fi
  STARTED="$STARTED $name"
}

# wait_for_node <name>: the server keeps new work off the node and says when what it runs has ended. This asks from the
# new image, since the running one may not know how, and with the node's own settings, so its key stays in its volume.
# The server lets go of the node soon after nobody asks, so stopping this changes nothing.
wait_for_node() {
  local name=$1 code=0
  # It reaches the server the way the node does. A node whose hosts cannot be kept is not asked about, nor moved.
  keep_hosts "$name"
  [ -z "$URGENT" ] || return 0
  [ "$("${DOCKER[@]}" inspect --format '{{.State.Running}}' "$name" 2> /dev/null)" != false ] || return 0
  "${DOCKER[@]}" run --rm --cap-drop ALL --user 0:0 --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "$name:/data:ro" \
    ${NODE_HOSTS[@]+"${NODE_HOSTS[@]}"} "$IMAGE" wait-update || code=$?
  [ "$code" -ne 0 ] || return 0
  LEFT="$LEFT $name"
  if [ "$code" -eq 3 ]; then
    say "This Hornhoof server is from before nodes wait for their work, so $name stays as it is and what it runs goes on. Update the Hornhoof server first, then run this command again."
  else
    say "Could not learn when $name is free, so it stays as it is and what it runs goes on. Run this command again, or add --urgent to stop what it runs and replace it now."
  fi
  return 1
}

node_status() {
  "${DOCKER[@]}" exec "$1" node "$NODE_MAIN" status 2> /dev/null && return 0
  if "${DOCKER[@]}" cp "$1:/data/removed" - > /dev/null 2>&1; then echo removed; else echo offline; fi
}

remove_node() {
  say "Removing $1, which was removed in Hornhoof."
  "${DOCKER[@]}" rm -f "$1" > /dev/null 2>&1 || true
  "${DOCKER[@]}" volume rm "$1" > /dev/null 2>&1 || true
}

# This server's nodes on this machine as "name:id" words. A node from before nodes carried their server is this
# server's when its own settings name this server. One whose settings cannot be read may work for another company on
# this computer, so it is left alone. A script that does not know its server (downloaded on its own) sees every node.
existing_nodes() {
  local known=1 own
  case "$SERVER" in __HORNHOOF_* | '') known='' ;; esac
  if [ -n "$known" ]; then node_server; fi
  "${DOCKER[@]}" ps -a --filter "label=$LABEL" --format '{{.Names}} {{.Label "hornhoof.subscription"}} {{.Label "hornhoof.server"}}' 2> /dev/null |
    while read -r name id server; do
      [ -n "$name" ] || continue
      if is_old_node "$name"; then continue; fi
      if [ -n "$known" ] && [ -n "$server" ] && [ "$server" != "$SERVER" ]; then continue; fi
      if [ -n "$known" ] && [ -z "$server" ]; then
        own=$("${DOCKER[@]}" exec "$name" cat /data/node.json 2> /dev/null | sed -n 's/^ *"server": *"\([^"]*\)".*/\1/p')
        if [ -z "$own" ]; then
          say "Leaving $name as it is: it does not say which Hornhoof it works for. If it is stopped, start it with docker start $name and run this command again." >&2
          continue
        fi
        if [ "$own" != "$NODE_SERVER" ]; then continue; fi
      fi
      printf '%s:%s ' "$name" "$id"
    done
}

# Renamed -old-* node containers of this server never run again: auto-restart comes off at once, and each goes once the
# node container it was renamed from runs and is not restarting (or right away on --uninstall).
sweep_old_nodes() {
  local mode=${1:-} known=1 base
  case "$SERVER" in __HORNHOOF_* | '') known='' ;; esac
  "${DOCKER[@]}" ps -a --filter "label=$LABEL" --format '{{.Names}} {{.Label "hornhoof.subscription"}} {{.Label "hornhoof.server"}}' 2> /dev/null |
    while read -r name _ server; do
      is_old_node "$name" || continue
      if [ -n "$known" ] && [ "$server" != "$SERVER" ]; then continue; fi
      if [ "$mode" = all ]; then
        "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
        continue
      fi
      if [ "$("${DOCKER[@]}" inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name" 2> /dev/null || true)" != no ]; then
        "${DOCKER[@]}" update --restart=no "$name" > /dev/null 2>&1 || true
      fi
      base=${name%-old-*}
      if node_healthy "$base"; then
        "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
      fi
    done
}

# Opens a sign-in link in the browser of this computer, or on Windows hands it to install.ps1, which opens it there.
open_link() {
  if [ -n "$FROM_WINDOWS" ]; then
    printf '%s\n' "$1" 2> /dev/null > "$LINK_FILE" || say "Open this link in a browser: $1"
  elif [ "$OS" = darwin ]; then
    open "$1" > /dev/null 2>&1 || say "Open this link in a browser: $1"
  elif command -v xdg-open > /dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    xdg-open "$1" > /dev/null 2>&1 || say "Open this link in a browser: $1"
  else
    say "Open this link in a browser: $1"
  fi
}

watch_link() {
  local seen='' url
  while :; do
    url=$("${DOCKER[@]}" exec "$1" cat /data/login-url 2> /dev/null || true)
    if [ -n "$url" ] && [ "$url" != "$seen" ]; then
      seen=$url
      # The link comes from inside the node, where an agent could write anything, so only a plain https address opens.
      case "$url" in
        https://*[[:space:]]*) ;;
        https://*) open_link "$url" ;;
      esac
    fi
    sleep 1
  done
}

# Plans whose owner signs them in once in Hornhoof, which then passes the sign-in to every machine of the plan.
# Antigravity signs in on each machine.
signs_in_hornhoof() { case "$1" in claude | codex | kimi | glm) return 0 ;; esac; return 1; }

# A node that needs no sign-in here: ready, a spare machine of a Codex plan, or signed in with a browser error to report.
signed_in() { case "$(node_status "$1")" in ready | spare | browser_failed:*) return 0 ;; esac; return 1; }

# The joined nodes, of those named, that are not ready after SIGNIN_WAIT seconds. A plan its owner signed in once in
# Hornhoof reaches a new node of the plan within seconds, and that node needs no sign-in here.
late_nodes() {
  local left=$SIGNIN_WAIT name late
  while :; do
    late=''
    for name in "$@"; do
      if ! signed_in "$name"; then late="$late $name"; fi
    done
    if [ -z "$late" ] || [ "$left" -le 0 ]; then break; fi
    sleep 1
    left=$((left - 1))
  done
  printf '%s' "$late"
}

# How to paste into the terminal this runs in, which many people do not know. A Windows console pastes with a right-click,
# which shows its menu with Paste while install.ps1 keeps QuickEdit off; Ctrl+V there only types ^V.
paste_hint() {
  if [ -n "$FROM_WINDOWS" ]; then
    printf '%s' 'To paste in this window, right-click in it; if a menu shows, choose Paste. Ctrl+V does not paste here.'
  elif [ "$OS" = darwin ]; then
    printf '%s' 'To paste, press Cmd+V.'
  else
    printf '%s' 'To paste, press Ctrl+Shift+V in most Linux terminals.'
  fi
}

# sign_in_help <name> <provider>: what to do, said before the program's own sign-in fills the terminal. Claude's sign-in
# gives a code to paste here; the others say what they need themselves.
sign_in_help() {
  local paste
  paste=$(paste_hint)
  say ''
  say "$RULE"
  say "${COLOR_STEP}Signing in to $(program_name "$2") on $1${COLOR_OFF}"
  say '  1. The sign-in page opens in your browser by itself. If it does not, open the link that shows below.'
  if [ "$2" = claude ]; then
    say '  2. Sign in there, and press Authorize.'
    say '  3. Copy the code the page shows.'
    say "  4. Paste the code here and press Enter. $paste"
  else
    say '  2. Sign in there, and allow what it asks.'
    say "  3. Follow what this window shows below. When it asks for a code or a key, paste it here and press Enter. $paste"
  fi
  if signs_in_hornhoof "$2"; then
    say 'You can also sign in once in Hornhoof under Subscriptions, for all your machines.'
    say 'This sign-in shows there too: finish it in one place only, here or there.'
  fi
  say "$RULE"
}

login_node() {
  local name=$1 provider watcher
  provider=${name#hornhoof-}
  provider=${provider%-*}
  sign_in_help "$name" "$provider"
  "${DOCKER[@]}" exec "$name" rm -f /data/login-url > /dev/null 2>&1 || true
  watch_link "$name" &
  watcher=$!
  if ! "${DOCKER[@]}" exec -it "$name" node "$NODE_MAIN" login < "$TTY"; then
    if signs_in_hornhoof "$provider"; then
      say "The sign-in on $name did not finish. Sign in once in Hornhoof under Subscriptions, or run the install command again without --join."
    else
      say "The sign-in or first setup on $name did not finish. To try again, run the install command without --join."
    fi
  fi
  kill "$watcher" 2> /dev/null || true
  wait "$watcher" 2> /dev/null || true
}

# local_front <port>: the nodes started from here on reach the company at this machine's own front door, as a container
# reaches its host. They keep the company's address on their label, so the next run still finds them by it.
local_front() {
  NODE_SERVER="http://host.docker.internal:$1"
  LOCAL_SERVER=1
}

# core_servers <.env>: every address this machine joined the core's company through, one per line. A company has several:
# its address on the local network, its public link. Each node carries the one its own command came from.
core_servers() {
  { value_in "$1" HORNHOOF_SERVERS | tr ',' '\n'; value_in "$1" HORNHOOF_JOIN_SERVER; } | awk 'NF && !seen[$0]++'
}

# The folder of the core this machine has for the company at SERVER; nothing when it has none.
core_of_server() {
  local env
  for env in "$BASE_DIR"-*/.env; do
    if [ -r "$env" ] && [ "$(value_in "$env" HORNHOOF_ROLE)" = worker ] && core_servers "$env" | grep -q -x -F -e "$SERVER"; then
      dirname "$env"
      return 0
    fi
  done
}

# On a machine with the company's core, a node that is started again goes to the core's front.
front_of_core() {
  local core
  core=$(core_of_server)
  if [ -n "$core" ]; then local_front "$(port_of "$core/.env")"; fi
}

# move_node <name>: a node from before the machine had the core still names the company's own address. It is only
# moved when it is restarted anyway, and keeps its key and what it has to say; one that cannot be moved goes on as it was.
move_node() {
  local name=$1 own
  [ -n "$LOCAL_SERVER" ] || return 0
  own=$("${DOCKER[@]}" exec "$name" cat /data/node.json 2> /dev/null | sed -n 's/^ *"server": *"\([^"]*\)".*/\1/p' || true)
  if [ -z "$own" ] || [ "$own" = "$NODE_SERVER" ]; then return 0; fi
  printf '%s\n' "$NODE_SERVER" |
    "${DOCKER[@]}" run --rm -i --network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "$name:/data" "$IMAGE" set-server ||
    say "Could not point $name at this machine's own address, so it goes on through $own."
}

# The settings of the core this computer has for the company the join named; nothing when it has none.
core_env() {
  local env
  for env in "$(dirname "$BASE_DIR")"/hornhoof-*/.env; do
    if [ -r "$env" ] && [ "$(value_in "$env" HORNHOOF_COMPANY)" = "$CORE_COMPANY" ]; then
      printf '%s' "$env"
      return 0
    fi
  done
}

# The folder of the company's core on this computer: the one that names the company already, else the one the server
# named, and with that name or compose project taken by another company's the next of -2 to -9.
core_dir() {
  local parent env dir n=1
  parent=$(dirname "$BASE_DIR")
  env=$(core_env)
  if [ -n "$env" ]; then
    dirname "$env"
    return 0
  fi
  dir="$parent/$CORE_FOLDER"
  while [ -e "$dir" ] || [ -n "$(project_elsewhere "$(basename "$dir")" "$dir")" ]; do
    n=$((n + 1))
    [ "$n" -le 9 ] || fail "There are 9 Hornhoof folders here already. Remove one you do not use."
    dir="$parent/$CORE_FOLDER-$n"
  done
  printf '%s' "$dir"
}

# The company's core on a machine that joined: front, the keeper and the updater in a folder of the company's own, with
# no database and no secret of the company. A folder that is there keeps its settings; the ticket is new each time, and
# the keeper redeems it once, with its own key, for its place in the company. The nodes then go to this machine's front.
worker_core() {
  local env_file waited=0 web servers=''
  WORKER=1
  find_compose
  [ -n "$APP_REF" ] || APP_REF="$APP_IMAGE:${PIN:-latest}"
  [ -n "$NODE_REF" ] || NODE_REF="$APP_IMAGE-node:${PIN:-latest}"
  [ -n "$UPDATER_REF" ] || UPDATER_REF="$APP_IMAGE-updater:${PIN:-latest}"
  SERVER_DIR=$(core_dir) || exit 1
  env_file="$SERVER_DIR/.env"
  if [ -f "$env_file" ]; then
    # A run that stopped before the ports were chosen left the line empty: that folder has no ports to keep yet.
    if ! grep -q '^HORNHOOF_PORT=$' "$env_file"; then ENV_BEFORE=1; fi
    say "Keeping the settings in $env_file."
    # The keeper redeems the ticket where this command came from, which may be another address of the company than the
    # one it joined through before. That one stays the company's too.
    servers=$(core_servers "$env_file")
    set_env HORNHOOF_JOIN_SERVER "$SERVER"
  else
    mkdir -p "$SERVER_DIR"
    (
      umask 077
      printf 'HORNHOOF_PORT=\n' > "$env_file"
    )
    # .env names the two compose files, so docker compose run by hand in the folder starts the core alone too.
    set_env COMPOSE_PROJECT_NAME "$(basename "$SERVER_DIR")"
    set_env COMPOSE_FILE compose.yaml:compose.worker.yaml
    set_env HORNHOOF_SERVER_DIR "$SERVER_DIR"
    set_env HORNHOOF_ROLE worker
    set_env HORNHOOF_COMPANY "$CORE_COMPANY"
    set_env HORNHOOF_JOIN_SERVER "$SERVER"
    set_env HORNHOOF_MACHINE_ID "$(host_id)"
    machine_lines
    set_env HORNHOOF_HEALTH_URL http://keeper:7080/api/keeper
    set_env HORNHOOF_VERSION "${BUILD_TAG:-${PIN:-latest}}"
    set_env HORNHOOF_APP_REF "$APP_REF"
    set_env HORNHOOF_NODE_REF "$NODE_REF"
    set_env HORNHOOF_UPDATER_REF "$UPDATER_REF"
  fi
  set_env HORNHOOF_SERVERS "$(printf '%s\n%s\n' "$servers" "$SERVER" | awk 'NF && !seen[$0]++' | tr '\n' ',' | sed 's/,$//')"
  set_env HORNHOOF_JOIN_TICKET "$CORE_TICKET"
  # A command without the key leaves the one the last command brought.
  if [ -n "$OWNER_KEY" ]; then set_env HORNHOOF_OWNER_KEY "$OWNER_KEY"; fi
  compose_from_image
  if [ -z "$PULLED" ]; then
    say "Downloading the images of the company's core."
    (cd "$SERVER_DIR" && "${COMPOSE[@]}" pull) || fail "Could not download the images. Check the internet connection, then run this command again."
  fi
  WANT_WEB=$CORE_PORT
  reserve_ports
  say "Starting the company's core on this machine, in $SERVER_DIR."
  if [ -n "$SUBNET_MOVED" ]; then compose_step "${COMPOSE[@]}" down --remove-orphans || true; fi
  start_keeper_and_front "${COMPOSE[@]}"
  compose_step "${COMPOSE[@]}" up -d --no-build || start_failed
  web=$(port_of "$env_file")
  say "Waiting for this machine to get its place in the company."
  until curl -fsS --max-time 5 "http://localhost:$web/api/keeper" 2> /dev/null | grep -q '"certificate":true'; do
    waited=$((waited + 2))
    if [ "$waited" -ge "$CORE_WAIT" ]; then
      say "This machine's core started, and keeps trying to reach the company server. See docker compose logs keeper in $SERVER_DIR."
      break
    fi
    sleep 2
  done
  # The core's own updater moves this company's nodes here from now on, so the one that did it before goes.
  drop_nodes_updater
}

# The join used the command up by now, so a core that cannot be set up must not take the joined nodes with it: they
# start all the same and reach the company at its own address, and the next command sets the core up.
core_and_front() {
  local port rc=0
  port=$(mktemp)
  set +e
  (
    set -e
    worker_core
    port_of "$SERVER_DIR/.env" > "$port"
  )
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    local_front "$(cat "$port")"
  else
    say "The company's core could not be set up on this machine, so what this command connects reaches the company directly for now. To set the core up, get a new command in Hornhoof under Machines and run it here."
  fi
  rm -f "$port"
}

node_mode() {
  local code=$1 entry name id provider key status removed='' existing joined_names='' waits='' late held='' told='' pending=''
  local -a plans
  detect_system
  if [ -z "$FROM_WINDOWS" ]; then
    step 1 'Checking this computer' 'Hornhoof runs on this computer in Docker. This checks that this computer reaches Hornhoof and that Docker works here, and installs Docker when it is missing.'
  fi
  check_server
  ensure_docker
  step 2 'Getting Hornhoof for this computer' 'This downloads the program Hornhoof runs on this computer. There is nothing to do but wait.'
  pull_image
  node_server
  if [ -n "$code" ]; then
    step 3 'Connecting this computer' 'This connects this computer to Hornhoof and starts a node, which runs the agents here, for each plan. There is nothing to do.'
  else
    step 3 'Updating the nodes on this computer' 'Each node here moves to the version just downloaded once what it runs has ended. There is nothing to do.'
  fi

  sweep_old_nodes
  existing=$(existing_nodes)
  for entry in $existing; do
    name=${entry%%:*}
    named_free "${entry#*:}" || continue
    if [ "$(node_status "$name")" = removed ]; then
      remove_node "$name"
      removed="$removed $name"
    fi
  done

  if [ -n "$code" ]; then
    join_machine "$code"
    RETRY='This command is used up: disconnect this machine in Hornhoof under Subscriptions, then get a new command.'
    # The node image of the build the server runs, which the join named exactly. On a machine that has the company's
    # core already, the image that core's settings name: its updater keeps every node of the company on the core's own
    # build, which follows the server's by itself, so a node on another would be made anew within minutes.
    if [ -n "$CORE" ]; then held=$(core_env); fi
    if [ -n "$held" ]; then held=$(value_in "$held" HORNHOOF_NODE_REF); fi
    if [ -z "${HORNHOOF_NODE_IMAGE:-}" ] && [ -n "$held$BUILD_TAG" ]; then
      IMAGE=${held:-$NODE_REF}
      pull_image
    fi
    if [ -n "$CORE_HERE" ]; then
      local_front "$CORE_HERE"
    elif [ -n "$CORE" ]; then
      core_and_front
    fi
    for entry in $JOINED; do
      id=${entry%%:*}
      key=${entry##*:}
      provider=${entry#*:}
      provider=${provider%%:*}
      name=$(node_name "$id" "$provider")
      start_node "$name" "$id" "$provider" "$key"
      joined_names="$joined_names $name"
    done
  fi

  # Without a code this run updates the nodes on this machine: they move to the new image with their volumes.
  # With a code it only starts the joined nodes and leaves the others, and their running jobs, alone.
  if [ -z "$code" ]; then
    front_of_core
    for entry in $existing; do
      name=${entry%%:*}
      id=${entry#*:}
      case " $removed $STARTED " in *" $name "*) continue ;; esac
      named_free "$id" || continue
      provider=${name#hornhoof-}
      provider=${provider%-*}
      if wait_for_node "$name"; then
        move_node "$name"
        start_node "$name" "$id" "$provider"
      fi
    done
  fi

  if [ -z "$FROM_UPDATER" ] && [ -n "$STARTED$LEFT" ]; then nodes_updater; fi
  if [ -z "$STARTED" ] && [ -n "$LEFT" ]; then fail "Nothing changed on this machine."; fi
  # A command for the core alone starts no node: the machine's nodes go on, and find the core when they next start.
  if [ -z "$STARTED" ] && [ -n "$CORE" ]; then
    if [ -n "$LOCAL_SERVER" ]; then say "The company's core is on this machine now. Its nodes stay as they are."; fi
    return 0
  fi
  if [ -z "$STARTED" ]; then
    say "There are no Hornhoof nodes on this machine yet. Get the install command in Hornhoof under Subscriptions."
    return 0
  fi

  # A new node of a plan signed in once in Hornhoof gets that sign-in by itself; the others go through the sign-in here
  # (it ends at once when the program is signed in already). A machine's own node has no plan to sign in to.
  step 4 'Signing in' 'Agents use a plan once it is signed in to its account.'
  for name in $joined_names; do
    provider=${name#hornhoof-}
    provider=${provider%-*}
    if signs_in_hornhoof "$provider"; then waits="$waits $name"; fi
  done
  if [ -n "$waits" ] && [ "$SIGNIN_WAIT" -gt 0 ]; then say "Checking whether the plans got their sign-in from Hornhoof."; fi
  # shellcheck disable=SC2086 # one word per node
  late=" $(late_nodes $waits) "
  for name in $STARTED; do
    case "$name" in hornhoof-machine-*) continue ;; esac
    provider=${name#hornhoof-}
    provider=${provider%-*}
    case " $waits " in
      *" $name "*)
        told=1
        case "$late" in
          *" $name "*) login_node "$name" ;;
          *)
            if [ "$(node_status "$name")" = spare ]; then
              say "$(program_name "$provider") on $name is a spare machine: Codex runs on another machine of this plan and moves here when that one is away."
            else
              say "$(program_name "$provider") on $name got its sign-in from Hornhoof."
            fi
            ;;
        esac
        ;;
      *)
        case " $joined_names " in
          *" $name "*)
            told=1
            login_node "$name"
            ;;
          *)
            if [ -z "$FROM_UPDATER" ] && ! signed_in "$name"; then
              told=1
              login_node "$name"
            fi
            ;;
        esac
        ;;
    esac
  done
  if [ -z "$told" ] && [ -z "$FROM_UPDATER" ]; then say 'Nothing needs a sign-in here.'; fi

  say ""
  say "Nodes on this machine:"
  for name in $STARTED; do
    provider=${name#hornhoof-}
    provider=${provider%-*}
    status=$(node_status "$name")
    case "$name" in hornhoof-machine-*) ;; *) plans+=("$(program_name "$provider")") ;; esac
    case "$status" in ready | spare) ;; *) pending=1 ;; esac
    case "$status" in
      ready) status="ready" ;;
      spare) status="spare, Codex runs on another machine of this plan now" ;;
      needs_login)
        if signs_in_hornhoof "$provider"; then
          status="needs sign-in, sign in once in Hornhoof under Subscriptions, or run the install command again without --join"
        else
          status="needs sign-in, run the install command again without --join"
        fi
        ;;
      needs_setup) status="needs its first setup, run the install command again without --join" ;;
      browser_failed:*) status="browser did not start (${status#browser_failed: }), see docker logs $name" ;;
      *) status="not answering yet, see docker logs $name" ;;
    esac
    say "  $(program_name "$provider"): $status ($name)"
  done
  case " $joined_names" in
    *" hornhoof-machine-"*)
      say ""
      say "To run agents here too, add one of your plans to this machine in Hornhoof under Subscriptions."
      ;;
  esac
  if [ -n "$LEFT" ]; then fail "These nodes stay as they are:$LEFT."; fi
  done_banner "$pending" ${plans[@]+"${plans[@]}"}
}

# done_banner <pending> <plan>...: the last lines of a run a person watches, with what runs on this computer now and that
# the window may close.
done_banner() {
  local pending=$1 list=''
  shift
  [ -z "$FROM_UPDATER" ] || return 0
  while [ $# -gt 0 ]; do
    if [ -z "$list" ]; then
      list=$1
    elif [ $# -eq 1 ]; then
      list="$list and $1"
    else
      list="$list, $1"
    fi
    shift
  done
  say ''
  if [ -n "$list" ]; then
    say "${COLOR_DONE}Done. Hornhoof runs on this computer, $(host_name), with $list.${COLOR_OFF}"
  else
    say "${COLOR_DONE}Done. Hornhoof runs on this computer, $(host_name), for test runs.${COLOR_OFF}"
  fi
  if [ -n "$pending" ]; then say 'Some of them are not ready yet: the list above says what to do.'; fi
  say 'You can close this window: the nodes keep running.'
}

# docker ps of the updater of this server's nodes on this computer, or of every server's when this script does not know its own.
nodes_updaters() {
  case "$SERVER" in
    __HORNHOOF_* | '') "${DOCKER[@]}" ps "$@" --filter label=hornhoof.updater=nodes 2> /dev/null || true ;;
    *) "${DOCKER[@]}" ps "$@" --filter label=hornhoof.updater=nodes --filter "label=$SERVER_LABEL=$SERVER" 2> /dev/null || true ;;
  esac
}

# One updater for each server's nodes on this computer, on the updater image of the server's build by its digest, with Docker's
# socket: it moves them to the server's build as their work ends, and itself to the server's updater. One that runs stays, so
# it is never stopped while it replaces a node. The server's own computer needs none, as the server knows it or runs on
# localhost: the updater next to the server moves its nodes.
nodes_updater() {
  local host
  [ -n "$UPDATER_BUILD" ] && [ -z "$LOCAL_SERVER" ] || return 0
  host=$(host_id)
  [ -z "$SERVER_HOST_ID" ] || [ "$SERVER_HOST_ID" != "$host" ] || return 0
  [ -z "$(nodes_updaters -q)" ] || return 0
  if ! [[ "$UPDATER_BUILD" =~ ^ghcr\.io/invariant0x/hornhoof-updater@sha256:[0-9a-f]{64}$ ]]; then
    say "This Hornhoof cannot name its updater image by its digest yet, so these nodes move to a new build only when you run this command again."
    return 0
  fi
  say "Starting the updater of these nodes. When this Hornhoof moves to another build, it moves them too, each once its work ends."
  "${DOCKER[@]}" run --rm -v /var/run/docker.sock:/var/run/docker.sock "$UPDATER_BUILD" start-nodes "$SERVER" "$UPDATER_BUILD" "$host" > /dev/null ||
    say "Could not start the updater of these nodes, so they move to a new build of Hornhoof only when you run this command again."
}

drop_nodes_updater() {
  local id
  for id in $(nodes_updaters -aq); do "${DOCKER[@]}" rm -f "$id" > /dev/null 2>&1 || true; done
}

# Remove only this installation's entries, leaving an unreadable list alone.
forget_install_ports() {
  local registry subnets
  APP_REF=$(value_in "$2" HORNHOOF_APP_REF)
  SERVER_DIR=$1
  [ -n "$APP_REF" ] || return 0
  take_port_lock
  if registry=$(read_registry); then
    other_lines "$registry" | write_registry || say "Could not take $SERVER_DIR off the list of Hornhoof's ports on this computer."
  else
    say "Could not read the list of Hornhoof's ports on this computer, so $SERVER_DIR stayed on it."
  fi
  if subnets=$(read_subnets); then
    other_lines "$subnets" | write_subnets || say "Could not take $SERVER_DIR off the list of Hornhoof's subnets on this computer."
  else
    say "Could not read the list of Hornhoof's subnets on this computer, so $SERVER_DIR stayed on it."
  fi
  drop_port_lock "$PORT_LOCK_ID"
}

# The company's core on this machine goes: its containers and volumes, with the machine's key in them, its folder, and
# its line in the list of ports. A machine that joins again later is a new machine to the company.
remove_core() {
  local core=$1
  say "Removing the company's core in $core."
  find_compose
  (cd "$core" && "${COMPOSE[@]}" down -v) > /dev/null 2>&1 || say "Could not stop the core in $core. Run docker compose down -v there, then remove the folder."
  forget_install_ports "$core" "$core/.env"
  rm -rf -- "${core:?}"
}

is_server_folder() {
  [ ! -L "$1" ] && [ -f "$1/compose.yaml" ] && [ -n "$(value_in "$1/.env" HORNHOOF_SECRET)" ] &&
    [ -z "$(value_in "$1/.env" COMPOSE_FILE)" ] && [ "$(value_in "$1/.env" HORNHOOF_ROLE)" != worker ]
}

# Start only the existing database, then wait for it to answer, including with Compose 2.20.
start_backup_database() {
  local deadline=$((SECONDS + ANSWER_WAIT))
  "$@" start db > /dev/null || return 1
  until "$@" exec -T db pg_isready -t 2 -U hornhoof -d hornhoof > /dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

uninstall_server() {
  local folder recorded project elsewhere answer backup
  local -a compose
  is_server_folder "$SERVER_DIR" || fail "No Hornhoof server installation was found in $SERVER_DIR."
  folder=$(CDPATH='' cd -P -- "$SERVER_DIR" && pwd -P) || fail "Could not open the server folder $SERVER_DIR."
  recorded=$(value_in "$folder/.env" HORNHOOF_SERVER_DIR)
  if [ -n "$recorded" ] && [ "$(CDPATH='' cd -P -- "$recorded" 2> /dev/null && pwd -P)" != "$folder" ]; then
    fail "The settings in $folder name another server folder."
  fi
  SERVER_DIR=$folder
  project=$(value_in "$folder/.env" COMPOSE_PROJECT_NAME)
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Could not read the Docker project name in $folder."
  [ -z "$NAME" ] || [ "$project" = "hornhoof-$NAME" ] || fail "The settings in $folder name another Docker project."
  elsewhere=$(project_elsewhere "$project" "$folder" strict) || fail "Could not identify the Docker project $project. The server stays in $folder."
  [ -z "$elsewhere" ] || fail "The Docker project $project also belongs to $elsewhere."

  say "This removes the server's containers and volumes, including its local work files."
  answer=$(ask "Back up the database and remove the Hornhoof server in $folder? [y/N] " n)
  case "$answer" in
    y | Y | yes) ;;
    *) say "The server stays in $folder."; return 0 ;;
  esac

  find_compose
  compose=("${COMPOSE[@]}" --project-directory "$folder" --env-file "$folder/.env" -f "$folder/compose.yaml" -p "$project")
  backup=$(umask 077; mktemp -d "$(dirname "$folder")/.hornhoof-backup.XXXXXX") || fail "Could not make a backup folder next to $folder."
  if ! (
    umask 077
    start_backup_database "${compose[@]}" &&
      "${compose[@]}" exec -T db pg_dump -U hornhoof -d hornhoof --format=custom > "$backup/database.dump" &&
      [ -s "$backup/database.dump" ] &&
      "${compose[@]}" exec -T db pg_restore --file=/dev/null < "$backup/database.dump" &&
      "${compose[@]}" exec -T db pg_dumpall -U hornhoof --globals-only > "$backup/globals.sql" &&
      [ -s "$backup/globals.sql" ]
  ); then
    fail "Could not save a database copy. The server installation stays in $folder. The incomplete backup is in $backup."
  fi
  say "Database copy saved in $backup."
  "${compose[@]}" down --volumes --remove-orphans || fail "Could not remove the Docker project $project. The database copy is in $backup."
  mv -- "${folder:?}" "$backup/installation" || fail "Could not move the settings from $folder. The database copy is in $backup."
  forget_install_ports "$folder" "$backup/installation/.env"
  say "The server is removed. Keep the database copy and the installation settings in $backup together."
}

uninstall_mode() {
  local entry names='' name answer core asked
  detect_system
  docker_works || fail "Docker is not running, so there are no nodes to remove. Start Docker, then run this again."
  if [ -n "$NAME${HORNHOOF_SERVER_DIR:-}" ]; then
    uninstall_server
    return 0
  fi
  # A script served by another company keeps its own scope. A local script can remove the default server here.
  case "$SERVER" in
    __HORNHOOF_* | '') if is_server_folder "$SERVER_DIR"; then uninstall_server; return 0; fi ;;
  esac
  core=$(core_of_server)
  if [ -n "$core" ]; then
    # The core goes, so the company's nodes here go whichever of its addresses each joined through.
    asked=$SERVER
    while IFS= read -r SERVER; do
      [ -n "$SERVER" ] || continue
      for entry in $(existing_nodes); do
        case " $names " in *" ${entry%%:*} "*) ;; *) names="$names ${entry%%:*}" ;; esac
      done
    done <<< "$(core_servers "$core/.env")"
    SERVER=$asked
  else
    for entry in $(existing_nodes); do names="$names ${entry%%:*}"; done
  fi
  if [ -z "$names" ] && [ -n "$core" ]; then
    answer=$(ask "Remove the company's core from this machine, in $core? [y/N] " n)
    case "$answer" in
      y | Y | yes) remove_core "$core" ;;
      *) say "Nothing was removed." ;;
    esac
    return 0
  fi
  if [ -z "$names" ]; then
    drop_nodes_updater
    say "There are no Hornhoof nodes on this machine."
    return 0
  fi
  say "Hornhoof nodes on this machine:"
  for name in $names; do say "  $name"; done
  if [ -n "$core" ]; then say "The company's core on this machine, in $core, goes with them."; fi
  answer=$(ask "Remove these nodes? [y/N] " n)
  case "$answer" in
    y | Y | yes) ;;
    *)
      say "Nothing was removed."
      return 0
      ;;
  esac
  for name in $names; do "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true; done
  if [ -n "$core" ]; then
    asked=$SERVER
    while IFS= read -r SERVER; do
      [ -n "$SERVER" ] || continue
      sweep_old_nodes all
    done <<< "$(core_servers "$core/.env")"
    SERVER=$asked
  else
    sweep_old_nodes all
  fi
  if [ -n "$core" ]; then remove_core "$core"; fi
  drop_nodes_updater
  say "The nodes are removed."
  answer=$(ask "Also delete their volumes, with the sign-ins and work files? [y/N] " n)
  case "$answer" in
    y | Y | yes)
      for name in $names; do "${DOCKER[@]}" volume rm "$name" > /dev/null 2>&1 || true; done
      say "The volumes are deleted."
      ;;
    *) say "The volumes stay. The next install on this machine picks them up again." ;;
  esac
}

# --- Server -------------------------------------------------------------------------------------

# Docker Compose as this computer has it, in COMPOSE.
COMPOSE=()
find_compose() {
  if "${DOCKER[@]}" compose version > /dev/null 2>&1; then
    COMPOSE=("${DOCKER[@]}" compose)
  elif command -v docker-compose > /dev/null 2>&1; then
    COMPOSE=(docker-compose)
  elif [ "$OS" = darwin ] && command -v brew > /dev/null 2>&1; then
    say "Installing Docker Compose with Homebrew."
    brew install docker-compose || fail "Homebrew could not install Docker Compose. Run brew doctor, then run this command again."
    COMPOSE=(docker-compose)
  else
    fail "Docker Compose is missing. Install the Docker Compose plugin, then run this command again."
  fi
  compose_new_enough || fail "Docker Compose $("${COMPOSE[@]}" version --short 2> /dev/null || true) on this computer is too old for this Hornhoof, which needs 2.20 or newer. Update Docker, then run this command again."
}

# Hornhoof's compose file says that a service may be absent, which Compose reads from 2.20 on. A version that cannot be
# read is let through: the start itself then says what is wrong.
compose_new_enough() {
  local version major minor
  version=$("${COMPOSE[@]}" version --short 2> /dev/null | tr -d 'v' || true)
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  case "$major" in '' | *[!0-9]*) return 0 ;; esac
  case "$minor" in '' | *[!0-9]*) return 0 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 20 ]; }
}

new_secret() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# The database password goes into the database address, so it is hex.
new_password() { random_hex 24; }

# value_in <file> <key>: the key's value in a .env, empty when it has none or cannot be read.
value_in() { grep "^$2=" "$1" 2> /dev/null | tail -1 | cut -d= -f2- || true; }

env_value() { value_in "$SERVER_DIR/.env" "$1"; }

# The port a server's .env keeps; one from before servers kept a port has the first one.
port_of() {
  local port
  port=$(value_in "$1" HORNHOOF_PORT)
  printf '%s\n' "${port:-$FIRST_PORT}"
}

# Something listens on the port; curl ends with 7 only when nothing does.
port_answers() {
  local rc=0
  curl -s -o /dev/null --max-time 2 "http://localhost:$1/" > /dev/null 2>&1 || rc=$?
  [ "$rc" -ne 7 ]
}

# A company's name on this computer: lowercase letters, digits and dashes, up to 32 characters.
valid_name() {
  case "$1" in '' | -* | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 32 ]
}

# The Hornhoof servers and cores anyone on this computer runs, running or not, as "project|folder|container" lines.
# Docker is one for every person on a computer, so these are other people's companies too, whatever folder they run from.
hornhoof_servers() {
  {
    "${DOCKER[@]}" ps -a --filter label=com.docker.compose.service=app --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Image}}|{{.ID}}' 2> /dev/null || true
    "${DOCKER[@]}" ps -a --filter label=com.docker.compose.service=keeper --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Image}}|{{.ID}}' 2> /dev/null || true
  } | awk -F'|' 'tolower($1 "|" $3) ~ /hornhoof/ && $1 != "" && !seen[$1 "|" $2]++ { print $1 "|" $2 "|" $4 }'
}

# project_elsewhere <project> <folder> [strict]: another folder using this project; strict requires an answer from Docker.
project_elsewhere() {
  local found env proj line folder
  if ! found=$("${DOCKER[@]}" ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2> /dev/null); then
    [ "${3:-}" != strict ] || return 1
  fi
  found=$(printf '%s\n' "$found" | awk 'NF' | grep -v -x -F -e "$2" | head -1 || true)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  for env in "$BASE_DIR/.env" "$BASE_DIR"-*/.env "$(dirname "$BASE_DIR")"/hornhoof-*/.env; do
    [ -r "$env" ] || continue
    folder=$(dirname "$env")
    [ "$folder" != "$2" ] || continue
    proj=$(value_in "$env" COMPOSE_PROJECT_NAME)
    [ -n "$proj" ] || proj=$(basename "$folder" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
    if [ "$proj" = "$1" ]; then
      printf '%s\n' "$folder"
      return 0
    fi
  done
  if [ ! -f "$2/.env" ] || [ "$(value_in "$2/.env" COMPOSE_PROJECT_NAME)" != "$1" ]; then
    found=$("${DOCKER[@]}" volume ls -q --filter "label=com.docker.compose.project=$1" 2> /dev/null | head -1 || true)
    if [ -n "$found" ]; then
      printf 'another folder on this computer\n'
      return 0
    fi
  fi
  if [ -n "$APP_REF" ] && [ -z "$FROM_UPDATER" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      folder=$(line_folder "$line")
      if [ "$folder" != "$2" ] && [ "$(basename "$folder" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')" = "$1" ]; then
        printf '%s\n' "$folder"
        return 0
      fi
    done <<< "$(read_registry 2> /dev/null || true)"
  fi
}

# The compose project of the server in SERVER_DIR: its name's, else the one its .env keeps, else its folder's.
server_project() {
  local project
  if [ -n "$NAME" ]; then
    project="hornhoof-$NAME"
  else
    project=$(env_value COMPOSE_PROJECT_NAME)
    [ -n "$project" ] || project=$(basename "$SERVER_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  fi
  printf '%s' "$project"
}

# On a computer that runs Hornhoof already, this person's or anyone else's, a new company takes a name of its own, and
# with it its own folder, compose project, database and port. Enter sets up again the company of this person's folder.
choose_name() {
  local own='' others default_taken prompt answer taken i=0
  if [ -f "$SERVER_DIR/.env" ]; then own=1; fi
  others=$(hornhoof_servers | awk -F'|' -v me="$SERVER_DIR" '$2 != me { print "  " $2 }' | sort -u)
  [ -n "$own$others" ] || return 0
  default_taken=$(project_elsewhere "$(server_project)" "$SERVER_DIR")
  say "This computer already runs Hornhoof:"
  if [ -n "$own" ]; then say "  $SERVER_DIR"; fi
  if [ -n "$others" ]; then say "$others"; fi
  say "A new company takes a name of its own, in lowercase letters, digits and dashes, such as home."
  if [ -n "$own" ]; then
    prompt="Name of the new company, or Enter to set up the one in $SERVER_DIR again: "
  elif [ -z "$default_taken" ]; then
    prompt="Name of the new company, or Enter to put it in $SERVER_DIR: "
  else
    prompt='Name of the new company: '
  fi
  while [ "$i" -lt 3 ]; do
    i=$((i + 1))
    answer=$(ask "$prompt" '')
    if [ -z "$answer" ]; then
      if [ -n "$own" ] || [ -z "$default_taken" ]; then return 0; fi
      say "The Hornhoof in $default_taken already has the name this one would take." >&2
    elif ! valid_name "$answer"; then
      say "A name takes lowercase letters, digits and dashes, up to 32 characters, such as home." >&2
    else
      taken=$(project_elsewhere "hornhoof-$answer" "$BASE_DIR-$answer")
      if [ -z "$taken" ]; then
        NAME=$answer
        SERVER_DIR="$BASE_DIR-$NAME"
        return 0
      fi
      say "The name $answer is taken by the Hornhoof in $taken." >&2
    fi
  done
  fail "No name for the new company. Run this command again with --name and a name no company here has, such as --name home."
}

# set_env <key> <value>: one line for the key in the server's .env, which stays readable only by its owner. The new
# file is written whole and then moved into place, so a failed write leaves the old one. It starts as a copy, so it
# keeps the owner when the updater writes it as root.
set_env() {
  local file="$SERVER_DIR/.env" new="$SERVER_DIR/.env.new"
  rm -f "$new"
  if [ -f "$file" ]; then cp -p "$file" "$new" 2> /dev/null || true; fi
  (
    umask 077
    touch "$new"
    chmod 600 "$new"
    {
      grep -v "^$1=" "$file" 2> /dev/null || true
      printf '%s=%s\n' "$1" "$2"
    } > "$new"
  )
  mv "$new" "$file"
}

# compose.yaml comes inside the app image, so the compose file always matches the build it starts: the exact image
# this run starts, when it names one. A machine that keeps no data also takes the overlay that leaves the services of
# the data out. An image that is here already is not downloaded again.
WORKER=''
compose_from_image() {
  local image="${APP_REF:-$APP_IMAGE:${PIN:-latest}}" cid
  say "Getting compose.yaml from $image."
  if [ -z "$PULLED" ]; then
    "${DOCKER[@]}" pull "$image" > /dev/null || fail "Could not download $image. Check the internet connection, then run this command again."
  fi
  cid=$("${DOCKER[@]}" create "$image") || fail "Could not read $image. Run this command again."
  if ! "${DOCKER[@]}" cp "$cid:/app/compose.yaml" "$SERVER_DIR/compose.yaml" > /dev/null; then
    "${DOCKER[@]}" rm "$cid" > /dev/null 2>&1 || true
    fail "$image has no compose.yaml. Pick a newer build with HORNHOOF_VERSION, or set HORNHOOF_COMPOSE_URL."
  fi
  if [ -n "$WORKER" ] && ! "${DOCKER[@]}" cp "$cid:/app/compose.worker.yaml" "$SERVER_DIR/compose.worker.yaml" > /dev/null; then
    "${DOCKER[@]}" rm "$cid" > /dev/null 2>&1 || true
    fail "$image is a build from before machines had the company's core. Update Hornhoof, then get a new command."
  fi
  "${DOCKER[@]}" rm "$cid" > /dev/null 2>&1 || true
}

# What the company knows this computer by on its local network: its name, its system, and on a Mac its addresses, which
# Docker there cannot see from inside. The updater's container is not this computer, so it leaves the lines as they are.
mac_addresses() {
  local list='' card address
  for card in en0 en1; do
    address=$(ipconfig getifaddr "$card" 2> /dev/null || true)
    case "$address" in '' | *[!0-9.]*) ;; *) list="$list${list:+,}$address" ;; esac
  done
  printf '%s' "$list"
}

machine_lines() {
  local addresses
  [ -z "$FROM_UPDATER" ] || return 0
  set_env HORNHOOF_HOSTNAME "$(host_name)"
  set_env HORNHOOF_HOST_OS "$OS"
  [ "$OS" = darwin ] || return 0
  addresses=$(mac_addresses)
  if [ -n "$addresses" ]; then set_env HORNHOOF_ADDRESSES "$addresses"; fi
}

# The address of the server's public link at hornhoof.org, from the tunnel settings the app writes once the company
# has one; empty without a link. Only a plain https address counts. A hidden name, which only the company's machines
# use to tell each other who leads, is no link: nothing ever joined through it.
public_link() {
  local settings url
  settings=$("$@" exec -T app cat /control/tunnel.json 2> /dev/null || true)
  case "$settings" in *'"hidden":true'*) return 0 ;; esac
  url=$(printf '%s' "$settings" | sed -n 's/^{"url":"\([^"]*\)".*/\1/p')
  case "$url" in
    https://*[!A-Za-z0-9.:/-]*) ;;
    https://?*) printf '%s' "$url" ;;
  esac
}

# Whether the updater left this node to be replaced now: named_free builtin, or by a node's plan.
named_free() { [ -z "$NODES_ONLY" ] || case " $NODES_ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# This server's nodes on this machine move to the node image of the same build, with their volumes: the ones that
# joined through PUBLIC_URL, through the public link or through localhost.
sweep_nodes() {
  local public linked port entry name id provider seen=' ' pulled=$PULLED
  IMAGE="${HORNHOOF_NODE_IMAGE:-$NODE_REF}"
  public=$(env_value PUBLIC_URL)
  linked=$(cd "$SERVER_DIR" && public_link "$@")
  port=$(port_of "$SERVER_DIR/.env")
  for SERVER in $public $linked "http://localhost:$port"; do
    sweep_old_nodes
    for entry in $(existing_nodes); do
      name=${entry%%:*}
      id=${entry#*:}
      named_free "$id" || continue
      case "$seen" in *" $name "*) continue ;; esac
      seen="$seen$name "
      if [ "$(node_status "$name")" = removed ]; then
        remove_node "$name"
        continue
      fi
      if [ -z "$pulled" ]; then
        pull_image
        pulled=1
      fi
      provider=${name#hornhoof-}
      provider=${provider%-*}
      LOCAL_SERVER=''
      node_server
      start_node "$name" "$id" "$provider" '' hornhoof_update
    done
  done
}

# Whether the server's built-in node runs now on NODE_REF.
node_unchanged() {
  local cid running target
  cid=$(cd "$SERVER_DIR" && "$@" ps -q node 2> /dev/null) || true
  [ -n "$cid" ] || return 1
  running=$("${DOCKER[@]}" inspect --format '{{if .State.Running}}{{.Image}}{{end}}' "$cid" 2> /dev/null || true)
  [ -n "$running" ] || return 1
  target=$("${DOCKER[@]}" image inspect --format '{{.Id}}' "$NODE_REF" 2> /dev/null || true)
  [ -n "$target" ] && [ "$running" = "$target" ]
}

# Starts the compose stack, leaving the built-in node and this server's plan nodes running when the node image is unchanged.
prepare_builtin_stop() {
  local cid
  cid=$(cd "$SERVER_DIR" && "$@" ps -q node 2> /dev/null) || true
  [ -n "$cid" ] || return 0
  prepare_node_stop "$cid" hornhoof_update
}

# Whether the nodes stay as they are for now while the app goes in: one on another image has work to let end, so the
# updater replaces it when the server says it is free. An updater from before this never does, and leaves that to the
# updater it starts next. A node that does not run has nothing to wait for.
nodes_stay() {
  node_unchanged "$@" && return 0
  [ -z "$NODES_FREE" ] && [ -z "$URGENT" ] || return 1
  local cid
  cid=$(cd "$SERVER_DIR" && "$@" ps -q node 2> /dev/null) || true
  [ -n "$cid" ] && [ "$("${DOCKER[@]}" inspect --format '{{.State.Running}}' "$cid" 2> /dev/null)" = true ]
}

# Only the nodes the updater named, whatever image the built-in node runs: each is free by itself. The app and what it
# stands on already run the build these nodes join, so nothing else is started.
replace_named_nodes() {
  if named_free builtin; then
    prepare_builtin_stop "$@"
    compose_step "$@" up -d --no-build --no-deps node || start_failed
  fi
  sweep_nodes "$@"
}

# --- Ports: one list per computer ---------------------------------------------------------------

# The list says which company's folder keeps which web and peer port, so a company that is stopped and pruned keeps them
# too. It is the file registry in the volume hornhoof-ports, reached through a short container of the app image, since
# the updater's container sees only its own company's folder. One line per folder: <folder> <web port> <peer port>.
PORT_LOCK=hornhoof-port-lock
PORT_LOCK_BUSY='Another Hornhoof install on this computer is choosing its ports. Wait a minute, then run this command again.'
PORT_LOCK_ID=''
# This folder's .env holds a company that ran before this run.
ENV_BEFORE=''
# This run chose the web or the peer port by the free search, so it may move it when something outside Docker holds it.
NEW_WEB=''
NEW_PEER=''
# Ports and subnets Docker refused during this run.
REFUSED_PORTS=''
REFUSED_SUBNETS=''
# The web port a machine that joined asks for first: the one the company's server has.
WANT_WEB=''
# Subnets this project's existing Docker networks hold right now, and whether this run chose new ones over them.
LIVE_DEFAULT_SUBNET=''
LIVE_INTERNAL_SUBNET=''
OWN_BRIDGES=''
OTHER_DOCKER_CIDRS=''
SUBNET_MOVED=''
CHOSEN_DEFAULT_SUBNET=''
CHOSEN_INTERNAL_SUBNET=''

# Whoever made a lock more than 2 minutes ago is gone. It goes by the id just read, so a lock made meanwhile stays.
remove_stale_port_lock() {
  local seen since
  seen=$("${DOCKER[@]}" inspect --format '{{.Id}} {{index .Config.Labels "io.hornhoof.since"}}' "$PORT_LOCK" 2> /dev/null) || return 1
  since=${seen##* }
  case "$since" in '' | *[!0-9]*) return 1 ;; esac
  [ "$(($(date +%s) - since))" -gt 120 ] || return 1
  "${DOCKER[@]}" rm "${seen%% *}" > /dev/null 2>&1
}

# A container's name is the one thing Docker hands out to one caller alone, so the lock is a container that never runs.
take_port_lock() {
  local deadline
  "${DOCKER[@]}" volume create hornhoof-ports > /dev/null
  deadline=$(($(date +%s) + ${HORNHOOF_PORT_LOCK_WAIT:-180}))
  until PORT_LOCK_ID=$("${DOCKER[@]}" create --name "$PORT_LOCK" --label "io.hornhoof.since=$(date +%s)" "$APP_REF" true 2> /dev/null); do
    [ "$(date +%s)" -lt "$deadline" ] || fail "$PORT_LOCK_BUSY"
    remove_stale_port_lock || sleep 1
  done
}

drop_port_lock() { "${DOCKER[@]}" rm "$1" > /dev/null 2>&1 || true; }

read_registry() { "${DOCKER[@]}" run --rm --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat /ports/registry 2> /dev/null || true'; }

write_registry() { "${DOCKER[@]}" run --rm -i --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat > /ports/registry.new && mv /ports/registry.new /ports/registry'; }

read_subnets() { "${DOCKER[@]}" run --rm --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat /ports/subnets 2> /dev/null || true'; }

write_subnets() { "${DOCKER[@]}" run --rm -i --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat > /ports/subnets.new && mv /ports/subnets.new /ports/subnets'; }

# The host ports every container publishes, running or stopped. A container gone since the list leaves the others.
bound_ports() {
  local ids
  ids=$("${DOCKER[@]}" ps -aq 2> /dev/null) || true
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per container
  "${DOCKER[@]}" inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids 2> /dev/null | tr '\n' ' ' || true
}

# A folder may hold spaces, so a line's ports are its last two words and the folder is what comes before them.
line_folder() { printf '%s' "${1% * *}"; }

line_ports() {
  local rest=${1% *}
  printf '%s %s' "${rest##* }" "${1##* }"
}

other_lines() {
  local line
  while IFS= read -r line; do
    if [ -n "$line" ] && [ "$(line_folder "$line")" != "$SERVER_DIR" ]; then printf '%s\n' "$line"; fi
  done <<< "$1"
}

own_ports() {
  local line
  while IFS= read -r line; do
    if [ "$(line_folder "$line")" = "$SERVER_DIR" ]; then line_ports "$line"; fi
  done <<< "$1"
}

# Every port another company keeps, a container publishes or Docker refused, as words.
held_ports() {
  local line env
  other_lines "$1" | while IFS= read -r line; do printf '%s ' "$(line_ports "$line")"; done
  bound_ports
  for env in "$BASE_DIR/.env" "$BASE_DIR"-*/.env "$(dirname "$BASE_DIR")"/hornhoof-*/.env; do
    if [ -r "$env" ] && [ "$env" != "$SERVER_DIR/.env" ]; then printf '%s %s ' "$(port_of "$env")" "$(value_in "$env" HORNHOOF_PEER_PORT)"; fi
  done
  printf '%s ' "$REFUSED_PORTS"
}

# Inspects existing Docker networks on this computer: separates this project's own live networks and bridge names from
# every other Docker network's IPv4 subnets.
inspect_docker_networks() {
  local project=$1 ids lines id name proj bridge internal cfg entries item cidr
  LIVE_DEFAULT_SUBNET=''
  LIVE_INTERNAL_SUBNET=''
  OWN_BRIDGES=''
  OTHER_DOCKER_CIDRS=''
  ids=$("${DOCKER[@]}" network ls -q 2> /dev/null) || true
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per network
  lines=$("${DOCKER[@]}" network inspect --format '{{.Id}}|{{.Name}}|{{with .Labels}}{{with index . "com.docker.compose.project"}}{{.}}{{end}}{{end}}|{{with .Options}}{{with index . "com.docker.network.bridge.name"}}{{.}}{{end}}{{end}}|{{.Internal}}|{{range .IPAM.Config}}{{with index . "Subnet"}}{{.}}{{end}},{{with index . "Gateway"}}{{.}}{{end}};{{end}}' $ids 2> /dev/null || true)
  while IFS='|' read -r id name proj bridge internal cfg; do
    [ -n "$id$name" ] || continue
    if [ -n "$project" ] && { [ "$proj" = "$project" ] || [ "$name" = "${project}_default" ] || [ "$name" = "${project}_internal" ]; }; then
      [ -z "$id" ] || OWN_BRIDGES="$OWN_BRIDGES br-${id:0:12}"
      [ -z "$bridge" ] || OWN_BRIDGES="$OWN_BRIDGES $bridge"
      entries=$(printf '%s' "$cfg" | tr ';' '\n')
      while IFS= read -r item; do
        cidr=${item%%,*}
        case "$cidr" in *.*/*) ;; *) continue ;; esac
        if [ "$name" = "${project}_internal" ] || [ "$internal" = true ]; then
          [ -n "$LIVE_INTERNAL_SUBNET" ] || LIVE_INTERNAL_SUBNET=$cidr
        else
          [ -n "$LIVE_DEFAULT_SUBNET" ] || LIVE_DEFAULT_SUBNET=$cidr
        fi
      done <<< "$entries"
    else
      entries=$(printf '%s' "$cfg" | tr ';' '\n')
      while IFS= read -r item; do
        cidr=${item%%,*}
        case "$cidr" in *.*/*) OTHER_DOCKER_CIDRS="$OTHER_DOCKER_CIDRS $cidr" ;; esac
      done <<< "$entries"
    fi
  done <<< "$lines"
}

parse_ifconfig_cidrs() {
  awk -v own_bridges="$OWN_BRIDGES" '
    BEGIN { for (i = 1; i <= split(own_bridges, b, " "); i++) if (b[i] != "") skip[b[i]] = 1 }
    /^[^[:space:]:]+:/ {
      iface = $1
      sub(/:.*/, "", iface)
      next
    }
    $1 == "inet" {
      if (iface == "lo" || iface == "lo0" || iface ~ /^veth/ || (iface in skip)) next
      ip = $2
      if (ip ~ /^127\./) next
      mask = ""
      for (i = 3; i < NF; i++) if ($i == "netmask") { mask = $(i + 1); break }
      if (mask ~ /^0x[0-9a-fA-F]+$/) {
        hex = tolower(substr(mask, 3))
        bits = 0
        for (i = 1; i <= length(hex); i++) {
          c = substr(hex, i, 1)
          if (c == "f") bits += 4
          else if (c == "e") bits += 3
          else if (c == "c") bits += 2
          else if (c == "8") bits += 1
        }
        if (bits >= 4 && bits <= 32) print ip "/" bits
      } else if (split(mask, m, ".") == 4) {
        bits = 0
        for (i = 1; i <= 4; i++) {
          v = m[i] + 0
          if (v == 255) bits += 8
          else if (v == 254) bits += 7
          else if (v == 252) bits += 6
          else if (v == 248) bits += 5
          else if (v == 240) bits += 4
          else if (v == 224) bits += 3
          else if (v == 192) bits += 2
          else if (v == 128) bits += 1
        }
        if (bits >= 4 && bits <= 32) print ip "/" bits
      }
    }
  '
}

raw_host_network_cidrs() {
  local iface ip
  if [ "$OS" = linux ]; then
    if command -v ip > /dev/null 2>&1; then
      ip -4 -o addr show 2> /dev/null | awk -v own_bridges="$OWN_BRIDGES" '
        BEGIN { for (i = 1; i <= split(own_bridges, b, " "); i++) if (b[i] != "") skip[b[i]] = 1 }
        $3 == "inet" {
          iface = $2
          sub(/:.*/, "", iface)
          if (iface == "lo" || iface ~ /^veth/ || (iface in skip) || ($2 in skip)) next
          print $4
        }
      ' || true
      ip -4 route show 2> /dev/null | awk -v own_bridges="$OWN_BRIDGES" '
        BEGIN { for (i = 1; i <= split(own_bridges, b, " "); i++) if (b[i] != "") skip[b[i]] = 1 }
        $1 != "default" && $1 != "" {
          dev = ""
          for (i = 2; i < NF; i++) if ($i == "dev") { dev = $(i + 1); break }
          if (dev == "lo" || dev ~ /^veth/ || (dev in skip)) next
          print $1
        }
      ' || true
    elif command -v ifconfig > /dev/null 2>&1; then
      ifconfig 2> /dev/null | parse_ifconfig_cidrs || true
    fi
  elif [ "$OS" = darwin ]; then
    if command -v ifconfig > /dev/null 2>&1; then
      ifconfig 2> /dev/null | parse_ifconfig_cidrs || true
    fi
    if command -v netstat > /dev/null 2>&1; then
      netstat -rn -f inet 2> /dev/null | awk -v own_bridges="$OWN_BRIDGES" '
        BEGIN { for (i = 1; i <= split(own_bridges, b, " "); i++) if (b[i] != "") skip[b[i]] = 1 }
        NF >= 2 && $1 != "Destination" && $1 != "Routing" && $1 != "Internet:" && $1 != "default" {
          netif = $NF
          if ($4 != "" && $4 !~ /^[0-9]+$/) netif = $4
          if (netif == "lo0" || $NF == "lo0" || (netif in skip) || ($NF in skip)) next
          print $1
        }
      ' || true
    fi
    if command -v ipconfig > /dev/null 2>&1; then
      for iface in en0 en1; do
        ip=$(ipconfig getifaddr "$iface" 2> /dev/null || true)
        [ -z "$ip" ] || printf '%s/24\n' "$ip"
      done
    fi
  fi
}

# The computer's own IPv4 addresses and routes, read only outside the updater's container.
host_network_cidrs() {
  [ -z "$FROM_UPDATER" ] || return 0
  raw_host_network_cidrs
}

reserved_other_cidrs() {
  local line env
  other_lines "$1" | while IFS= read -r line; do printf '%s\n' "$(line_ports "$line")"; done
  for env in "$BASE_DIR/.env" "$BASE_DIR"-*/.env "$(dirname "$BASE_DIR")"/hornhoof-*/.env; do
    if [ -r "$env" ] && [ "$env" != "$SERVER_DIR/.env" ]; then
      printf '%s %s\n' "$(value_in "$env" HORNHOOF_SUBNET)" "$(value_in "$env" HORNHOOF_INTERNAL_SUBNET)"
    fi
  done
  printf '%s\n' "$REFUSED_SUBNETS"
}

# select_subnet_pair <kept default> <kept internal> [<force keep>]: reads blocked CIDRs and routes on stdin and prints two
# non-overlapping /24 subnets, keeping the given ones when they remain valid and outside every blocked range (or unconditionally
# when force keep is set for an automatic update running on the live network).
select_subnet_pair() {
  awk -v kept_def="$1" -v kept_int="$2" -v force_keep="${3:-}" '
    function parse_range(tok,    slash, ip_part, p, n, oct, i, v, ip, size) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", tok)
      if (tok == "" || tok == "default") return 0
      slash = index(tok, "/")
      if (slash > 0) {
        ip_part = substr(tok, 1, slash - 1)
        p = substr(tok, slash + 1)
        if (p !~ /^[0-9]+$/) return 0
        p += 0
      } else {
        ip_part = tok
        p = -1
      }
      n = split(ip_part, oct, ".")
      if (n < 1 || n > 4) return 0
      for (i = 1; i <= n; i++) {
        if (oct[i] !~ /^[0-9]+$/) return 0
        v = oct[i] + 0
        if (v < 0 || v > 255) return 0
        oct[i] = v
      }
      for (i = n + 1; i <= 4; i++) oct[i] = 0
      if (oct[1] == 127 || oct[1] == 0 || oct[1] >= 224) return 0
      if (p < 0) p = n * 8
      if (p < 4 || p > 32) return 0
      ip = ((oct[1] * 256 + oct[2]) * 256 + oct[3]) * 256 + oct[4]
      size = 2 ^ (32 - p)
      R_START = int(ip / size) * size
      R_END = R_START + size - 1
      return 1
    }
    function overlaps_blocked(s, e,    i) {
      for (i = 1; i <= nb; i++) {
        if (s <= b_end[i] && b_start[i] <= e) return 1
      }
      return 0
    }
    function valid_cidr(cidr,    slash, tmp_oct) {
      slash = index(cidr, "/")
      if (slash <= 0) return 0
      if (split(substr(cidr, 1, slash - 1), tmp_oct, ".") != 4) return 0
      return parse_range(cidr)
    }
    function try_pick(cidr,    s, e) {
      if (!parse_range(cidr)) return 0
      s = R_START; e = R_END
      if (overlaps_blocked(s, e)) return 0
      if (picked_def == "") {
        picked_def = cidr
        b_start[++nb] = s; b_end[nb] = e
        return 1
      }
      if (picked_int == "") {
        picked_int = cidr
        b_start[++nb] = s; b_end[nb] = e
        return 1
      }
      return 1
    }
    {
      for (f = 1; f <= NF; f++) {
        if (parse_range($f)) {
          b_start[++nb] = R_START
          b_end[nb] = R_END
        }
      }
    }
    END {
      picked_def = ""
      picked_int = ""
      if (valid_cidr(kept_def) && (force_keep != "" || !overlaps_blocked(R_START, R_END))) {
        picked_def = kept_def
        b_start[++nb] = R_START; b_end[nb] = R_END
      }
      if (valid_cidr(kept_int) && (force_keep != "" || !overlaps_blocked(R_START, R_END))) {
        picked_int = kept_int
        b_start[++nb] = R_START; b_end[nb] = R_END
      }
      for (b = 200; b <= 254 && (picked_def == "" || picked_int == ""); b++) {
        for (c = 0; c <= 255 && (picked_def == "" || picked_int == ""); c++) {
          try_pick("10." b "." c ".0/24")
        }
      }
      for (b = 29; b <= 31 && (picked_def == "" || picked_int == ""); b++) {
        for (c = 0; c <= 255 && (picked_def == "" || picked_int == ""); c++) {
          try_pick("172." b "." c ".0/24")
        }
      }
      for (c = 200; c <= 254 && (picked_def == "" || picked_int == ""); c++) {
        try_pick("192.168." c ".0/24")
      }
      if (picked_def != "" && picked_int != "") {
        print picked_def " " picked_int
        exit 0
      }
      exit 1
    }
  '
}

manual_subnet_heal_command() {
  local project=$1 suffix
  if [ -n "${WORKER:-}" ]; then
    printf 'the Hornhoof install command (or HORNHOOF_SERVER_DIR=%s install.sh worker)' "$SERVER_DIR"
    return 0
  fi
  case "$project" in
    hornhoof-?*)
      suffix=${project#hornhoof-}
      if [ "$SERVER_DIR" = "$BASE_DIR-$suffix" ]; then
        printf 'install.sh server --name %s in %s' "$suffix" "$SERVER_DIR"
        return 0
      fi
      ;;
  esac
  printf 'install.sh server in %s' "$SERVER_DIR"
}

warn_updater_subnet_overlap() {
  local project=$1 def_sub=$2 int_sub=$3 addr_file="${HORNHOOF_CONTROL_DIR:-/control}/addresses.json" hits sub host cmd
  hits=$(
    {
      env_value HORNHOOF_ADDRESSES | tr ',' '\n'
      if [ -r "$addr_file" ]; then grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' "$addr_file" 2> /dev/null || true; fi
      printf -- '---\n'
      raw_host_network_cidrs
    } | awk -v def_sub="$def_sub" -v int_sub="$int_sub" -v live_def="$LIVE_DEFAULT_SUBNET" -v live_int="$LIVE_INTERNAL_SUBNET" '
      function parse_range(tok,    slash, ip_part, p, n, oct, i, v, ip, size) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", tok)
        if (tok == "" || tok == "default") return 0
        slash = index(tok, "/")
        if (slash > 0) {
          ip_part = substr(tok, 1, slash - 1)
          p = substr(tok, slash + 1)
          if (p !~ /^[0-9]+$/) return 0
          p += 0
        } else {
          ip_part = tok
          p = -1
        }
        n = split(ip_part, oct, ".")
        if (n < 1 || n > 4) return 0
        for (i = 1; i <= n; i++) {
          if (oct[i] !~ /^[0-9]+$/) return 0
          v = oct[i] + 0
          if (v < 0 || v > 255) return 0
          oct[i] = v
        }
        for (i = n + 1; i <= 4; i++) oct[i] = 0
        if (oct[1] == 127 || oct[1] == 0 || oct[1] >= 224) return 0
        if (p < 0) p = n * 8
        if (p < 4 || p > 32) return 0
        ip = ((oct[1] * 256 + oct[2]) * 256 + oct[3]) * 256 + oct[4]
        size = 2 ^ (32 - p)
        R_START = int(ip / size) * size
        R_END = R_START + size - 1
        return 1
      }
      BEGIN {
        has_ld = parse_range(live_def); ld_s = R_START; ld_e = R_END
        has_li = parse_range(live_int); li_s = R_START; li_e = R_END
      }
      $0 == "---" { raw_mode = 1; next }
      {
        for (f = 1; f <= NF; f++) {
          if (!parse_range($f)) continue
          if (raw_mode && ((has_ld && R_START == ld_s && R_END == ld_e) || (has_li && R_START == li_s && R_END == li_e))) continue
          h_tok[++nh] = $f
          h_start[nh] = R_START
          h_end[nh] = R_END
        }
      }
      function check_sub(sub_cidr,    s, e, i) {
        if (sub_cidr == "" || seen[sub_cidr]++) return
        if (!parse_range(sub_cidr)) return
        s = R_START; e = R_END
        for (i = 1; i <= nh; i++) {
          if (s <= h_end[i] && h_start[i] <= e) {
            print sub_cidr " " h_tok[i]
            return
          }
        }
      }
      END {
        check_sub(def_sub)
        check_sub(int_sub)
      }
    '
  ) || true
  [ -n "$hits" ] || return 0
  cmd=$(manual_subnet_heal_command "$project")
  while IFS=' ' read -r sub host; do
    [ -n "$sub" ] || continue
    say "Docker network $sub in $SERVER_DIR overlaps this computer's network ($host), and an automatic update cannot recreate the network it runs on. Run $cmd on this computer once to move it to a free subnet."
  done <<< "$hits"
}

choose_subnets() {
  local subnets_list=$1 own_sub kept_def kept_int pair def_sub int_sub project
  project=$(env_value COMPOSE_PROJECT_NAME)
  [ -n "$project" ] || project=$(basename "$SERVER_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  inspect_docker_networks "$project"
  own_sub=$(own_ports "$subnets_list")
  kept_def=$(env_value HORNHOOF_SUBNET)
  [ -n "$kept_def" ] || kept_def=${own_sub%% *}
  [ -n "$kept_def" ] || kept_def=$LIVE_DEFAULT_SUBNET
  kept_int=$(env_value HORNHOOF_INTERNAL_SUBNET)
  [ -n "$kept_int" ] || kept_int=${own_sub##* }
  [ -n "$kept_int" ] || kept_int=$LIVE_INTERNAL_SUBNET
  case " $REFUSED_SUBNETS " in *" $kept_def "*) kept_def='' ;; esac
  case " $REFUSED_SUBNETS " in *" $kept_int "*) kept_int='' ;; esac

  if [ -n "$FROM_UPDATER" ]; then
    # The updater runs on the project's live network, so an update keeps the live subnets when they exist and logs a clear
    # recovery instruction when a live project subnet covers the computer's own network.
    pair=$(
      {
        printf '%s\n' "$OTHER_DOCKER_CIDRS"
        reserved_other_cidrs "$subnets_list"
      } | select_subnet_pair "$kept_def" "$kept_int" 1
    ) || fail "No free Docker subnet for Hornhoof that avoids other Docker projects."
    CHOSEN_DEFAULT_SUBNET=${pair%% *}
    CHOSEN_INTERNAL_SUBNET=${pair#* }
    warn_updater_subnet_overlap "$project" "$CHOSEN_DEFAULT_SUBNET" "$CHOSEN_INTERNAL_SUBNET"
    return 0
  fi

  SUBNET_MOVED=''
  pair=$(
    {
      printf '%s\n' "$OTHER_DOCKER_CIDRS"
      host_network_cidrs
      reserved_other_cidrs "$subnets_list"
    } | select_subnet_pair "$kept_def" "$kept_int"
  ) || fail "No free Docker subnet for Hornhoof that avoids this computer's networks and other Docker projects. Free a private network range, then run this command again."
  def_sub=${pair%% *}
  int_sub=${pair#* }
  if { [ -n "$LIVE_DEFAULT_SUBNET" ] && [ "$LIVE_DEFAULT_SUBNET" != "$def_sub" ]; } ||
    { [ -n "$LIVE_INTERNAL_SUBNET" ] && [ "$LIVE_INTERNAL_SUBNET" != "$int_sub" ]; }; then
    SUBNET_MOVED=1
  fi
  # Networks made before compose.yaml named their subnets have none in .env. Compose takes them for changed and cannot
  # make them again while other containers are on them, so they are made again here, with their subnets when those
  # stay free.
  if [ -n "$LIVE_DEFAULT_SUBNET$LIVE_INTERNAL_SUBNET" ] && { [ -z "$(env_value HORNHOOF_SUBNET)" ] || [ -z "$(env_value HORNHOOF_INTERNAL_SUBNET)" ]; }; then
    SUBNET_MOVED=1
  fi
  CHOSEN_DEFAULT_SUBNET=$def_sub
  CHOSEN_INTERNAL_SUBNET=$int_sub
}

# From the updater localhost is its own container, so only a run by hand can ask it.
port_is_free() {
  case "$2" in *" $1 "*) return 1 ;; esac
  [ -n "$FROM_UPDATER" ] || ! port_answers "$1"
}

# first_free_port <first> <held words>: the first free one of the hundred from <first>.
first_free_port() {
  local port=$1
  until port_is_free "$port" "$2"; do
    port=$((port + 1))
    [ "$port" -lt $(($1 + 100)) ] || fail "No free port from $1 to $(($1 + 99)) for Hornhoof. Stop what uses them, then run this command again."
  done
  printf '%s' "$port"
}

# kept_port <refused> <.env key> <list value>: the port this company keeps already, unless Docker just refused it.
kept_port() {
  local port
  port=$(env_value "$2")
  port=${port:-$3}
  if [ "$port" != "$1" ]; then printf '%s' "$port"; fi
}

# The lists come first: a failed write leaves .env as it was, and a failed .env write a line that only holds the reservation.
record_ports() {
  local lock
  lock=$("${DOCKER[@]}" inspect --format '{{.Id}}' "$PORT_LOCK" 2> /dev/null) || true
  [ "$lock" = "$PORT_LOCK_ID" ] || fail "$PORT_LOCK_BUSY"
  { other_lines "$1"; printf '%s %s %s\n' "$SERVER_DIR" "$2" "$3"; } | write_registry ||
    fail "Could not write the list of Hornhoof's ports on this computer. Run this command again."
  { other_lines "$4"; printf '%s %s %s\n' "$SERVER_DIR" "$5" "$6"; } | write_subnets ||
    fail "Could not write the list of Hornhoof's subnets on this computer. Run this command again."
  set_env HORNHOOF_PORT "$2"
  set_env HORNHOOF_PEER_PORT "$3"
  set_env HORNHOOF_SUBNET "$5"
  set_env HORNHOOF_INTERNAL_SUBNET "$6"
  # People get the company's link at setup, so the server starts at its address on this computer. Another address of
  # its own, such as a domain, goes into PUBLIC_URL later. A machine that only joined has no address of the company's.
  if [ -z "$ENV_BEFORE" ] && [ -z "$WORKER" ]; then set_env PUBLIC_URL "http://localhost:$2"; fi
}

check_registry_project_collision() {
  [ -z "$FROM_UPDATER" ] && [ -z "$ENV_BEFORE" ] || return 0
  local project line folder
  project=$(env_value COMPOSE_PROJECT_NAME)
  [ -n "$project" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    folder=$(line_folder "$line")
    if [ "$(basename "$folder" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')" = "$project" ]; then
      fail "The Hornhoof in $folder already has the name $project on this computer, and this one would start in its containers. Run this command again with --name and a name no company here has, such as --name home."
    fi
  done <<< "$(other_lines "$1")"
}

choose_ports() {
  local registry subnets_list own held web peer
  registry=$(read_registry) || fail "Could not read the list of Hornhoof's ports on this computer. Run this command again."
  subnets_list=$(read_subnets) || fail "Could not read the list of Hornhoof's subnets on this computer. Run this command again."
  check_registry_project_collision "$registry"
  own=$(own_ports "$registry")
  held=" $(held_ports "$registry") "
  web=$(kept_port "$1" HORNHOOF_PORT "${own%% *}")
  peer=$(kept_port "$1" HORNHOOF_PEER_PORT "${own##* }")
  # A company from before ports were kept runs on the first one.
  if [ -z "$web" ] && [ -n "$ENV_BEFORE" ]; then web=$FIRST_PORT; fi
  # A machine that joined takes the web port of the company's server when it is free here, so the company opens at the
  # same address on every machine.
  if [ -z "$web" ] && [ -n "$WANT_WEB" ] && port_is_free "$WANT_WEB" "$held"; then
    web=$WANT_WEB
    NEW_WEB=1
  fi
  if [ -z "$web" ]; then
    web=$(first_free_port "$FIRST_PORT" "$held")
    NEW_WEB=1
  fi
  if [ -z "$peer" ]; then
    peer=$(first_free_port "$FIRST_PEER_PORT" "$held")
    NEW_PEER=1
  fi
  choose_subnets "$subnets_list"
  record_ports "$registry" "$web" "$peer" "$subnets_list" "$CHOSEN_DEFAULT_SUBNET" "$CHOSEN_INTERNAL_SUBNET"
}

# reserve_ports [<port>]: settles this company's ports and subnets under the lock, which goes whatever happens. Given a
# port Docker refused, the side it belongs to searches again and the other side keeps its port.
reserve_ports() {
  if [ -n "${1:-}" ]; then REFUSED_PORTS="$REFUSED_PORTS $1"; fi
  take_port_lock
  trap 'drop_port_lock "$PORT_LOCK_ID"' EXIT
  choose_ports "${1:-}"
  trap - EXIT
  drop_port_lock "$PORT_LOCK_ID"
}

# The host port Docker could not bind, from words like "Bind for 0.0.0.0:8080 failed: port is already allocated" or
# "listen tcp 0.0.0.0:8080: bind: address already in use". The first number after a colon is the port.
refused_port() {
  printf '%s\n' "$1" | grep -E 'port is already allocated|address already in use' | head -1 | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true
}

subnet_overlap_error() {
  case "$1" in
    *'Pool overlaps'* | *'conflicts with existing route'* | *'overlaps with'*) return 0 ;;
    *) return 1 ;;
  esac
}

retry_subnet_overlap() {
  [ -z "$FROM_UPDATER" ] || return 1
  REFUSED_SUBNETS="$REFUSED_SUBNETS $(env_value HORNHOOF_SUBNET) $(env_value HORNHOOF_INTERNAL_SUBNET)"
  say "The chosen Docker subnet overlaps an existing route on this computer, so Hornhoof takes another one."
  compose_step "$@" down || true
  reserve_ports
}

port_is_new() {
  { [ -n "$NEW_WEB" ] && [ "$1" = "$(env_value HORNHOOF_PORT)" ]; } || { [ -n "$NEW_PEER" ] && [ "$1" = "$(env_value HORNHOOF_PEER_PORT)" ]; }
}

# These two publish the ports, so this is where a port something outside Docker holds shows. A port this run chose moves
# to the next one, up to 5 times; a port the company already has stays, as other things know it by that port.
start_keeper_and_front() {
  local moved=0 sub_moved=0 port
  until compose_step "$@" up -d --no-build keeper front; do
    if [ "$sub_moved" -lt 5 ] && subnet_overlap_error "$STEP_OUTPUT" && retry_subnet_overlap "$@"; then
      sub_moved=$((sub_moved + 1))
      continue
    fi
    if held_networks; then return 0; fi
    port=$(refused_port "$STEP_OUTPUT")
    [ -n "$port" ] || start_failed
    if [ "$moved" -ge 5 ] || ! port_is_new "$port"; then
      fail "Port $port is taken by a program outside Docker. Stop what uses it, then run this command again."
    fi
    moved=$((moved + 1))
    say "Port $port is taken, so Hornhoof takes another one."
    reserve_ports "$port"
  done
}

# What the last compose step said, for what a failure tells the person.
STEP_OUTPUT=''
# compose_step <compose command...>: runs in the server folder, showing what compose says as it comes.
compose_step() {
  local said rc=0
  said=$(mktemp)
  (cd "$SERVER_DIR" && "$@") 2>&1 | tee "$said" || rc=$?
  STEP_OUTPUT=$(cat "$said")
  rm -f "$said"
  return "$rc"
}

start_failed() {
  if [ -n "$FROM_UPDATER" ]; then fail "Hornhoof did not start."; fi
  networks_failed
  fail "Hornhoof did not start. Run docker compose logs in $SERVER_DIR to see why."
}

# A network compose.yaml asks for otherwise than Docker made it, even with the same subnet, as one made before the file
# named its subnets, compose removes to make it again, which Docker refuses while containers are on it that this up does
# not start: the built-in node, the updater, a tunnel the file names no more. A run by hand then stops the project whole
# and makes its networks again, once: NETWORKS_MAY_REMAKE says it still may, and NETWORKS_HELD that a step was refused so.
NETWORKS_MAY_REMAKE=''
NETWORKS_HELD=''
held_networks() {
  [ -n "$NETWORKS_MAY_REMAKE" ] || return 1
  case "$STEP_OUTPUT" in *'has active endpoints'*) NETWORKS_HELD=1 ;; *) return 1 ;; esac
}

# remake_networks <compose command...>: the built-in node hears that it stops for an update, then the project stops whole
# with its networks and the containers of services its file no longer names, its data staying in its volumes. The next
# up makes the networks as compose.yaml asks, with the subnets .env names.
remake_networks() {
  NETWORKS_MAY_REMAKE=''
  prepare_builtin_stop "$@"
  compose_step "$@" down --remove-orphans || true
}

# What a person reads when Docker still keeps a network of this server after the project stopped whole: something outside
# it is on that network.
networks_failed() {
  local project
  [ -z "$FROM_UPDATER" ] || return 0
  case "$STEP_OUTPUT" in *'has active endpoints'*) ;; *) return 0 ;; esac
  project=$(server_project)
  fail "Hornhoof did not start: Docker would not make the networks of this server again, as containers outside it are still on them. Stop the containers on the networks ${project}_default and ${project}_internal, then run this command again."
}

# The app waits for migrate, so compose runs it first and a failed start may be the database not reaching this build.
# Older versions of Compose 2 say "didn't completed", so the check stops before that word.
start_app() {
  compose_step "$@" && return 0
  if held_networks; then return 0; fi
  case "$STEP_OUTPUT" in
    *'"migrate" didn'*) fail "Hornhoof could not bring its database up to this build. Run docker compose logs migrate in $SERVER_DIR to see why." ;;
  esac
  start_failed
}

# The old build never runs on a schema it does not know, so the app stops first. The keeper and front start before it
# comes back, so the maintenance answer is up while migrate runs. Run by hand, it makes the project's networks again
# first when their subnets move, or once when compose says it cannot make one again while containers are on it.
start_server_services() {
  say "Starting Hornhoof${FROM_UPDATER:+ ${PIN:-latest}}."
  if [ -n "$NODES_ONLY" ]; then
    replace_named_nodes "$@"
    return 0
  fi
  if [ -z "$FROM_UPDATER" ]; then
    NETWORKS_MAY_REMAKE=1
    if [ -n "$SUBNET_MOVED" ]; then remake_networks "$@"; fi
  fi
  NETWORKS_HELD=''
  start_services "$@"
  [ -n "$NETWORKS_HELD" ] || return 0
  say "Docker keeps the networks of this server as they were made while containers are on them, so Hornhoof stops for a moment and makes them again."
  remake_networks "$@"
  NETWORKS_HELD=''
  start_services "$@"
}

# start_services <compose command...>: the services in their order. A step compose refused as held_networks says ends it
# early, with NETWORKS_HELD set.
start_services() {
  local sub_moved=0
  (cd "$SERVER_DIR" && "$@" stop app) > /dev/null 2>&1 || true
  until compose_step "$@" up -d --no-build --remove-orphans --wait db; do
    if [ "$sub_moved" -lt 5 ] && subnet_overlap_error "$STEP_OUTPUT" && retry_subnet_overlap "$@"; then
      sub_moved=$((sub_moved + 1))
      continue
    fi
    if held_networks; then return 0; fi
    networks_failed
    fail "The database did not start. Run docker compose logs db in $SERVER_DIR to see why."
  done
  start_keeper_and_front "$@"
  [ -z "$NETWORKS_HELD" ] || return 0
  if [ -n "$FROM_UPDATER" ]; then
    if nodes_stay "$@"; then
      start_app "$@" up -d --no-build app
    else
      prepare_builtin_stop "$@"
      start_app "$@" up -d --no-build app node
      sweep_nodes "$@"
    fi
    return 0
  fi
  if nodes_stay "$@"; then
    start_app "$@" up -d --no-build app updater
    [ -z "$NETWORKS_HELD" ] || return 0
    node_unchanged "$@" || say "The updater replaces the built-in node and the other nodes on this computer when what they run has ended."
  else
    prepare_builtin_stop "$@"
    start_app "$@" up -d --no-build
  fi
}

# Only a revision it can read as 2 or more goes on, so a value it cannot read ends in the handover, which is safe.
older_updater_runs_this() { [ -n "$FROM_UPDATER" ] && ! [ "${HORNHOOF_UPDATER_REV:-1}" -ge 2 ] 2> /dev/null; }

# An older updater cannot run this build's move, so this build's updater takes the update over: the helper starts it,
# which replaces the updater this script runs under, and with it this script. Until then only .env and compose.yaml
# have changed, and the old installer writes both back on the way back. This never returns: an older updater takes a 0
# for a finished install, and removes what the new compose file does not name while the old app runs. A helper that
# lacks its two folders finds no update and exits 0, which shows only as this wait running out, and then it goes back.
hand_over_update() {
  say "This build's updater takes over the update first."
  "${DOCKER[@]}" run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$SERVER_DIR:$SERVER_DIR" -v "${1}_control:/control" -e "HORNHOOF_SERVER_DIR=$SERVER_DIR" "$UPDATER_REF" --take-over > /dev/null ||
    fail "Could not start the updater of this build, so nothing changed."
  sleep "${HORNHOOF_HANDOVER_WAIT:-300}"
  fail "The updater of this build did not take over, so nothing changed. Run install.sh server in $SERVER_DIR."
}

server_mode() {
  local env_file public local_url project taken link fact id i=0 health=''
  local -a compose
  detect_system
  if [ -z "$FROM_UPDATER" ]; then ensure_docker; fi
  find_compose
  compose=("${COMPOSE[@]}")
  if [ -z "$FROM_UPDATER" ] && [ -z "$NAME" ] && [ -z "${HORNHOOF_SERVER_DIR:-}" ]; then choose_name; fi
  # A named server is its own compose project, so its containers, network and volumes never meet another's.
  if [ -n "$NAME" ]; then compose+=(-p "hornhoof-$NAME"); fi
  if [ -z "$FROM_UPDATER" ]; then
    taken=$(project_elsewhere "$(server_project)" "$SERVER_DIR")
    [ -z "$taken" ] || fail "The Hornhoof in $taken already has the name $(server_project) on this computer, and this one would start in its containers. Run this command again with --name and a name no company here has, such as --name home."
  fi

  mkdir -p "$SERVER_DIR"
  env_file="$SERVER_DIR/.env"
  if [ -n "$FROM_UPDATER" ] && [ ! -f "$env_file" ]; then fail "There is no $env_file to update."; fi
  if [ -f "$env_file" ]; then
    # A new .env keeps its HORNHOOF_PORT empty until the ports are chosen, so a first run that stopped before that is
    # not taken for a company from before ports were kept, which runs on the first port.
    if ! grep -q '^HORNHOOF_PORT=$' "$env_file"; then ENV_BEFORE=1; fi
    say "Keeping the settings in $env_file."
    # A .env without POSTGRES_PASSWORD keeps the password compose gives, the one its database was made with.
    if ! grep -q '^NODE_KEY=' "$env_file"; then
      set_env NODE_KEY "$(new_secret)"
      say "Added NODE_KEY to $env_file."
    fi
  else
    (
      umask 077
      printf 'HORNHOOF_SECRET=%s\nNODE_KEY=%s\nPOSTGRES_PASSWORD=%s\nHORNHOOF_PORT=\n' "$(new_secret)" "$(new_secret)" "$(new_password)" > "$env_file.new"
    )
    mv "$env_file.new" "$env_file"
    say "Wrote fresh secrets to $env_file. Keep it safe: HORNHOOF_SECRET is needed to read the stored API keys."
  fi
  # .env names the compose project and the folder too, for the updater and for docker compose run by hand here.
  project=$(server_project)
  set_env COMPOSE_PROJECT_NAME "$project"
  set_env HORNHOOF_SERVER_DIR "$SERVER_DIR"
  set_env HORNHOOF_VERSION "${PIN:-latest}"
  # The exact images compose starts.
  [ -n "$APP_REF" ] || APP_REF="$APP_IMAGE:${PIN:-latest}"
  [ -n "$NODE_REF" ] || NODE_REF="ghcr.io/invariant0x/hornhoof-node:${PIN:-latest}"
  [ -n "$UPDATER_REF" ] || UPDATER_REF="ghcr.io/invariant0x/hornhoof-updater:${PIN:-latest}"
  set_env HORNHOOF_APP_REF "$APP_REF"
  set_env HORNHOOF_NODE_REF "$NODE_REF"
  set_env HORNHOOF_UPDATER_REF "$UPDATER_REF"
  # The built-in node hears what the computer has, as the other nodes do; compose passes these on to it.
  while IFS= read -r fact; do
    [ -n "$fact" ] && set_env "${fact%%=*}" "${fact#*=}"
  done < <(host_facts)
  # The updater runs in a container of its own, not on this computer, so it leaves the hash the last install wrote.
  if [ -z "$FROM_UPDATER" ]; then
    id=$(host_id)
    if [ -n "$id" ]; then set_env HORNHOOF_HOST_ID "$id"; fi
  fi
  machine_lines
  # What the network knows this machine by, written once: the hash above, so the machine's own key never leaves it, or
  # random hex from the updater, whose container cannot read that key.
  if [ -z "$(env_value HORNHOOF_MACHINE_ID)" ]; then set_env HORNHOOF_MACHINE_ID "${id:-$(random_hex 16)}"; fi

  if [ -n "$FROM_UPDATER" ] && [ -n "$COMPOSE_SRC" ]; then
    cp "$COMPOSE_SRC" "$SERVER_DIR/compose.yaml"
  elif [ -n "$COMPOSE_URL" ]; then
    say "Getting compose.yaml into $SERVER_DIR."
    curl -fsSL "$COMPOSE_URL" -o "$SERVER_DIR/compose.yaml" || fail "Could not download $COMPOSE_URL. Check the internet connection, then run this command again."
  else
    compose_from_image
  fi

  if older_updater_runs_this; then hand_over_update "$project"; fi

  # The updater downloads them before it saves the database; an updater from before leaves it to this.
  if [ -z "$PULLED" ]; then
    say "Downloading the Hornhoof images."
    (cd "$SERVER_DIR" && "${compose[@]}" pull) || fail "Could not download the images. Check the internet connection, then run this command again."
  fi
  reserve_ports
  # The updater checks the new server's answer itself, and replaces itself once it comes.
  start_server_services "${compose[@]}"
  if [ -n "$FROM_UPDATER" ]; then return 0; fi
  # Worked out only now, since a port this run chose may have moved while the services started.
  local_url="http://localhost:$(port_of "$env_file")"
  public=$(env_value PUBLIC_URL)
  [ -n "$public" ] || public=$local_url
  say "Waiting for Hornhoof to answer."
  # A server that answers may still only read: it changes nothing until its keeper has confirmed that it leads, and
  # whoever opened it then could not set it up. A build from before servers said so names no mode.
  until health=$(curl -fsS --max-time 5 "$local_url/api/health" 2> /dev/null) && takes_changes "$health"; do
    i=$((i + 2))
    if [ "$i" -ge "$ANSWER_WAIT" ]; then
      [ -n "$health" ] || fail "Hornhoof did not answer within $ANSWER_WAIT seconds. Run docker compose logs app in $SERVER_DIR to see why."
      fail "Hornhoof answers and takes no changes yet: its keeper has not confirmed that this server leads. Run docker compose logs keeper in $SERVER_DIR to see why."
    fi
    sleep 2
  done
  # Whoever opens a new server first would become its owner, so it sets up only through the link with its setup code,
  # which only the server can tell. A server set up already, or one from before setup codes, gives no link.
  link=$(cd "$SERVER_DIR" || exit 0; "${compose[@]}" exec -T app node apps/server/dist/cli.js setup-link 2> /dev/null | tail -n 1 || true)
  case "$link" in
    *[[:space:]]*) say "Hornhoof is running at $public." ;;
    http://*/setup\?code=* | https://*/setup\?code=*) say "Hornhoof is running. Open this link to set it up: $link" ;;
    *) say "Hornhoof is running at $public." ;;
  esac
}

# takes_changes <health>: what the server said of itself names no mode in which it only reads, or is off.
takes_changes() {
  case "$1" in *'"mode":"read"'* | *'"mode":"off"'*) return 1 ;; esac
}

# The updater of a machine that joined runs this, from the build it moves to: the core's compose files and settings name
# that build, and its keeper and front start on it. The updater itself is replaced only after the keeper answers, by the
# updater that runs this. Then the company's nodes here go to the node image of the same build, each only when it runs
# another image, with its work let end as on any update.
worker_mode() {
  local env_file
  detect_system
  WORKER=1
  env_file="$SERVER_DIR/.env"
  [ -n "${HORNHOOF_SERVER_DIR:-}" ] && [ -f "$env_file" ] || fail "There is no core of a company to update here. $USAGE"
  # A machine that joined names the worker's compose file in its settings, also once it keeps a copy of the company's
  # data and its role says so.
  case "$(env_value HORNHOOF_ROLE):$(env_value COMPOSE_FILE)" in
    worker:* | data:*compose.worker.yaml*) ;;
    *) fail "$SERVER_DIR is a server's folder: run install.sh server there." ;;
  esac
  [ -n "$APP_REF" ] || APP_REF="$APP_IMAGE:${PIN:-latest}"
  [ -n "$NODE_REF" ] || NODE_REF="$APP_IMAGE-node:${PIN:-latest}"
  [ -n "$UPDATER_REF" ] || UPDATER_REF="$APP_IMAGE-updater:${PIN:-latest}"
  # The updater asks for the nodes alone when the core runs its build already and a node could not be moved with it.
  if [ -z "${HORNHOOF_WORKER_NODES:-}" ]; then worker_core_update; fi
  worker_nodes_update
}

worker_core_update() {
  find_compose
  set_env HORNHOOF_VERSION "${PIN:-latest}"
  set_env HORNHOOF_APP_REF "$APP_REF"
  set_env HORNHOOF_NODE_REF "$NODE_REF"
  set_env HORNHOOF_UPDATER_REF "$UPDATER_REF"
  if [ -n "$COMPOSE_SRC" ]; then
    cp "$COMPOSE_SRC" "$SERVER_DIR/compose.yaml"
    cp "${COMPOSE_SRC%compose.yaml}compose.worker.yaml" "$SERVER_DIR/compose.worker.yaml" || fail "This build has no compose.worker.yaml beside its compose.yaml."
  else
    compose_from_image
  fi
  if [ -z "$PULLED" ]; then
    (cd "$SERVER_DIR" && "${COMPOSE[@]}" pull) || fail "Could not download the images. Check the internet connection, then run this command again."
  fi
  if ! grep -q '^HORNHOOF_PORT=$' "$SERVER_DIR/.env"; then ENV_BEFORE=1; fi
  reserve_ports
  say "Starting the company's core${PIN:+ $PIN}."
  if [ -z "$FROM_UPDATER" ] && [ -n "$SUBNET_MOVED" ]; then
    compose_step "${COMPOSE[@]}" down --remove-orphans || true
    compose_step "${COMPOSE[@]}" up -d --no-build || start_failed
    return 0
  fi
  # shellcheck disable=SC2046 # the services are compose service names, one word each.
  compose_step "${COMPOSE[@]}" up -d --no-build $(core_services) || start_failed
}

# What the updater of a machine that joined starts on the new build: the keeper and front, and on a machine that keeps
# a copy of the company's data everything its settings turn on but the updater, which is replaced after them.
core_services() {
  local names
  if [ "$(env_value HORNHOOF_ROLE)" != data ]; then
    printf 'keeper front'
    return 0
  fi
  names=$( (cd "$SERVER_DIR" && "${COMPOSE[@]}" config --services 2> /dev/null) | grep -v '^updater$' | tr '\n' ' ') || true
  if [ -n "${names// /}" ]; then printf '%s' "${names% }"; else printf 'keeper front'; fi
}

# The company's nodes on this machine, whichever of its addresses each joined through, go to the node image of the core's
# build: each only when it runs another, with its work let end first.
worker_nodes_update() {
  local env_file="$SERVER_DIR/.env" entry name id provider seen=' ' front
  IMAGE="${HORNHOOF_NODE_IMAGE:-$NODE_REF}"
  front=$(port_of "$env_file")
  while IFS= read -r SERVER; do
    [ -n "$SERVER" ] || continue
    sweep_old_nodes
    for entry in $(existing_nodes); do
      name=${entry%%:*}
      id=${entry#*:}
      case "$seen" in *" $name "*) continue ;; esac
      seen="$seen$name "
      [ "$("${DOCKER[@]}" inspect --format '{{.Config.Image}}' "$name" 2> /dev/null || true)" != "$IMAGE" ] || continue
      provider=${name#hornhoof-}
      provider=${provider%-*}
      local_front "$front"
      if wait_for_node "$name"; then
        move_node "$name"
        start_node "$name" "$id" "$provider" '' hornhoof_update
      fi
    done
  done <<< "$(core_servers "$env_file")"
}

# --- Start --------------------------------------------------------------------------------------

MODE=node
CODE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --join)
      [ $# -ge 2 ] || fail "--join needs the code from Hornhoof. $USAGE"
      CODE=$2
      shift
      ;;
    --owner-key)
      [ $# -ge 2 ] || fail "--owner-key needs the key from the command Hornhoof showed. $USAGE"
      OWNER_KEY=$2
      shift
      ;;
    --server)
      [ $# -ge 2 ] || fail "--server needs the Hornhoof address. $USAGE"
      SERVER=${2%/}
      shift
      ;;
    --name)
      [ $# -ge 2 ] || fail "--name needs a name for this company's server. $USAGE"
      NAME=$2
      shift
      ;;
    --urgent) URGENT=1 ;;
    node) MODE=node ;;
    server) MODE=server ;;
    worker) MODE=worker ;;
    --uninstall) MODE=uninstall ;;
    -h | --help)
      say "$USAGE"
      exit 0
      ;;
    *) fail "Unknown option $1. $USAGE" ;;
  esac
  shift
done

if [ -n "$OWNER_KEY" ]; then
  [[ "$OWNER_KEY" =~ ^[A-Za-z0-9_-]{80,200}$ ]] || fail "This command's owner key cannot be read. Get a new command in Hornhoof."
  [ -n "$CODE" ] || fail "--owner-key goes with --join. $USAGE"
fi
if [ -n "$NAME" ]; then
  [ "$MODE" = server ] || [ "$MODE" = uninstall ] || fail "--name is for install.sh server or --uninstall. $USAGE"
  valid_name "$NAME" || fail "--name takes lowercase letters, digits and dashes, up to 32 characters, such as acme."
  SERVER_DIR="$BASE_DIR-$NAME"
fi
# The updater names the folder it runs in.
if [ -n "${HORNHOOF_SERVER_DIR:-}" ]; then SERVER_DIR=$HORNHOOF_SERVER_DIR; fi

case "$MODE" in
  node) node_mode "$CODE" ;;
  server) server_mode ;;
  worker) worker_mode ;;
  uninstall) uninstall_mode ;;
esac
