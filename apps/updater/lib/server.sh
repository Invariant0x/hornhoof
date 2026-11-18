# shellcheck shell=bash
# The server this updater works for, as every part of it reads it: its folder, its compose project and the services its
# compose file names, the settings in its .env, Hornhoof's images by tag and digest, the build that answers there, and
# its database.

# How long, in seconds, the build that runs has to answer, and the database to say how many migrations it has.
HEALTH_WAIT="${HORNHOOF_HEALTH_WAIT:-120}"
# A Docker network as docker network inspect gives it: id|name|project|bridge|internal|subnet,gateway;...
NETWORK_FORMAT='{{.Id}}|{{.Name}}|{{with .Labels}}{{with index . "com.docker.compose.project"}}{{.}}{{end}}{{end}}|{{with .Options}}{{with index . "com.docker.network.bridge.name"}}{{.}}{{end}}{{end}}|{{.Internal}}|{{range .IPAM.Config}}{{with index . "Subnet"}}{{.}}{{end}},{{with index . "Gateway"}}{{.}}{{end}};{{end}}'
# The db container psql_on works in, which a restore and a load find first.
DBC=''

compose() { (cd "$SERVER_DIR" && docker compose "$@"); }

env_value() { grep "^$1=" "$SERVER_DIR/.env" 2> /dev/null | tail -1 | cut -d= -f2- || true; }

# The compose project of the server: the one its settings name, else the one compose takes from the folder's name.
compose_project() {
  local project
  project=$(env_value COMPOSE_PROJECT_NAME)
  [ -n "$project" ] || project=$(basename "$SERVER_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  printf '%s' "$project"
}

plain_tag() {
  case "$1" in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

# sha256: and 64 hex digits, the way a registry names one exact build.
plain_digest() {
  case "$1" in sha256:*) ;; *) return 1 ;; esac
  case "${1#sha256:}" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 71 ]
}

digest_or_none() { [ -z "$1" ] || plain_digest "$1"; }

# An id another program gave, which goes into the names of files here.
plain_id() {
  case "$1" in '' | *[!A-Za-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

# by_digest <repository> <image>: the image is one of that repository's, by its digest alone.
by_digest() { case "$2" in "$1"@*) plain_digest "${2#"$1"@}" ;; *) return 1 ;; esac; }

# own <repository> <image>: the image is one of that repository's, by a plain tag or by a digest.
own() {
  case "$2" in
    "$1"@*) plain_digest "${2#"$1"@}" ;;
    "$1":*) plain_tag "${2#"$1":}" ;;
    *) return 1 ;;
  esac
}

# pinned <repository> <digest>: an image of the update by its digest, by the update's tag when it has none.
pinned() { if [ -n "$2" ]; then printf '%s@%s' "$1" "$2"; else printf '%s:%s' "$1" "$TAG"; fi; }

# compose_files <compose file>: FILES is what names that build to compose: its file, and on a machine that joined the
# overlay beside it, which leaves the services that keep data out where no profile turns them on.
compose_files() {
  FILES=(-f "$1")
  if joined && [ -f "${1%compose.yaml}compose.worker.yaml" ]; then FILES+=(-f "${1%compose.yaml}compose.worker.yaml"); fi
}

# The services a compose file names, one per line; none when compose cannot read it.
services_of() {
  compose_files "$1"
  docker compose --project-directory "$SERVER_DIR" "${FILES[@]}" config --services 2> /dev/null || true
}

# names_service <compose file> <service>
names_service() {
  case " $(services_of "$1" | tr '\n' ' ') " in *" $2 "*) return 0 ;; esac
  return 1
}

services_without_node() {
  local s list=''
  for s in $(services_of "$1"); do
    [ "$s" = node ] || list="$list $s"
  done
  printf '%s' "${list# }"
}

# The container of the app starts again; it may be gone by now, and then nothing does.
start_app() { [ -z "$1" ] || docker start "$1" > /dev/null 2>&1 || true; }

# How many migrations the database has now; fails when it does not answer.
migrations() {
  local db n
  db=$(compose ps -q db 2> /dev/null || true)
  [ -n "$db" ] && n=$(docker exec "$db" psql -U hornhoof -d hornhoof -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2> /dev/null) && [ -n "$n" ] && printf '%s' "$n" | tr -d ' '
}

# How many migrations the database has, once it answers; empty when it does not within HEALTH_WAIT seconds, as after
# the computer started again.
applied() {
  local i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    if migrations; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
}

# owned <path> <mode>: what this wrote as root becomes the keeper's alone to read and remove. The keeper runs as the
# owner of the control folder.
owned() {
  local owner
  # shellcheck disable=SC2012 # the owner and the group as numbers, which BusyBox and macOS print alike
  owner=$(ls -nd "$CONTROL" | awk '{ print $3 ":" $4 }')
  chmod "$2" "$1" && chown "$owner" "$1"
}

# Where the build that runs now answers. On a machine that does not lead, its keeper says so: its front door leads to
# another machine's app. On the one that leads, the app does, at front when the compose file its installer copied here
# names it; the address a joined machine's settings name is its keeper's, from the time it did not lead.
health_url() {
  if worker; then
    printf '%s' "${HORNHOOF_HEALTH_URL:-http://keeper:7080/api/keeper}"
  elif [ -n "${HORNHOOF_HEALTH_URL:-}" ] && ! joined; then
    printf '%s' "$HORNHOOF_HEALTH_URL"
  elif names_service "$SERVER_DIR/compose.yaml" front; then
    printf 'http://front:8080/api/health'
  else
    printf 'http://app:8080/api/health'
  fi
}

# healthy <commit>: the server answers with that commit within HEALTH_WAIT seconds; any answer for a build made by hand.
healthy() {
  local want=$1 body got i=0
  while [ "$i" -lt "$HEALTH_WAIT" ]; do
    if body=$(curl -fsS --max-time 5 "$(health_url)" 2> /dev/null); then
      got=$(printf '%s' "$body" | jq -r '.commit // empty' 2> /dev/null || true)
      if [ -z "$want" ] || [ "$got" = "$want" ]; then return 0; fi
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# The image of the container this updater runs in, which Docker names after the container's host name; else the one
# the settings name for it; nothing when neither is known.
own_image() {
  local image
  image=$(docker inspect --format '{{.Config.Image}}' "$(hostname)" 2> /dev/null || true)
  [ -n "$image" ] || image=$(env_value HORNHOOF_UPDATER_REF)
  printf '%s' "$image"
}

# swap_updater <image>: a new updater takes over from a helper container that outlives this one. Both run that image:
# the updater image of an update, which .env names for compose too, or this updater's own when only its settings changed.
swap_updater() {
  local image=$1
  [ -n "$image" ] || return 0
  docker image inspect "$image" > /dev/null 2>&1 || docker pull "$image" > /dev/null 2>&1 || return 0
  docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$SERVER_DIR:$SERVER_DIR" -w "$SERVER_DIR" \
    --entrypoint docker "$image" compose up -d --no-build updater > /dev/null 2>&1 || true
}

# psql_on <database> <arguments>: psql in the db container, which stops at the first statement that fails.
psql_on() {
  local name=$1
  shift
  docker exec "$DBC" psql -U hornhoof -d "$name" -v ON_ERROR_STOP=1 -q "$@"
}

# psql_alone <database> <psql arguments>: the same for what a restore does from the moment it closes the database in
# use. The copy commits wait for loses its connection there with every other session, and no copy follows these
# statements, so each is committed here alone: left to wait for that copy, the restore would stand still for good.
psql_alone() {
  local name=$1
  shift
  psql_on "$name" -c 'SET synchronous_commit = local' "$@"
}

# The databases of Hornhoof there are now, as words; fails when the database server does not say.
db_names() { psql_on postgres -tAc "SELECT COALESCE(string_agg(datname, ' '), '') FROM pg_database WHERE datname LIKE 'hornhoof%'" 2> /dev/null; }

plain_number() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }

# setting <name> <file>: one of the three settings a backup carries, as the file has it; nothing when it has none. It
# fails for a value that cannot stand in .env as it is, so none with a control character, a space, a quote, # or $
# passes. The value never goes on a command line.
setting() {
  local value re
  value=$(jq -r --arg name "$1" '.[$name] // "" | if type == "string" then . else "?" end' "$2" 2> /dev/null && printf x) || return 1
  # What jq printed, less the line end it added: a value that ends with one of its own keeps it, and does not pass.
  value=${value%x}
  value=${value%$'\n'}
  [ -n "$value" ] || return 0
  case "$1" in
    HORNHOOF_SECRET) re='^[A-Za-z0-9+/]{43}=$' ;;
    NODE_KEY) re='^[A-Za-z0-9+/=_-]{32,200}$' ;;
    RELAY_URL) re='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' ;;
    *) return 1 ;;
  esac
  [[ "$value" =~ $re ]] || return 1
  printf '%s' "$value"
}

# as_env <file>: the file becomes the server's settings, with the owner the settings have and for that owner alone.
as_env() {
  local owner
  # shellcheck disable=SC2012 # the owner and the group as numbers, which BusyBox and macOS print alike
  owner=$(ls -n "$SERVER_DIR/.env" | awk '{ print $3 ":" $4 }')
  chown "$owner" "$1" && chmod 600 "$1" && mv "$1" "$SERVER_DIR/.env"
}

# write_env <secret> <node key> <relay>: .env with those over their lines, or added, and every other line as it was.
# An empty one leaves its line as it is.
write_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && NEW_SECRET="$1" NEW_NODE_KEY="$2" NEW_RELAY="$3" awk '
    BEGIN { new["HORNHOOF_SECRET"] = ENVIRON["NEW_SECRET"]; new["NODE_KEY"] = ENVIRON["NEW_NODE_KEY"]; new["RELAY_URL"] = ENVIRON["NEW_RELAY"] }
    {
      name = $0
      sub(/=.*/, "", name)
      if (index($0, "=") > 0 && (name in new) && new[name] != "") {
        if (!(name in put)) print name "=" new[name]
        put[name] = 1
        next
      }
      print
    }
    END {
      if (new["HORNHOOF_SECRET"] != "" && !("HORNHOOF_SECRET" in put)) print "HORNHOOF_SECRET=" new["HORNHOOF_SECRET"]
      if (new["NODE_KEY"] != "" && !("NODE_KEY" in put)) print "NODE_KEY=" new["NODE_KEY"]
      if (new["RELAY_URL"] != "" && !("RELAY_URL" in put)) print "RELAY_URL=" new["RELAY_URL"]
    }' "$file" > "$file.new") && as_env "$file.new"
}

# put_env <name>: .env with the line of that name saying PUT_VALUE, or with the line added, and every other line as it
# was. The value comes by the environment, so it stands on no command line.
put_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && PUT_NAME="$1" awk '
    BEGIN { name = ENVIRON["PUT_NAME"]; value = ENVIRON["PUT_VALUE"] }
    index($0, name "=") == 1 { if (!put) print name "=" value; put = 1; next }
    { print }
    END { if (!put) print name "=" value }' "$file" > "$file.new") && as_env "$file.new"
}

# drop_env <name>...: .env without the lines of those names, and every other line as it was.
drop_env() {
  local file="$SERVER_DIR/.env"
  (umask 077 && DROP_NAMES=" $* " awk '
    BEGIN { names = ENVIRON["DROP_NAMES"] }
    { name = $0; sub(/=.*/, "", name); if (index(names, " " name " ") == 0) print }' "$file" > "$file.new") && as_env "$file.new"
}

# A password for this machine's own database: 24 letters and digits.
new_password() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24; }

# A name of a database, and a count from 1, as a request of the keeper may hold them: nothing else goes on a command line.
plain_database() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
}
plain_count() {
  [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]]
}
