# shellcheck shell=bash
# An update, and its way back. The app writes request.json {id, version, tag, digest, nodeDigest, updaterDigest} into the
# control folder; this writes status.json {id, version, state, step, log, at} and touches alive. An update downloads the
# build by the digest the app read for it, and every image that build's compose file names, the node and updater images
# by their digests too, while the old server keeps working. Only then it stops the app, so every change the app confirmed
# is in the copy, saves the database, and runs that build's own installer, which starts exactly these images, and waits
# for the new server to answer with the build's commit, at front when the build has it. If it does not, or the installer
# fails, the images that ran before go back, and the database goes back to the saved copy first when the new build added
# migrations to it, since the old build does not know them, with the public link's settings kept next to the copy. Before
# each install, containers of services the build's compose file does not name go, so a build from before front can take
# the web port again; after it, compose removes what is left of them. An updater stopped during an update goes on with it
# when it starts again.
#
# With HORNHOOF_ROLE=worker it runs on a machine that keeps none of the company's data. There the keeper writes
# request.json for the build the company server runs. This downloads it, says so with the step wait, and installs once
# the keeper passes on the server's word in go.json {id, commit, until} on the keeper-only computer volume: the
# request's id, its tag, and the second the word ends. It takes no copy of a database and puts none back.

# How long, in seconds, the server's keeper has to say that the copies promised to wait, that they hold every change
# the database is saved with, and that their slots went before a database is put back.
PROMISE_WAIT="${HORNHOOF_PROMISE_WAIT:-30}"
SETTLE_WAIT="${HORNHOOF_SETTLE_WAIT:-120}"
DROP_WAIT="${HORNHOOF_DROP_WAIT:-60}"
# How long a worker waits for its turn, in seconds: a day.
TURN_WAIT="${HORNHOOF_TURN_WAIT:-86400}"

# The commit an app image was made from, from its label; empty for a build made by hand.
commit_of() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2> /dev/null || true; }

# The digests Docker keeps for the image the service runs now.
service_digests() {
  local id
  id=$(docker inspect --format '{{.Image}}' "$(compose ps -q "$1" 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$id" ] || return 0
  docker image inspect --format '{{join .RepoDigests " "}}' "$id" 2> /dev/null || true
}

# running <service> <repository>: the image the service runs now, by the digest Docker keeps for it in that
# repository; empty when it keeps none, as for a build made on this computer.
running() {
  local ref
  for ref in $(service_digests "$1"); do
    if own "$2" "$ref"; then
      printf '%s' "$ref"
      return 0
    fi
  done
}

# Whether the built-in node runs the exact node image of the update already.
same_node() {
  [ -n "$NODE_DIGEST" ] || return 1
  case " $(service_digests node) " in *" $NODE_IMAGE@$NODE_DIGEST "*) return 0 ;; esac
  return 1
}

# unpack <tag> <image>: the installer and the compose file that come inside that build of the app image, in
# WORK/<tag>.
unpack() {
  local dir="$WORK/$1" cid
  mkdir -p "$dir"
  cid=$(docker create "$2") || return 1
  if ! docker cp "$cid:/app/scripts/install.sh" "$dir/install.sh" > /dev/null || ! docker cp "$cid:/app/compose.yaml" "$dir/compose.yaml" > /dev/null; then
    docker rm "$cid" > /dev/null 2>&1 || true
    return 1
  fi
  # A machine that joined also needs the overlay that names what it does not run.
  if joined && ! docker cp "$cid:/app/compose.worker.yaml" "$dir/compose.worker.yaml" > /dev/null; then
    docker rm "$cid" > /dev/null 2>&1 || true
    return 1
  fi
  # A company server counts the migrations the build brings by its journal; a build without one is no failure.
  worker || docker cp "$cid:/app/apps/server/drizzle/meta/_journal.json" "$dir/journal.json" > /dev/null 2>&1 || true
  docker rm "$cid" > /dev/null 2>&1 || true
}

# migrations_to_run <journal> <applied>: how many migrations of the new build the database has not applied; nothing
# when either count cannot be told, or the database has more than the build knows.
migrations_to_run() {
  local known
  known=$(jq -r '.entries | length' "$1" 2> /dev/null || true)
  plain_number "$known" && plain_number "$2" || return 0
  [ "$known" -lt "$2" ] || printf '%s' "$((known - $2))"
}

# keeper_said <file> <field>: a field of the answer the server's keeper left for this very update; fails while there
# is none of this update.
keeper_said() {
  local said
  said=$(take "$CONTROL/$1" || true)
  [ "$(jq -r '.id // empty' <<< "$said" 2> /dev/null || true)" = "$ID" ] || return 1
  jq -r ".$2 // empty" <<< "$said" 2> /dev/null || true
}

# The machines that keep a copy of the company promise to wait for the update: the server's keeper asks them, and says
# here whether each did. With none promised, or no word of the keeper's, the update ends before anything changed.
promise_copies() {
  local waited=0 ok why
  step promise "Asking the copies to wait for the update."
  while [ "$waited" -lt "$PROMISE_WAIT" ]; do
    if ok=$(keeper_said promised.json ok); then
      [ "$ok" != true ] || return 0
      why=$(keeper_said promised.json why || true)
      stop_with failed "${why:-A machine that keeps a copy did not promise to wait}, so nothing changed."
      return 1
    fi
    waited=$((waited + 1))
    sleep 1
  done
  stop_with failed "The keeper did not answer, so nothing changed."
  return 1
}

# The database is saved only once the keeper said the copies hold every change it is saved with. The step is backup by
# now, so the keeper holds the lease in maintenance and the app's sessions have ended.
settle_wait() {
  local waited=0 ok
  while [ "$waited" -lt "$SETTLE_WAIT" ]; do
    if ok=$(keeper_said settled.json ok); then
      [ "$ok" != true ] || return 0
      break
    fi
    waited=$((waited + 1))
    sleep 1
  done
  stop_with failed "The copies did not confirm the last changes, so nothing changed."
  return 1
}

# Before the saved database is put back, nothing of a copy may hold the one in use: the keeper stops the copies and
# drops their slots, and says so. With or without its word, the updater ends whatever still reads a slot and drops
# every slot itself, again every two seconds, until none is left. Fails when one will not go.
drop_slots() {
  local db waited=0 left
  while [ "$waited" -lt "$DROP_WAIT" ] && ! keeper_said slots-dropped.json ok > /dev/null; do
    waited=$((waited + 1))
    sleep 1
  done
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] || return 1
  waited=0
  while true; do
    left=$(docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM pg_replication_slots' 2> /dev/null | tr -d ' ') || left=''
    [ "$left" != 0 ] || return 0
    [ "$waited" -lt "$DROP_WAIT" ] || return 1
    docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE active_pid IS NOT NULL' > /dev/null 2>&1 || true
    docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE active_pid IS NULL' > /dev/null 2>&1 || true
    waited=$((waited + 2))
    sleep 2
  done
}

# Every image the compose file of the new build names, the update's own by digest, with the server's .env filling in
# the rest. When the node runs that exact image already, compose leaves the node image out.
pull_images() {
  local services=''
  if same_node; then
    services=$(services_without_node "$WORK/$TAG/compose.yaml")
    [ -n "$services" ] || return 1
  fi
  compose_files "$WORK/$TAG/compose.yaml"
  # shellcheck disable=SC2086 # services is a space-separated list of compose service names, or empty for all of them.
  HORNHOOF_VERSION="$TAG" HORNHOOF_APP_REF="$IMAGE@$DIGEST" HORNHOOF_NODE_REF="$(pinned "$NODE_IMAGE" "$NODE_DIGEST")" \
    HORNHOOF_UPDATER_REF="$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")" \
    docker compose --project-directory "$SERVER_DIR" "${FILES[@]}" pull $services >> "$WORK/install.log" 2>&1 || return 1
  # The nodes of a machine that joined are no service of its compose file unless it keeps the data, so their image
  # comes by itself, for the installer to start.
  if joined && [ -n "$NODE_DIGEST" ]; then docker pull "$NODE_IMAGE@$NODE_DIGEST" >> "$WORK/install.log" 2>&1 || return 1; fi
}

# The containers of this server, one per line: id and service. .env names the compose project; a server set up before
# it did goes by the name this updater's compose file gave it.
project_containers() {
  local project
  project=$(env_value COMPOSE_PROJECT_NAME)
  docker ps -a --filter "label=com.docker.compose.project=${project:-${COMPOSE_PROJECT_NAME:-hornhoof}}" \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}' 2> /dev/null || true
}

# A compose run cut short, as one whose command on the computer was stopped halfway, leaves containers it made and never
# started, and the machine stands without them: a node finds no front, and nothing would start them. Those of this
# server's own project start again as compose made them, each said, once the same ones stood so for UNSTARTED_AFTER
# seconds with no update and no command under way, so a compose run that is still going finishes first. None of a service
# that runs is started beside it, nothing is made again, and the updater's own is left to its swap. Migrations, and on
# the machine whose database the company writes the app that needs them, start only by an update, which saves the
# database first. A container made on purpose and left unstarted, as by compose create, starts too: no step of this
# stack makes one. The first time each set was seen stays in the control folder, so a restart of the updater keeps it;
# that folder is shared with the app and the keeper, so the note is read with take and written with publish, which
# never follow a link at its name.
UNSTARTED_AFTER=300
start_unstarted() {
  local seen="$CONTROL/unstarted" project states running services='' service now noted since role left=' updater migrate '
  [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ] || return 0
  if update_running || [ -f "$SERVER_DIR/backups/update.json" ] || computer_busy; then
    rm -f "$seen"
    return 0
  fi
  [ "$(path_kind)" != lead ] || left=' updater migrate app '
  project=$(compose_project)
  states=$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}} {{.State}}' 2> /dev/null) || return 0
  running=" $(printf '%s\n' "$states" | awk '$2 == "running" { print $1 }' | tr '\n' ' ') "
  for service in $(printf '%s\n' "$states" | awk '$2 == "created" { print $1 }' | sort -u); do
    [[ "$service" =~ ^[a-z][a-z0-9_-]{0,62}$ ]] || continue
    case "$left$running" in *" $service "*) continue ;; esac
    services="$services $service"
  done
  services=${services# }
  if [ -z "$services" ]; then
    rm -f "$seen"
    return 0
  fi
  now=$(date +%s)
  noted=$(take "$seen" || true)
  since=${noted%% *}
  if [ "${noted#* }" != "$services" ] || ! [[ "$since" =~ ^[0-9]+$ ]]; then
    publish "$seen" over printf '%s %s\n' "$now" "$services" || true
    return 0
  fi
  [ "$((now - since))" -ge "$UNSTARTED_AFTER" ] || return 0
  for service in $services; do say "Starting $service, whose container was made and never started."; done
  # Under the role the settings name: this updater's own environment holds the one it was started with.
  role=$(env_value HORNHOOF_ROLE)
  # shellcheck disable=SC2086 # services is a space-separated list of plain service names.
  if HORNHOOF_ROLE="${role:-$ROLE}" compose up -d --no-build --no-deps --no-recreate $services > /dev/null 2>&1; then
    rm -f "$seen"
  else
    say "Could not start $services."
    publish "$seen" over printf '%s %s\n' "$now" "$services" || true
  fi
}

# remove_unnamed <compose file>: containers of services that file does not name go before its installer runs, since a
# build from before front could not take the web port while front holds it, and drop_orphans comes only after an
# install that worked. A file without the updater would take this updater for one of them, so then nothing goes.
remove_unnamed() {
  local named id service
  named=" $(services_of "$1" | tr '\n' ' ') "
  case "$named" in *' updater '*) ;; *) return 0 ;; esac
  while read -r id service; do
    [ -n "$service" ] || continue
    case "$named" in *" $service "*) continue ;; esac
    docker rm -f "$id" > /dev/null 2>&1 || say "Could not remove the container of $service, a service this build does not name."
  done <<< "$(project_containers)"
}

# run_installer <tag> <app> <node> <updater>: the installer of that build. It takes as long as it takes: no clock ends it.
run_installer() {
  local tag=$1 dir="$WORK/$1"
  installer_control "$WORK/control" || true
  HORNHOOF_CONTROL_DIR="$WORK/control" HORNHOOF_SERVER_DIR="$SERVER_DIR" HORNHOOF_VERSION="$tag" HORNHOOF_FROM_UPDATER=1 HORNHOOF_UPDATER_REV="$UPDATER_REV" HORNHOOF_COMPOSE_FILE="$dir/compose.yaml" HORNHOOF_PULLED=1 \
    HORNHOOF_APP_REF="$2" HORNHOOF_NODE_REF="$3" HORNHOOF_UPDATER_REF="$4" HORNHOOF_NODES_FREE="$NODES_FREE" HORNHOOF_NODES_ONLY="$NODES_ONLY" bash "$dir/install.sh" "$(install_mode)" >> "$WORK/install.log" 2>&1
}

# What the installer is run as: a server's, or that of a machine that joined.
install_mode() { shape; }

# install <tag> <app> <node> <updater>: runs the installer and the compose file that come inside that app image, and
# they start exactly these images. They are on this computer already: the new build's came before the database was
# saved, and the build from before ran here. Compose downloads only an image that is missing.
install() {
  unpack "$1" "$2" || return 1
  keep_networks "$WORK/$1/compose.yaml" || return 1
  remove_unnamed "$WORK/$1/compose.yaml"
  if worker; then after_nodes_look; fi
  run_installer "$@" || return 1
  drop_orphans
}

# keep_networks <compose file>: a build from before compose files named the networks' subnets would make the networks
# again, as compose takes those made with subnets for changed, and it cannot while this updater is on them. Its file
# takes the networks as the one in the server folder names them, which that build runs on as on its own.
keep_networks() {
  local now="$SERVER_DIR/compose.yaml"
  grep -q 'HORNHOOF_SUBNET' "$now" 2> /dev/null || return 0
  ! grep -q 'HORNHOOF_SUBNET' "$1" || return 0
  awk '
    FNR == 1 { file++ }
    /^[^[:space:]]/ { inside = /^networks:/ }
    file == 1 { if (inside) kept = kept $0 "\n"; next }
    !inside { print }
    END { printf "%s", kept }' "$now" "$1" > "$1.new" && mv "$1.new" "$1"
}

# The installer of a build starts only the services it knows, so after going back to a build from before a service,
# as the tunnel, that service's container would run on, carrying the public link to a server that knows nothing of
# it. compose removes the containers of services its file does not name; db runs already, so nothing else changes. A
# file without the updater would take this updater for one of them, so then nothing goes.
drop_orphans() {
  local runs=db
  # A worker has no db: its keeper runs already, and naming it starts nothing else.
  if worker; then runs=keeper; fi
  if names_service "$SERVER_DIR/compose.yaml" updater; then
    compose up -d --no-build --remove-orphans "$runs" >> "$WORK/install.log" 2>&1 || say "Could not remove the containers that $SERVER_DIR/compose.yaml no longer names."
  fi
}

update() {
  local tag=$1 digest=$2 node=$3 updater=$4
  LOG=''
  if ! plain_tag "$tag"; then
    if [ "${#tag}" -le 128 ]; then
      stop_with failed "$tag is not a version this updater can install." finished
    else
      stop_with failed "The version is too long." finished
    fi
    return 0
  fi
  { plain_digest "$digest" && digest_or_none "$node" && digest_or_none "$updater"; } || {
    stop_with failed "The request does not name the exact build to install, so nothing changed." finished
    return 0
  }
  if [ -z "$SERVER_DIR" ] || [ ! -f "$SERVER_DIR/.env" ]; then
    stop_with failed "This Hornhoof was not set up with install.sh server, so it updates by running that command again." finished
    return 0
  fi
  read_kind
  TAG=$tag
  DIGEST=$digest
  NODE_DIGEST=$node
  UPDATER_DIGEST=$updater
  TARGET=''
  BEFORE=''
  BACKUP=''
  MIGRATIONS=''
  RESTORE=''
  SAYS_MIGRATIONS=''

  # The build to go back to: the one running now, by its commit, or the one .env pins; and the images it runs, by the
  # digests Docker keeps for them, or by that build's tag.
  PREVIOUS=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(compose ps -q "$(main_service)" 2> /dev/null || true)" 2> /dev/null || true)
  [ -n "$PREVIOUS" ] || PREVIOUS=$(env_value HORNHOOF_VERSION)
  [ -n "$PREVIOUS" ] || PREVIOUS=latest
  BACK_APP=$(running "$(main_service)" "$IMAGE")
  [ -n "$BACK_APP" ] || BACK_APP="$IMAGE:$PREVIOUS"
  BACK_NODE=$(running node "$NODE_IMAGE")
  [ -n "$BACK_NODE" ] || BACK_NODE="$NODE_IMAGE:$PREVIOUS"
  BACK_UPDATER=$(running updater "$UPDATER_IMAGE")
  [ -n "$BACK_UPDATER" ] || BACK_UPDATER="$UPDATER_IMAGE:$PREVIOUS"
  note

  step pull "Downloading $VERSION."
  docker pull "$IMAGE@$DIGEST" > /dev/null || {
    stop_with failed "Could not download $IMAGE:$TAG, so nothing changed."
    return 0
  }
  # Downloads take minutes and the old server works on meanwhile, so they come before the copy of the database: going
  # back to the copy then loses only what the old server did in the moment before the new build starts.
  { unpack "$TAG" "$IMAGE@$DIGEST" && pull_images; } || {
    stop_with failed "Could not download the images of $VERSION, so nothing changed."
    return 0
  }
  TARGET=$(commit_of "$IMAGE@$DIGEST")
  note

  if worker; then
    wait_turn || return 0
    step install "Installing $VERSION."
    install_new
    return 0
  fi
  BEFORE=$(applied)
  MIGRATIONS=$(migrations_to_run "$WORK/$TAG/journal.json" "$BEFORE")
  SAYS_MIGRATIONS=1
  promise_copies || return 0
  save_and_install
}

# The database is saved, once the copies hold every change it is saved with, and the new build goes in.
save_and_install() {
  step backup "Saving the database."
  settle_wait || return 0
  backup || {
    stop_with failed "Could not save the database, so nothing changed."
    return 0
  }
  note
  step install "Installing $VERSION."
  install_new
}

# Whether the keeper passed on the company server's word for this very request, and the word still stands.
told_to_go() {
  local word id commit until
  word=$(take_alone "$COMPUTER_CONTROL/go.json" || true)
  id=$(jq -r '.id // empty' <<< "$word" 2> /dev/null || true)
  commit=$(jq -r '.commit // empty' <<< "$word" 2> /dev/null || true)
  until=$(jq -r '.until // 0 | floor' <<< "$word" 2> /dev/null || true)
  case "$until" in '' | *[!0-9]*) return 1 ;; esac
  [ "$id" = "$ID" ] && [ "$commit" = "$TAG" ] && [ "$until" -gt "$(date +%s)" ]
}

# A worker installs only in its turn, so the company's machines go one at a time and none while a turn runs on it. The
# build is here already. A word left from before this wait is for another request and goes first. The wait ends with
# the word, with a newer request, which the next pass takes, or after a day.
wait_turn() {
  local waited=0
  remove_in "$COMPUTER_CONTROL" go.json
  step wait "Waiting for its turn to install."
  while true; do
    if told_to_go; then return 0; fi
    if [ "$(take "$CONTROL/request.json" quiet jq -r '.id // empty' || true)" != "$ID" ]; then
      stop_with failed "A newer build came first, so this one was left." finished
      return 1
    fi
    if [ "$waited" -ge "$TURN_WAIT" ]; then
      stop_with failed "The company server did not give this machine its turn within a day." finished
      return 1
    fi
    waited=$((waited + 2))
    sleep 2
  done
}

# The new build goes in and has to answer; otherwise the build from before goes back.
install_new() {
  if install "$TAG" "$IMAGE@$DIGEST" "$(pinned "$NODE_IMAGE" "$NODE_DIGEST")" "$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")"; then
    check_new
  else
    say "The installer of $VERSION failed: $(tail -n 3 "$WORK/install.log" 2> /dev/null | tr '\n' ' ')"
    go_back
  fi
}

manual_subnet_heal_command() {
  local project=$1 base suffix
  if joined; then
    printf 'the Hornhoof install command (or HORNHOOF_SERVER_DIR=%s install.sh worker)' "$SERVER_DIR"
    return 0
  fi
  case "$project" in
    hornhoof-?*)
      suffix=${project#hornhoof-}
      base=$(basename "$SERVER_DIR")
      if [ "$base" = "hornhoof-$suffix" ]; then
        printf 'install.sh server --name %s in %s' "$suffix" "$SERVER_DIR"
        return 0
      fi
      ;;
  esac
  printf 'install.sh server in %s' "$SERVER_DIR"
}

warn_subnet_overlap() {
  local relayed addrs ids nets project hits sub host cmd
  if [ -n "$WORK" ] && [ -f "$WORK/install.log" ]; then
    relayed=$(grep "^Docker network .* overlaps this computer's network" "$WORK/install.log" 2> /dev/null || true)
    if [ -n "$relayed" ]; then
      while IFS= read -r sub; do
        [ -n "$sub" ] && say "$sub"
      done <<< "$relayed"
      return 0
    fi
  fi
  [ -n "$SERVER_DIR" ] || return 0
  addrs=$(
    {
      env_value HORNHOOF_ADDRESSES | tr ',' '\n'
      take "$CONTROL/addresses.json" quiet jq -r '.addresses[]? // empty' || true
    } | awk 'NF'
  )
  [ -n "$addrs" ] || return 0
  ids=$(docker network ls -q 2> /dev/null || true)
  [ -n "$ids" ] || return 0
  project=$(compose_project)
  [ -n "$project" ] || return 0
  # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per network
  nets=$(docker network inspect --format "$NETWORK_FORMAT" $ids 2> /dev/null || true)
  [ -n "$nets" ] || return 0
  hits=$(
    {
      printf '%s\n' "$addrs"
      printf -- '---\n'
      printf '%s\n' "$nets"
    } | awk -v project="$project" '
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
      $0 == "---" { net_mode = 1; next }
      !net_mode {
        for (k = 1; k <= NF; k++) {
          if (parse_range($k)) {
            h_tok[++nh] = $k
            h_start[nh] = R_START
            h_end[nh] = R_END
          }
        }
        next
      }
      net_mode && NF {
        split($0, f, "|")
        if (f[3] != project && f[2] != (project "_default") && f[2] != (project "_internal")) next
        n = split(f[6], items, ";")
        for (i = 1; i <= n; i++) {
          if (items[i] == "") continue
          split(items[i], sg, ",")
          cidr = sg[1]
          if (cidr == "" || seen[cidr]++ || !parse_range(cidr)) continue
          s = R_START; e = R_END
          for (j = 1; j <= nh; j++) {
            if (s <= h_end[j] && h_start[j] <= e) {
              print cidr " " h_tok[j]
              break
            }
          }
        }
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

check_new() {
  step health "Waiting for the new server to answer."
  if healthy "$TARGET"; then
    warn_subnet_overlap
    keep_backups
    stop_with "done" "Hornhoof runs $VERSION now." finished
    swap_updater "$(pinned "$UPDATER_IMAGE" "$UPDATER_DIGEST")"
    return 0
  fi
  say "$VERSION did not answer within $HEALTH_WAIT seconds."
  go_back
}

go_back() {
  local back="Hornhoof runs the build from before the update again. The database was saved before it."
  # A worker has no database to put back.
  if worker; then back="This machine runs the build from before the update again."; fi
  step rollback "Going back to $PREVIOUS."
  if ! worker && [ "$(applied)" != "$BEFORE" ]; then
    say "$VERSION changed the database, so it goes back to the copy saved before the update."
    RESTORE=1
    SAYS_MIGRATIONS=1
    write_status running rollback
    drop_slots || {
      stop_with failed "Could not drop the copies' slots, so the database was not put back. Run install.sh server in $SERVER_DIR, and see docker compose logs keeper." finished
      return 0
    }
    keep_link
    restore || {
      stop_with failed "Could not put the database back from backups/$(basename "$BACKUP"). Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
      return 0
    }
    back="Hornhoof runs the build from before the update again, with the database as it was saved before the update."
  fi
  if install "$PREVIOUS" "$BACK_APP" "$BACK_NODE" "$BACK_UPDATER" && healthy "$(commit_of "$BACK_APP")"; then
    keep_backups
    stop_with rolled_back "$back" finished
  else
    stop_with failed "Could not go back to $PREVIOUS either. Run install.sh server in $SERVER_DIR, and see docker compose logs app." finished
  fi
}

handle_request() {
  local request id tag digest node updater done_id
  request=$(take "$CONTROL/request.json") || return 0
  id=$(jq -r '.id // empty' <<< "$request" 2> /dev/null || true)
  case "$id" in '' | *[!A-Za-z0-9-]*) return 0 ;; esac
  done_id=$(take "$CONTROL/status.json" quiet jq -r '.id // empty' || true)
  [ "$id" != "$done_id" ] || return 0
  ID=$id
  VERSION=$(jq -r '.version // empty' <<< "$request" | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
  tag=$(jq -r '.tag // empty' <<< "$request")
  digest=$(jq -r '.digest // empty' <<< "$request")
  node=$(jq -r '.nodeDigest // empty' <<< "$request")
  updater=$(jq -r '.updaterDigest // empty' <<< "$request")
  NODES_FREE=$(jq -r 'if .immediate == true or .urgent == true then "1" else "" end' <<< "$request")
  WORK=$(mktemp -d)
  update "$tag" "$digest" "$node" "$updater"
  rm -rf "$WORK"
  WORK=''
  NODES_FREE=''
  forget_kind
}

# Whether this build's installer handed the update over: an older updater got as far as its copy of the database, which
# it notes only after it took it. This updater may have been stopped during the second copy since.
handed_over() {
  [ -z "$NOTE_REV" ] && [ -n "$BACKUP" ] && { [ "$STEP" = install ] || [ "$STEP" = backup ]; }
}

# The older updater took its copy while the app worked on, so unless the new build ran already it is taken again, with
# the app stopped. The line goes out at once, since the helper is waiting for it. This build's installer wrote .env and
# compose.yaml already, so from here a failure goes back.
go_on_handed_over() {
  step install "$TAKEN_OVER"
  if [ "$(applied)" = "$BEFORE" ]; then
    step backup "Saving the database again, now that the app is stopped."
    backup || {
      say "Could not save the database again."
      go_back
      return 0
    }
  fi
  note
  step install "Installing $VERSION."
  install_new
}

# The update goes on from the step it was at. Before the install nothing changed yet, so it starts over, with the app
# running again that the copy stopped, or a download that fails would say nothing changed with the company's app down.
go_on() {
  say "The updater stopped during the update and goes on with it."
  [ "$STEP" != backup ] || start_app "$(compose ps -aq app 2> /dev/null || true)"
  case "$STEP" in
    # Stopped at the dump of an update that asked the copies: no migration ran yet, and the keeper's word about the
    # dump stands, since the step never left backup. It goes on from there, with nothing downloaded or asked again.
    backup)
      if [ -n "$SAYS_MIGRATIONS" ]; then
        BEFORE=$(applied)
        save_and_install
      else
        update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST"
      fi
      ;;
    pull | promise | wait) update "$TAG" "$DIGEST" "$NODE_DIGEST" "$UPDATER_DIGEST" ;;
    install)
      step install "Installing $VERSION."
      install_new
      ;;
    health) check_new ;;
    *) go_back ;;
  esac
}

# An update this updater was stopped in, or was handed by an older one, goes on by the note of it. A restore it was
# stopped in goes first.
interrupted() {
  if ! worker && [ -n "$SERVER_DIR" ] && [ -f "$SERVER_DIR/.env" ]; then restore_left || true; fi
  update_running || return 0
  read_status
  if ! recall; then
    forget_kind
    stop_with failed "The updater stopped during the update. Check that Hornhoof answers, then try again."
    return 0
  fi
  WORK=$(mktemp -d)
  if handed_over; then go_on_handed_over; else go_on; fi
  rm -rf "$WORK"
  WORK=''
  NODES_FREE=''
  forget_kind
}
