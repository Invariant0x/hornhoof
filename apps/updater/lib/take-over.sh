# shellcheck shell=bash
# An update an older updater began. An older updater says no revision, so an installer that needs this one takes over:
# its helper container puts this build's updater in the place of the older one, which then finds the update in the older
# one's note, saves the database again with the app stopped, and goes on (go_on_handed_over in update.sh). If this
# build's updater does not start, the helper brings the older one back to go back.

# How long this build's updater may take to say it goes on with an update it takes over.
TAKE_OVER_WAIT="${HORNHOOF_TAKE_OVER_WAIT:-60}"
TAKEN_OVER="This build's updater goes on with the update."

# Whether this build's updater says it goes on with the update, within TAKE_OVER_WAIT seconds.
taken_over() {
  local i=0
  while true; do
    case "$(jq -r '.log // empty' "$CONTROL/status.json" 2> /dev/null || true)" in *"$TAKEN_OVER"*) return 0 ;; esac
    [ "$i" -lt "$TAKE_OVER_WAIT" ] || return 1
    i=$((i + 1))
    sleep 1
  done
}

# live_subnet <network>: the first subnet Docker gave that network, empty when it names none; fails when there is no
# such network.
live_subnet() {
  local line cfg
  line=$(docker network inspect --format "$NETWORK_FORMAT" "$1" 2> /dev/null | head -n 1 || true)
  [ -n "$line" ] || return 1
  cfg=${line##*|}
  cfg=${cfg%%;*}
  printf '%s' "${cfg%%,*}"
}

# The subnets the project's networks have in Docker, OLD_DEFAULT and OLD_INTERNAL, each empty when there is no such
# network; fails when Docker has neither.
OLD_DEFAULT=''
OLD_INTERNAL=''
live_networks() {
  local project found=''
  project=$(compose_project)
  if OLD_DEFAULT=$(live_subnet "${project}_default"); then found=1; else OLD_DEFAULT=''; fi
  if OLD_INTERNAL=$(live_subnet "${project}_internal"); then found=1; else OLD_INTERNAL=''; fi
  [ -n "$found" ]
}

# Whether the networks Docker has are not the ones the compose file asks for: the file names their subnets, and the
# settings hold none for a network that is there, or another subnet than it has. Compose takes such a network for
# changed and removes it to make it again, which it cannot while other containers are on it, so it would start nothing.
old_networks() {
  local want_default want_internal
  grep -q 'HORNHOOF_SUBNET' "$SERVER_DIR/compose.yaml" 2> /dev/null || return 1
  live_networks || return 1
  want_default=$(env_value HORNHOOF_SUBNET)
  want_internal=$(env_value HORNHOOF_INTERNAL_SUBNET)
  { [ -n "$OLD_DEFAULT" ] && [ "$want_default" != "$OLD_DEFAULT" ]; } || { [ -n "$OLD_INTERNAL" ] && [ "$want_internal" != "$OLD_INTERNAL" ]; }
}

# Whether compose refused because Docker would not remove a network of the project that containers are still on. Its
# file asks for the network otherwise than it was made, in a way Docker does not show, as a network made with no
# subnets named, which Docker shows with the subnet it gave.
endpoints_refused() { grep -q 'has active endpoints' "$1" 2> /dev/null && live_networks; }

# new_networks <log>: the settings name the subnets the networks have where they name none, so every address on them
# stays, and the project stops whole with its networks, the containers its file no longer names too, its data staying
# in its volumes. The built-in node hears first that it stops for an update, as when the installer stops it. The next
# up makes the networks again with those subnets. ADDED_SUBNETS names the settings it wrote.
ADDED_SUBNETS=''
new_networks() {
  local node
  if [ -n "$OLD_DEFAULT" ] && [ -z "$(env_value HORNHOOF_SUBNET)" ]; then
    PUT_VALUE=$OLD_DEFAULT put_env HORNHOOF_SUBNET || return 1
    ADDED_SUBNETS="$ADDED_SUBNETS HORNHOOF_SUBNET"
  fi
  if [ -n "$OLD_INTERNAL" ] && [ -z "$(env_value HORNHOOF_INTERNAL_SUBNET)" ]; then
    PUT_VALUE=$OLD_INTERNAL put_env HORNHOOF_INTERNAL_SUBNET || return 1
    ADDED_SUBNETS="$ADDED_SUBNETS HORNHOOF_INTERNAL_SUBNET"
  fi
  node=$(compose ps -q node 2> /dev/null || true)
  [ -z "$node" ] || docker exec "$node" node /app/apps/node/dist/main.js prepare-stop hornhoof_update > /dev/null 2>&1 || true
  compose down --remove-orphans >> "$1" 2>&1
}

# old_build_up <log>: the build from before starts whole again, with the compose file and the settings it had, on
# networks made as that file makes them, since its updater goes back with its own file. Only the subnets new_networks
# wrote leave the settings. That updater finds the way back marked and goes back by itself, with the database it had,
# which runs again with it.
old_build_up() {
  local ok=''
  WORK=$(mktemp -d)
  if unpack "$PREVIOUS" "$BACK_APP" && cp "$WORK/$PREVIOUS/compose.yaml" "$SERVER_DIR/compose.yaml"; then ok=1; fi
  rm -rf "$WORK"
  WORK=''
  [ -n "$ok" ] || return 1
  if [ -n "$ADDED_SUBNETS" ]; then
    # shellcheck disable=SC2086 # setting names, one word each
    drop_env $ADDED_SUBNETS || return 1
  fi
  compose down --remove-orphans >> "$1" 2>&1 || true
  HORNHOOF_APP_REF="$BACK_APP" HORNHOOF_NODE_REF="$BACK_NODE" HORNHOOF_UPDATER_REF="$BACK_UPDATER" compose up -d --no-build >> "$1" 2>&1
}

# compose_said <log>: why compose refused, for the update's log: its last lines, without the value of any key, secret,
# password or ticket the settings hold, each cut short.
compose_said() {
  local text line name value
  text=$(awk 'NF' "$1" | tail -n 3)
  while IFS= read -r line || [ -n "$line" ]; do
    name=${line%%=*}
    value=${line#*=}
    case "$name" in *KEY* | *SECRET* | *PASSWORD* | *TOKEN* | *TICKET*) ;; *) continue ;; esac
    [ "${#value}" -ge 8 ] || continue
    text=${text//"$value"/<hidden>}
  done < "$SERVER_DIR/.env"
  while IFS= read -r line; do
    [ -z "$line" ] || say "$(printf 'Compose said: %s' "$line" | cut -c1-240)"
  done <<< "$text"
}

# The helper container this build's installer starts when an older updater runs it. Compose replaces that updater, and
# the installer waiting in it, with this build's, which finds the update by the older one's note. If it does not say so
# in time, the older updater starts again, finds step rollback and goes back, by itself. On networks other than the
# compose file asks for, as Docker shows them or as compose says when it refuses, the project stops first and its
# networks are made again, once, and then the way back brings the build from before up whole, as nothing of it runs any
# more.
take_over() {
  local said fresh=''
  update_running || return 0
  read_status
  { [ "$STEP" = install ] && recall; } || return 0
  said=$(mktemp)
  if old_networks; then
    fresh=1
  elif compose up -d --no-build --wait updater > "$said" 2>&1 && taken_over; then
    rm -f "$said"
    return 0
  elif endpoints_refused "$said"; then
    compose_said "$said"
    fresh=1
  fi
  if [ -n "$fresh" ]; then
    say "The networks of this server are made again with the subnets they have, so Hornhoof stops for a moment."
    write_status running install
    : > "$said"
    if new_networks "$said" && compose up -d --no-build --wait db updater >> "$said" 2>&1 && taken_over; then
      rm -f "$said"
      return 0
    fi
  fi
  say "This build's updater did not start, so the build from before goes back."
  compose_said "$said"
  write_status running rollback
  : > "$said"
  if [ -n "$fresh" ]; then
    if old_build_up "$said"; then
      rm -f "$said"
      return 0
    fi
    compose_said "$said"
    rm -f "$said"
    stop_with failed "No updater could start, and the build from before did not start again either, so Hornhoof is stopped. Run install.sh server in $SERVER_DIR." finished
    return 0
  fi
  if HORNHOOF_UPDATER_REF="$BACK_UPDATER" compose up -d --no-build updater > "$said" 2>&1; then
    rm -f "$said"
    return 0
  fi
  compose_said "$said"
  rm -f "$said"
  stop_with failed "No updater could start. Hornhoof still runs the build from before; run install.sh server in $SERVER_DIR." finished
}
