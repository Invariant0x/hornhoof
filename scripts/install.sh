#!/usr/bin/env bash
# Hornhoof installer.
#
#   curl -fsSL <server>/install.sh | bash -s -- --join <code>   start this machine's nodes for the subscriptions in the code
#   install.sh                                                   update the nodes already on this machine
#   install.sh server                                            install or update the Hornhoof server
#   install.sh server --name <name>                              another company's server on this computer, in ~/hornhoof-<name>
#   install.sh --uninstall                                       remove this machine's nodes
#
# Server installs pin the build in .env as HORNHOOF_VERSION (HORNHOOF_VERSION=<tag> picks one, latest otherwise) and
# take compose.yaml from that build of the image. .env also names the exact app, node and updater images compose
# starts: by the build's tag, or as HORNHOOF_APP_REF, HORNHOOF_NODE_REF and HORNHOOF_UPDATER_REF give them. The updater
# service runs the installer of the build it moves to with HORNHOOF_FROM_UPDATER=1: no questions and no Docker setup,
# the compose file it brings, the images it checked by digest, and this server's nodes on this machine move to the
# same build. HORNHOOF_PULLED=1 says the images are on this computer already, so it downloads none of them.
#
# Several companies can share a computer: each node carries the address of the server it works for, and an
# update or an uninstall touches only that server's nodes.
#
# The server fills in its own address when it serves this file. The script arrives through a pipe, so every
# question is read from the terminal. It runs on the bash that ships with macOS (3.2).
set -euo pipefail

SERVER="${HORNHOOF_SERVER:-__HORNHOOF_SERVER__}"
TTY="${HORNHOOF_TTY:-/dev/tty}"
STATE_DIR="${HORNHOOF_HOME:-$HOME/.hornhoof}"
IMAGE="${HORNHOOF_NODE_IMAGE:-ghcr.io/invariant0x/hornhoof-node:latest}"
COMPOSE_URL="${HORNHOOF_COMPOSE_URL:-}"
APP_IMAGE="${HORNHOOF_APP_IMAGE:-ghcr.io/invariant0x/hornhoof}"
BASE_DIR="${HORNHOOF_DIR:-$HOME/hornhoof}"
SERVER_DIR=$BASE_DIR
NAME=''
PIN="${HORNHOOF_VERSION:-}"
FROM_UPDATER="${HORNHOOF_FROM_UPDATER:-}"
COMPOSE_SRC="${HORNHOOF_COMPOSE_FILE:-}"
PULLED="${HORNHOOF_PULLED:-}"
APP_REF="${HORNHOOF_APP_REF:-}"
NODE_REF="${HORNHOOF_NODE_REF:-}"
UPDATER_REF="${HORNHOOF_UPDATER_REF:-}"

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
USAGE='Usage: install.sh [--join <code>] | server [--name <name>] | --uninstall'

OS=''
ARCH=''
DOCKER=(docker)
SUDO_SAID=''

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
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

ensure_docker() {
  say "Checking Docker."
  docker_works && return 0
  if [ "$OS" = darwin ]; then
    if command -v docker > /dev/null 2>&1 && ! command -v colima > /dev/null 2>&1; then
      fail "Docker is installed but not running. Start Docker Desktop or OrbStack, then run this command again."
    fi
    install_colima
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
  say "Getting the node image $IMAGE."
  if ! "${DOCKER[@]}" pull "$IMAGE" > /dev/null; then
    if "${DOCKER[@]}" image inspect "$IMAGE" > /dev/null 2>&1; then
      say "Using the local image."
    else
      fail "Could not download $IMAGE. Check the internet connection, then run this command again."
    fi
  fi
}

machine_id() {
  mkdir -p "$STATE_DIR"
  if ! grep -Eq '^[0-9a-f]{32}$' "$STATE_DIR/machine" 2> /dev/null; then
    od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$STATE_DIR/machine"
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

# Lines "<subscriptionId> <provider> <key>", turned into "id:provider:key" words.
JOINED=''
join_machine() {
  local code=$1 machine host body request status id provider key
  case "$code" in
    '' | *[!A-Za-z0-9_-]*) fail "This command is not valid. Copy it again from Hornhoof." ;;
  esac
  machine=$(machine_id)
  host=$(hostname 2> /dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-120)
  [ -n "$host" ] || host=machine
  say "Connecting this machine ($host) to Hornhoof."
  body=$(mktemp)
  request=$(mktemp)
  printf '{"code":"%s","machineId":"%s","hostname":"%s","os":"%s","arch":"%s"}' "$code" "$machine" "$host" "$OS" "$ARCH" > "$request"
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
    000)
      rm -f "$body"
      fail "Could not reach $SERVER. Check the connection, then run this command again."
      ;;
    *)
      rm -f "$body"
      fail "Hornhoof answered $status to the join. Try again in a minute, or get a new command in Hornhoof."
      ;;
  esac
  while read -r id provider key; do
    case "$id$provider$key" in *[!A-Za-z0-9_-]*) fail "Hornhoof sent a line this installer cannot read. Update Hornhoof and get a new command." ;; esac
    case "$provider" in claude | codex | kimi | glm) ;; *) continue ;; esac
    [ -n "$id" ] && [ -n "$key" ] && JOINED="$JOINED $id:$provider:$key"
  done < "$body"
  rm -f "$body"
  [ -n "$JOINED" ] || fail "Hornhoof returned no subscriptions for this command. Get a new one in Hornhoof under Subscriptions."
}

node_name() { printf 'hornhoof-%s-%s' "$2" "${1:0:8}"; }

STARTED=''
# What a failed start tells the person. Once the join used the code, running it again only gets a 410.
RETRY='Run this command again.'
# start_node <name> <id> <provider> [key]: the key goes into the node's volume through stdin, never on a command line.
start_node() {
  local name=$1 id=$2 provider=$3 key=${4:-}
  if [ -n "$key" ]; then
    printf '%s %s %s %s\n' "$NODE_SERVER" "$id" "$provider" "$key" |
      "${DOCKER[@]}" run --rm -i --network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "$name:/data" "$IMAGE" set-key ||
      fail "Could not save the key for $name. $RETRY"
  fi
  say "Starting $name."
  "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
  # shellcheck disable=SC2086 # the two --add-host words appear only for a server on localhost
  # Root inside the container only: the node runs its agents as a user of their own, keeps its key and programs from
  # them and checks which agent calls its tools. Nothing from the host is mounted and no new privileges can be gained.
  "${DOCKER[@]}" run -d --name "$name" --label "$LABEL=$id" --label "$SERVER_LABEL=$SERVER" --restart unless-stopped --cap-drop ALL \
    --user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETGID --cap-add SETUID --cap-add SYS_PTRACE \
    --security-opt no-new-privileges --shm-size 2g -v "$name:/data" ${LOCAL_SERVER:+--add-host} ${LOCAL_SERVER:+host.docker.internal:host-gateway} \
    "$IMAGE" > /dev/null || fail "Could not start $name (docker logs $name shows why). $RETRY"
  STARTED="$STARTED $name"
}

node_status() { "${DOCKER[@]}" exec "$1" node "$NODE_MAIN" status 2> /dev/null || echo offline; }

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

open_link() {
  if [ "$OS" = darwin ]; then
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

login_node() {
  local name=$1 provider watcher
  provider=${name#hornhoof-}
  provider=${provider%-*}
  say "Signing in to $(program_name "$provider") on $name. A browser opens when a link appears."
  "${DOCKER[@]}" exec "$name" rm -f /data/login-url > /dev/null 2>&1 || true
  watch_link "$name" &
  watcher=$!
  if ! "${DOCKER[@]}" exec -it "$name" node "$NODE_MAIN" login < "$TTY"; then
    say "The sign-in on $name did not finish. To try again, run the install command without --join."
  fi
  kill "$watcher" 2> /dev/null || true
  wait "$watcher" 2> /dev/null || true
}

node_mode() {
  local code=$1 entry name id provider key status removed='' existing joined_names=''
  detect_system
  check_server
  ensure_docker
  pull_image
  node_server

  existing=$(existing_nodes)
  for entry in $existing; do
    name=${entry%%:*}
    if [ "$(node_status "$name")" = removed ]; then
      say "Removing $name, which was removed in Hornhoof."
      "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true
      "${DOCKER[@]}" volume rm "$name" > /dev/null 2>&1 || true
      removed="$removed $name"
    fi
  done

  if [ -n "$code" ]; then
    join_machine "$code"
    RETRY='This command is used up: disconnect this machine in Hornhoof under Subscriptions, then get a new command.'
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
    for entry in $existing; do
      name=${entry%%:*}
      id=${entry#*:}
      case " $removed $STARTED " in *" $name "*) continue ;; esac
      provider=${name#hornhoof-}
      provider=${provider%-*}
      start_node "$name" "$id" "$provider"
    done
  fi

  if [ -z "$STARTED" ]; then
    say "There are no Hornhoof nodes on this machine yet. Get the install command in Hornhoof under Subscriptions."
    return 0
  fi

  # New nodes always go through the sign-in (it ends at once when the program is signed in already).
  for name in $STARTED; do
    case " $joined_names " in
      *" $name "*) login_node "$name" ;;
      *) if [ "$(node_status "$name")" != ready ]; then login_node "$name"; fi ;;
    esac
  done

  say ""
  say "Nodes on this machine:"
  for name in $STARTED; do
    provider=${name#hornhoof-}
    provider=${provider%-*}
    status=$(node_status "$name")
    case "$status" in
      ready) status="ready" ;;
      needs_login) status="needs sign-in, run the install command again without --join" ;;
      *) status="not answering yet, see docker logs $name" ;;
    esac
    say "  $(program_name "$provider"): $status ($name)"
  done
}

uninstall_mode() {
  local entry names='' name answer
  detect_system
  docker_works || fail "Docker is not running, so there are no nodes to remove. Start Docker, then run this again."
  for entry in $(existing_nodes); do names="$names ${entry%%:*}"; done
  if [ -z "$names" ]; then
    say "There are no Hornhoof nodes on this machine."
    return 0
  fi
  say "Hornhoof nodes on this machine:"
  for name in $names; do say "  $name"; done
  answer=$(ask "Remove these nodes? [y/N] " n)
  case "$answer" in
    y | Y | yes) ;;
    *)
      say "Nothing was removed."
      return 0
      ;;
  esac
  for name in $names; do "${DOCKER[@]}" rm -f "$name" > /dev/null 2>&1 || true; done
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

new_secret() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# The database password goes into the database address, so it is hex.
new_password() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

# The port a server's .env keeps; one from before servers kept a port has the first one.
port_of() {
  local port
  port=$(grep '^HORNHOOF_PORT=' "$1" 2> /dev/null | tail -1 | cut -d= -f2- || true)
  printf '%s\n' "${port:-$FIRST_PORT}"
}

# Something listens on the port; curl ends with 7 only when nothing does.
port_answers() {
  local rc=0
  curl -s -o /dev/null --max-time 2 "http://localhost:$1/" > /dev/null 2>&1 || rc=$?
  [ "$rc" -ne 7 ]
}

# The first port from 8080 that no other Hornhoof on this computer keeps, running or not, and nothing listens on.
free_port() {
  local port=$FIRST_PORT env claimed=' '
  for env in "$BASE_DIR/.env" "$BASE_DIR"-*/.env; do
    if [ -f "$env" ] && [ "$env" != "$SERVER_DIR/.env" ]; then claimed="$claimed$(port_of "$env") "; fi
  done
  while case "$claimed" in *" $port "*) true ;; *) false ;; esac || port_answers "$port"; do
    port=$((port + 1))
    [ "$port" -lt $((FIRST_PORT + 100)) ] || fail "No free port from $FIRST_PORT to $((FIRST_PORT + 99)) for Hornhoof. Stop what uses them, then run this command again."
  done
  printf '%s' "$port"
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

env_value() { grep "^$1=" "$SERVER_DIR/.env" 2> /dev/null | tail -1 | cut -d= -f2- || true; }

# compose.yaml comes inside the app image, so the compose file always matches the build it starts.
compose_from_image() {
  local image="$APP_IMAGE:${PIN:-latest}" cid
  say "Getting compose.yaml from $image."
  "${DOCKER[@]}" pull "$image" > /dev/null || fail "Could not download $image. Check the internet connection, then run this command again."
  cid=$("${DOCKER[@]}" create "$image") || fail "Could not read $image. Run this command again."
  if ! "${DOCKER[@]}" cp "$cid:/app/compose.yaml" "$SERVER_DIR/compose.yaml" > /dev/null; then
    "${DOCKER[@]}" rm "$cid" > /dev/null 2>&1 || true
    fail "$image has no compose.yaml. Pick a newer build with HORNHOOF_VERSION, or set HORNHOOF_COMPOSE_URL."
  fi
  "${DOCKER[@]}" rm "$cid" > /dev/null 2>&1 || true
}

# The address of the server's public link at hornhoof.org, from the tunnel settings the app writes once the company
# has one; empty without a link. Only a plain https address counts.
public_link() {
  local url
  url=$("$@" exec -T app cat /control/tunnel.json 2> /dev/null | sed -n 's/^{"url":"\([^"]*\)".*/\1/p' || true)
  case "$url" in
    https://*[!A-Za-z0-9.:/-]*) ;;
    https://?*) printf '%s' "$url" ;;
  esac
}

# This server's nodes on this machine move to the node image of the same build, with their volumes: the ones that
# joined through PUBLIC_URL, through the public link or through localhost.
sweep_nodes() {
  local public linked port entry name id provider seen=' ' pulled=$PULLED
  IMAGE="${HORNHOOF_NODE_IMAGE:-$NODE_REF}"
  public=$(env_value PUBLIC_URL)
  linked=$(cd "$SERVER_DIR" && public_link "$@")
  port=$(port_of "$SERVER_DIR/.env")
  for SERVER in $public $linked "http://localhost:$port"; do
    for entry in $(existing_nodes); do
      name=${entry%%:*}
      id=${entry#*:}
      case "$seen" in *" $name "*) continue ;; esac
      seen="$seen$name "
      if [ -z "$pulled" ]; then
        pull_image
        pulled=1
      fi
      provider=${name#hornhoof-}
      provider=${provider%-*}
      LOCAL_SERVER=''
      node_server
      start_node "$name" "$id" "$provider"
    done
  done
}

server_mode() {
  local env_file url public port local_url project link i=0
  local -a compose
  detect_system
  if [ -z "$FROM_UPDATER" ]; then ensure_docker; fi
  if "${DOCKER[@]}" compose version > /dev/null 2>&1; then
    compose=("${DOCKER[@]}" compose)
  elif command -v docker-compose > /dev/null 2>&1; then
    compose=(docker-compose)
  elif [ "$OS" = darwin ] && command -v brew > /dev/null 2>&1; then
    say "Installing Docker Compose with Homebrew."
    brew install docker-compose || fail "Homebrew could not install Docker Compose. Run brew doctor, then run this command again."
    compose=(docker-compose)
  else
    fail "Docker Compose is missing. Install the Docker Compose plugin, then run this command again."
  fi
  # A named server is its own compose project, so its containers, network and volumes never meet another's.
  if [ -n "$NAME" ]; then compose+=(-p "hornhoof-$NAME"); fi

  mkdir -p "$SERVER_DIR"
  env_file="$SERVER_DIR/.env"
  if [ -n "$FROM_UPDATER" ] && [ ! -f "$env_file" ]; then fail "There is no $env_file to update."; fi
  if [ -f "$env_file" ]; then
    say "Keeping the settings in $env_file."
    # A .env without POSTGRES_PASSWORD keeps the password compose gives, the one its database was made with.
    if ! grep -q '^NODE_KEY=' "$env_file"; then
      set_env NODE_KEY "$(new_secret)"
      say "Added NODE_KEY to $env_file."
    fi
  else
    port=$(free_port)
    url=$(ask "Address people will open Hornhoof at (Enter for http://localhost:$port): " "http://localhost:$port")
    case "$url" in
      http://* | https://*) ;;
      *) fail "The address must start with http:// or https://. Run this command again." ;;
    esac
    (
      umask 077
      printf 'HORNHOOF_SECRET=%s\nNODE_KEY=%s\nPOSTGRES_PASSWORD=%s\nPUBLIC_URL=%s\nHORNHOOF_PORT=%s\n' "$(new_secret)" "$(new_secret)" "$(new_password)" "${url%/}" "$port" > "$env_file.new"
    )
    mv "$env_file.new" "$env_file"
    say "Wrote fresh secrets to $env_file. Keep it safe: HORNHOOF_SECRET is needed to read the stored API keys."
  fi
  # .env names the compose project and the folder too, for the updater and for docker compose run by hand here.
  if [ -n "$NAME" ]; then
    project="hornhoof-$NAME"
  else
    project=$(env_value COMPOSE_PROJECT_NAME)
    [ -n "$project" ] || project=$(basename "$SERVER_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  fi
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
  local_url="http://localhost:$(port_of "$env_file")"
  public=$(env_value PUBLIC_URL)
  [ -n "$public" ] || public=$local_url

  if [ -n "$FROM_UPDATER" ] && [ -n "$COMPOSE_SRC" ]; then
    cp "$COMPOSE_SRC" "$SERVER_DIR/compose.yaml"
  elif [ -n "$COMPOSE_URL" ]; then
    say "Getting compose.yaml into $SERVER_DIR."
    curl -fsSL "$COMPOSE_URL" -o "$SERVER_DIR/compose.yaml" || fail "Could not download $COMPOSE_URL. Check the internet connection, then run this command again."
  else
    compose_from_image
  fi

  # The updater downloads them before it saves the database; an updater from before leaves it to this.
  if [ -z "$PULLED" ]; then
    say "Downloading the Hornhoof images."
    (cd "$SERVER_DIR" && "${compose[@]}" pull) || fail "Could not download the images. Check the internet connection, then run this command again."
  fi
  # The updater checks the new server's answer itself, and replaces itself once it comes.
  if [ -n "$FROM_UPDATER" ]; then
    say "Starting Hornhoof ${PIN:-latest}."
    (cd "$SERVER_DIR" && "${compose[@]}" up -d --no-build db app node tunnel) || fail "Hornhoof did not start."
    sweep_nodes "${compose[@]}"
    return 0
  fi
  say "Starting Hornhoof."
  (cd "$SERVER_DIR" && "${compose[@]}" up -d --no-build) || fail "Hornhoof did not start. Run docker compose logs in $SERVER_DIR to see why."
  say "Waiting for Hornhoof to answer."
  until curl -fsS --max-time 5 "$local_url/api/health" > /dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "Hornhoof did not answer within 2 minutes. Run docker compose logs app in $SERVER_DIR to see why."
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
    node) MODE=node ;;
    server) MODE=server ;;
    --uninstall) MODE=uninstall ;;
    -h | --help)
      say "$USAGE"
      exit 0
      ;;
    *) fail "Unknown option $1. $USAGE" ;;
  esac
  shift
done

if [ -n "$NAME" ]; then
  [ "$MODE" = server ] || fail "--name is for install.sh server. $USAGE"
  case "$NAME" in
    -* | *[!a-z0-9-]*) fail "--name takes lowercase letters, digits and dashes, such as acme." ;;
  esac
  [ "${#NAME}" -le 32 ] || fail "--name takes up to 32 characters."
  SERVER_DIR="$BASE_DIR-$NAME"
fi
# The updater names the folder it runs in.
if [ -n "${HORNHOOF_SERVER_DIR:-}" ]; then SERVER_DIR=$HORNHOOF_SERVER_DIR; fi

case "$MODE" in
  node) node_mode "$CODE" ;;
  server) server_mode ;;
  uninstall) uninstall_mode ;;
esac
