# shellcheck shell=bash
# The nodes of this server. An update replaces the app alone while a node runs another image, since the turns on it would
# stop with it. Afterwards this asks the server, with the built-in node's key, to let the work of the nodes on this
# computer that run another image end: the server keeps new work off them, says of each when it is free, and goes on
# saying one is not past its deadline, when it told Operations. The installer of the build that runs replaces each as
# soon as it is free itself, whatever the others wait for. A server from before this says so only of all of them
# together. Requests marked immediate or urgent replace them with the app at once. The same goes for an update an updater
# from before this ran, and for install.sh server by hand.
#
# On a computer that is not the server's own, install.sh starts one updater for each server's nodes there, in a container
# of the updater image of the server's build with this computer's Docker, and with the hash that computer goes by
# (<host>). It has no server folder, no requests and no commands. Every few minutes it reads the installer the server
# serves, as data and never as a program: the node and updater images of the server's build, each by its digest in
# Hornhoof's own repository, and the server's own computer. It first moves to that updater image, through a helper that
# outlives it. Only then a node of that server on another image goes to that node image, through the installer this image
# carries, the one of the same build, with these values filled in: it asks the server, with the node's own key from its
# volume, to let the node's work end, and replaces the node once it is free. So what runs with this computer's Docker is
# only ever an image of Hornhoof's, by its digest. On the server's own computer it does nothing: the updater next to the
# server moves the nodes there.

# How often it looks whether a node is behind, and asks again after a server that gave no answer, in seconds.
NODES_CHECK=30
# How long it leaves the nodes alone after an installer failed or a server said it cannot wait, in seconds.
NODES_RETRY=300
# When to look at the nodes next, in seconds since 1970.
NODES_AT=0
# The look at a worker's nodes that runs now.
NODES_LOOK=''
# The installer of this updater's own build, which it runs for the nodes of a server on another computer.
INSTALLER="${HORNHOOF_INSTALLER:-/usr/local/share/hornhoof/install.sh}"

# Where the server takes the updater's word of the nodes: the same place its health is asked.
nodes_url() {
  local health
  health=$(health_url)
  printf '%s/api/nodes/update' "${health%/api/health}"
}

is_old_node() {
  case "$1" in
    *[!A-Za-z0-9_.-]*) return 1 ;;
    hornhoof-*-*-old-?*) return 0 ;;
    *) return 1 ;;
  esac
}

node_healthy() {
  [ "$(docker inspect --format '{{.State.Running}} {{.State.Restarting}}' "$1" 2> /dev/null || true)" = 'true false' ]
}

# Renamed -old-* node containers never run again: auto-restart comes off at once, and each goes once the node container
# it was renamed from runs and is not restarting.
sweep_old_node() {
  local name=$1 base
  if [ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name" 2> /dev/null || true)" != no ]; then
    docker update --restart=no "$name" > /dev/null 2>&1 || true
  fi
  base=${name%-old-*}
  if node_healthy "$base"; then
    docker rm -f "$name" > /dev/null 2>&1 || true
  fi
}

# The nodes on this computer that run another image than the one .env names, or have stopped, by the images of this
# server's own repositories, as words: builtin for the built-in node, the plan on its label for each other. One of
# another server on this computer counts too: the server names only its own.
nodes_behind() {
  local cid running target name plan
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  own "$IMAGE" "$(env_value HORNHOOF_APP_REF)" && own "$NODE_IMAGE" "$(env_value HORNHOOF_NODE_REF)" && own "$UPDATER_IMAGE" "$(env_value HORNHOOF_UPDATER_REF)" || return 0
  plain_tag "$(env_value HORNHOOF_VERSION)" || return 0
  target=$(docker image inspect --format '{{.Id}}' "$(env_value HORNHOOF_NODE_REF)" 2> /dev/null || true)
  cid=$(compose ps -aq node 2> /dev/null || true)
  running=''
  if [ -n "$cid" ]; then running=$(docker inspect --format '{{.Image}}' "$cid" 2> /dev/null || true); fi
  if [ -n "$running" ] && { [ "$running" != "$target" ] || [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2> /dev/null || true)" = false ]; }; then printf 'builtin '; fi
  { docker ps -a --filter label=hornhoof.subscription --format '{{.Names}} {{.Label "hornhoof.subscription"}}' 2> /dev/null || true; } | while read -r name plan; do
    if is_old_node "$name"; then
      sweep_old_node "$name" >&2
      continue
    fi
    case "$plan" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    running=$(docker inspect --format '{{.Image}}' "$name" 2> /dev/null || true)
    if [ -n "$running" ] && { [ "$running" != "$target" ] || [ "$(docker inspect --format '{{.State.Running}}' "$name" 2> /dev/null || true)" = false ]; }; then printf '%s ' "$plan"; fi
  done
}

# ask_nodes <method> <answer file> [names]: the HTTP code of the server's answer about these nodes on this computer, or
# about all of them. The key goes to curl on its input, so no command line shows it.
ask_nodes() {
  local body
  body=$(jq -cn --arg names "${3:-}" 'if $names == "" then {scope: "server"} else {scope: "server", nodes: ($names | split(" ") | map(select(length > 0)))} end')
  printf 'header = "Authorization: Bearer %s"\n' "$(env_value NODE_KEY)" |
    curl -sS --max-time 10 --config - -X "$1" -H 'content-type: application/json' -d "$body" -o "$2" -w '%{http_code}' "$(nodes_url)" 2> /dev/null
}

# replace_nodes [names]: these nodes are free, or all of them with no names: the installer of the build that runs replaces
# them, and the server lets go of them. The others keep their wait and its deadline.
replace_nodes() {
  WORK=$(mktemp -d)
  NODES_FREE=1
  NODES_ONLY=${1:-}
  if ! install "$(env_value HORNHOOF_VERSION)" "$(env_value HORNHOOF_APP_REF)" "$(env_value HORNHOOF_NODE_REF)" "$(env_value HORNHOOF_UPDATER_REF)"; then
    printf 'Could not replace the nodes: %s\n' "$(tail -n 3 "$WORK/install.log" 2> /dev/null | tr '\n' ' ')"
    NODES_AT=$(($(date +%s) + NODES_RETRY))
  fi
  NODES_FREE=''
  NODES_ONLY=''
  ask_nodes DELETE /dev/null "${1:-}" > /dev/null || true
  rm -rf "$WORK"
  WORK=''
}

# free_of <answer file> <names>: those of these names the server says are free. The names are the ones this found itself,
# so the installer gets nothing else the server says.
free_of() {
  local name
  for name in $2; do
    if jq -e --arg name "$name" 'any(.free[]?; . == $name)' "$1" > /dev/null 2>&1; then printf '%s ' "$name"; fi
  done
}

# act_on_nodes <answer file> <names>: what the server said of the nodes behind. One from before free replaces them all or
# none, and its installer moves them only along with the built-in node: with that one on its image nothing would ever move,
# so they go back to work until a later look.
act_on_nodes() {
  local free now
  now=$(date +%s)
  if jq -e '.free != null' "$1" > /dev/null 2>&1; then
    free=$(free_of "$1" "$2")
    if [ -n "$free" ]; then replace_nodes "${free% }"; fi
  else
    case " $2 " in
      *' builtin '*) if [ "$(jq -r '.ready // false' "$1")" = true ]; then replace_nodes; fi ;;
      *)
        ask_nodes DELETE /dev/null > /dev/null || true
        NODES_AT=$((now + NODES_RETRY))
        ;;
    esac
  fi
}

# One look at the nodes, which never waits: a request for an update goes first, and the server lets go of the nodes when
# this stops asking.
# On a worker the installer moves the company's nodes with the core. One whose work would not end then stays on its
# image, so now and again the installer of this updater's own build looks at the nodes alone: each on another image than
# the one .env names goes to it once it is free, and the others are left as they are.
# The installer waits for each such node's work to end, however long that takes, so it runs beside this loop, one look
# at a time, and says what it did in nodes.log of the control folder once it ends. A run that looks once waits for it:
# its container goes when it ends, and an installer cut off between removing a node and starting it would lose the node.
worker_nodes() {
  local now
  now=$(date +%s)
  [ "$now" -ge "$NODES_AT" ] || return 0
  NODES_AT=$((now + NODES_RETRY))
  if nodes_look_runs; then return 0; fi
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] && [ -f "$INSTALLER" ] || return 0
  own "$NODE_IMAGE" "$(env_value HORNHOOF_NODE_REF)" || return 0
  (
    log=$(mktemp) && seen=$(mktemp -d) || exit 0
    installer_control "$seen" || true
    code=0
    HORNHOOF_CONTROL_DIR="$seen" HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_FROM_UPDATER=1 HORNHOOF_UPDATER_REV="$UPDATER_REV" HORNHOOF_WORKER_NODES=1 \
      HORNHOOF_VERSION="$(env_value HORNHOOF_VERSION)" HORNHOOF_APP_REF="$(env_value HORNHOOF_APP_REF)" HORNHOOF_NODE_REF="$(env_value HORNHOOF_NODE_REF)" \
      HORNHOOF_UPDATER_REF="$(env_value HORNHOOF_UPDATER_REF)" bash "$INSTALLER" worker > "$log" 2>&1 || code=$?
    # Written in the updater's own temporary folder while the installer runs, and then put in place whole.
    publish "$CONTROL/nodes.log" over cat -- "$log" || printf '%s\n' 'Could not write nodes.log in the control folder.' >&2
    rm -rf -- "${log:?}" "${seen:?}"
    [ "$code" = 0 ] || printf 'Could not move the nodes of this machine to its build: see nodes.log in the control folder.\n'
  ) &
  NODES_LOOK=$!
  if [ -n "$ONCE" ]; then wait "$NODES_LOOK" || true; fi
}

# Whether the look at a worker's nodes still runs.
nodes_look_runs() { [ -n "$NODES_LOOK" ] && kill -0 "$NODES_LOOK" 2> /dev/null; }

# Two installers never move one node at once: a worker's install waits for the look at its nodes to end. The machine
# has its turn by then, so no new work comes to its nodes and the look ends soon.
after_nodes_look() {
  nodes_look_runs || return 0
  step install "Waiting for the look at this machine's nodes to end."
  while nodes_look_runs; do sleep 1; done
}

catch_up_nodes() {
  local now code answer poll behind
  if joined; then
    worker_nodes
    return 0
  fi
  # A machine the company was installed on that follows another now has no server of its own to ask about its nodes:
  # they move with its next install.
  if worker; then return 0; fi
  now=$(date +%s)
  [ "$now" -ge "$NODES_AT" ] || return 0
  NODES_AT=$((now + NODES_CHECK))
  behind=$(nodes_behind || true)
  [ -n "$behind" ] || return 0
  answer=$(mktemp)
  code=$(ask_nodes POST "$answer" "$behind" || true)
  case "$code" in
    200)
      poll=$(jq -r '((.pollAfterMs // 5000) / 1000) | ceil' "$answer")
      NODES_AT=$((now + poll))
      act_on_nodes "$answer" "$behind"
      ;;
    # Only a Hornhoof server's own refusal of a path it does not know says it is from before. Another 404, as the public
    # link gives for a moment while the machine that leads fences itself, is a server away: the next look asks again.
    404)
      if jq -e '.error.code == "not_found"' "$answer" > /dev/null 2>&1; then
        printf 'This server is from before nodes wait for their work, so they stay on their image and what they run goes on.\n'
        NODES_AT=$((now + NODES_RETRY))
      fi
      ;;
  esac
  rm -f "$answer"
}

# --- A server's nodes on another computer ------------------------------------------------------

# How often the updater of a server's nodes looks at them, and how long it waits after a look that failed, in seconds.
NODES_EVERY=300
NODES_BACKOFF=900
SAID=''

# Each thing once until something else is said, so a look every few minutes keeps the log short.
tell() {
  if [ "$*" != "$SAID" ]; then printf '%s\n' "$*"; fi
  SAID=$*
}

# An http or https address with nothing in it that a command line or a Docker filter would take for more.
plain_server() {
  case "$1" in http://?* | https://?*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9.:/_-]*) return 1 ;; esac
  [ "${#1}" -le 200 ]
}

# The hash a computer goes by, 64 hex digits, or none.
plain_host() {
  [ -n "$1" ] || return 0
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 64 ]
}

# served <name> <file>: what the installer a server serves says in that line of its own, read as data.
served() { sed -n "s/^$1=\"\\(.*\\)\"\$/\\1/p" "$2" | head -n 1; }

# The name of the one updater of a server's nodes on this computer, from the server's address.
updater_name() {
  if command -v sha256sum > /dev/null 2>&1; then
    printf 'hornhoof-updater-%s' "$(printf '%s' "$1" | sha256sum | cut -c1-12)"
  else
    printf 'hornhoof-updater-%s' "$(printf '%s' "$1" | shasum -a 256 | cut -c1-12)"
  fi
}

# behind_of <server> <image>: the plans of that server's nodes on this computer, by their labels, that have stopped or
# whose image Docker does not keep as <image>; a stopped container whose volume says Hornhoof removed its plan goes here.
behind_of() {
  local name plan id
  { docker ps -a --filter label=hornhoof.subscription --filter "label=hornhoof.server=$1" --format '{{.Names}} {{.Label "hornhoof.subscription"}}' 2> /dev/null || true; } | while read -r name plan; do
    if is_old_node "$name"; then
      sweep_old_node "$name" >&2
      continue
    fi
    case "$plan" in '' | *[!A-Za-z0-9_-]*) continue ;; esac
    id=$(docker inspect --format '{{.Image}}' "$name" 2> /dev/null || true)
    [ -n "$id" ] || continue
    if [ "$(docker inspect --format '{{.State.Running}}' "$name" 2> /dev/null || true)" != false ]; then
      case " $(docker image inspect --format '{{join .RepoDigests " "}}' "$id" 2> /dev/null || true) " in *" $2 "*) continue ;; esac
    elif docker cp "$name:/data/removed" - > /dev/null 2>&1; then
      printf 'Removing %s, which was removed in Hornhoof.\n' "$name" >&2
      docker rm -f "$name" > /dev/null 2>&1 || true
      docker volume rm "$name" > /dev/null 2>&1 || true
      continue
    fi
    printf '%s ' "$plan"
  done
}

# fill_installer <server> <node image> <updater image> <host>: this image's own installer as the server serves it. Every value
# matched its pattern before, so none holds a character sed or bash would take for more.
fill_installer() {
  sed -e "s|__HORNHOOF_SERVER__|$1|g" -e "s|__HORNHOOF_NODE_IMAGE__|$2|g" -e "s|__HORNHOOF_UPDATER_IMAGE__|$3|g" \
    -e "s|__HORNHOOF_HOST_ID__|$4|g" "$INSTALLER"
}

# nodes_look <server> <image> <host>: one look at that server's nodes here. The installers of several nodes wait for them
# side by side, each replacing only its own. Fails when the server did not answer, the move to the server's updater did not
# start, or an installer failed.
nodes_look() {
  local served build updater server_host behind plan pids='' pid failed=''
  served="$WORK/served"
  if ! curl -fsS --max-time 30 -o "$served" "$1/install.sh" 2> /dev/null; then
    tell "Could not reach $1, so its nodes here stay as they are for now."
    return 1
  fi
  build=$(served BUILD_IMAGE "$served")
  updater=$(served UPDATER_BUILD "$served")
  server_host=$(served SERVER_HOST_ID "$served")
  if [ -n "$3" ] && [ "$server_host" = "$3" ]; then
    tell "This is the computer of $1, so the updater next to that server moves its nodes here."
    return 0
  fi
  if ! by_digest "$NODE_IMAGE" "$build" || ! by_digest "$UPDATER_IMAGE" "$updater" || ! plain_host "$server_host"; then
    tell "$1 does not name the node and updater images of its build by their digests, so its nodes here stay as they are."
    return 0
  fi
  if [ "$updater" != "$2" ]; then
    tell "Moving to $updater, the updater of the build $1 runs. That one moves the nodes."
    docker run -d --rm --name "$(updater_name "$1")-move" -v /var/run/docker.sock:/var/run/docker.sock "$updater" start-nodes "$1" "$updater" "$3" > /dev/null || {
      tell "Could not start $updater, so the nodes here stay as they are for now."
      return 1
    }
    return 0
  fi
  behind=$(behind_of "$1" "$build")
  [ -n "$behind" ] || return 0
  SAID=''
  fill_installer "$1" "$build" "$updater" "$server_host" > "$WORK/install.sh"
  for plan in $behind; do
    printf 'The node of plan %s runs another build than %s, so it goes to %s once its work ends.\n' "$plan" "$1" "$build"
    HORNHOOF_FROM_UPDATER=1 HORNHOOF_NODES_ONLY="$plan" HORNHOOF_TTY=/dev/null bash "$WORK/install.sh" > "$WORK/$plan.log" 2>&1 &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" || failed=1; done
  for plan in $behind; do cat "$WORK/$plan.log"; done
  [ -z "$failed" ]
}

# nodes_mode <server> <image> <host> [--once]: a look at the nodes every few minutes, and a longer wait after one that failed.
nodes_mode() {
  local code
  if ! plain_server "$1" || ! by_digest "$UPDATER_IMAGE" "$2" || ! plain_host "$3"; then
    printf 'Usage: updater.sh nodes <server address> <updater image by digest> <host hash> [--once]\n' >&2
    exit 2
  fi
  while true; do
    WORK=$(mktemp -d)
    code=0
    nodes_look "$1" "$2" "$3" || code=1
    rm -rf "$WORK"
    if [ "${4:-}" = --once ]; then exit "$code"; fi
    disk_care || printf 'Could not look after the Docker disk.\n'
    if [ "$code" = 0 ]; then sleep "$NODES_EVERY"; else sleep "$NODES_BACKOFF"; fi
  done
}

# start_nodes <server> <image> <host>: the one updater of that server's nodes on this computer runs <image>, under a name that
# comes from the server's address, so Docker never lets a second one start. One that runs that image already stays; the others
# go once the image is here. It starts again with Docker.
start_nodes() {
  local name old
  if ! plain_server "$1" || ! by_digest "$UPDATER_IMAGE" "$2" || ! plain_host "$3"; then
    printf 'Usage: updater.sh start-nodes <server address> <updater image by digest> <host hash>\n' >&2
    return 2
  fi
  name=$(updater_name "$1")
  [ "$(docker inspect --format '{{if .State.Running}}{{.Config.Image}}{{end}}' "$name" 2> /dev/null || true)" != "$2" ] || return 0
  docker image inspect "$2" > /dev/null 2>&1 || docker pull "$2" > /dev/null || return 1
  for old in $(docker ps -aq --filter label=hornhoof.updater=nodes --filter "label=hornhoof.server=$1" 2> /dev/null || true); do
    docker rm -f "$old" > /dev/null 2>&1 || true
  done
  docker run -d --name "$name" --label hornhoof.updater=nodes --label "hornhoof.server=$1" --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock "$2" nodes "$1" "$2" "$3" > /dev/null
}
