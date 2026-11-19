# shellcheck shell=bash
# The computer this updater runs on. It runs the orchestrator's commands on this computer, as root, while the machine's
# owner keeps access to it open. The keeper refreshes computer.json {untilSec} and writes each computer/<id>.json
# {id, command, timeout} on the volume it shares with the updater. The updater writes computer/<id>.out.json
# {id, exit, output} on that volume. With HORNHOOF_HOST_OS=linux it also reports the machine's own addresses.

# The image commands on the computer run in: the updater's own, which compose names.
COMPUTER_IMAGE="${HORNHOOF_COMPUTER_IMAGE:-$UPDATER_IMAGE:latest}"
COMPUTER_CONTROL="${HORNHOOF_COMPUTER_CONTROL_DIR:-/computer}"
# The longest a command on the computer runs, in seconds, and how many characters of its output go back.
COMPUTER_MAX=1800
COMPUTER_OUTPUT=30000
# linux: this reads the machine's own addresses, which only a container on the host's network sees, once a minute.
HOST_OS="${HORNHOOF_HOST_OS:-}"
ADDRESSES_EVERY=60
ADDRESSES_AT=0

# The directory the shell is really in, asked of the system. Bash sets PWD from the path it resolved before it entered,
# so a link swapped in between would go unseen there, and its own pwd -P reads that same path again.
physical_dir() {
  env pwd -P 2> /dev/null
}

# Check the physical path after entering the queue, then use relative paths in that directory.
enter_computer_queue() {
  local here
  cd -P -- "$1" 2> /dev/null || return 1
  here=$(physical_dir) || return 1
  [ ! -L ./computer ] && cd -P -- ./computer 2> /dev/null && [ "$(physical_dir)" = "${here%/}/computer" ]
}

# Clear the old queue at startup. Unlink queue entries without opening them or descending into directories.
computer_clear_legacy() (
  local file removed=0
  enter_computer_queue "$CONTROL" || return 0
  for file in ./*.json ./*.json.new ./*.started; do
    [ -L "$file" ] || [ -f "$file" ] || continue
    if rm -f -- "${file:?}" 2> /dev/null; then removed=$((removed + 1)); fi
  done
  if [ "$removed" -gt 0 ]; then printf 'Removed %s files from the old computer queue.\n' "$removed" >&2; fi
)

computer_heartbeat() {
  local marker="$COMPUTER_CONTROL/alive"
  [ ! -L "$marker" ] || return 0
  if [ -f "$marker" ]; then
    # -c: BusyBox touch -h would create a marker missing by now, through a link put there in the meantime.
    touch -c -h -- "$marker" 2> /dev/null || true
  elif [ ! -e "$marker" ]; then
    (set -o noclobber; : > "$marker") 2> /dev/null || true
  fi
}

# The updater trusts the leader keeper for standing access. A compromised leader keeper can still issue commands
# while the owner's standing access is open. The keeper's time also closes access if it stops refreshing it.
computer_open() {
  local until
  until=$(jq -r '.untilSec // 0' "$COMPUTER_CONTROL/computer.json" 2> /dev/null || true)
  case "$until" in '' | *[!0-9]*) return 1 ;; esac
  [ "$until" -gt "$(date +%s)" ]
}

# computer_answer <id> <exit code> <output file>: the end of the output, written whole and then moved. It fails when
# no answer is in place, as on a full volume, so the caller keeps the command's mark.
computer_answer() {
  local file="$1.out.json" temporary queue published=''
  [ ! -L "$file" ] && [ ! -e "$file" ] || return 0
  # Create the answer inside a private temporary directory on this volume, then publish the whole file.
  if queue=$(physical_dir) && temporary=$(mktemp -d .answer.XXXXXXXX 2> /dev/null); then
    (
      cd -P -- "./$temporary" && [ "$(physical_dir)" = "${queue%/}/$temporary" ] && [ -O . ] || exit 1
      trap 'rm -f -- ./answer' EXIT
      umask 022
      set -o noclobber
      tail -c "$COMPUTER_OUTPUT" "$3" | jq -Rs --arg id "$1" --argjson exit "$2" '{id: $id, exit: $exit, output: .}' > ./answer || exit 1
      [ ! -L "../$file" ] && [ ! -e "../$file" ] || exit 1
      if [[ "$OSTYPE" == darwin* ]]; then
        mv -fh -- ./answer "../$file"
      else
        mv -fT -- ./answer "../$file"
      fi
    ) 2> /dev/null && published=1
    rmdir -- "./${temporary:?}" 2> /dev/null || true
  fi
  [ -z "$published" ] || return 0
  printf '%s\n' 'Computer answer refused: it could not be published safely.' >&2
  return 1
}

# Each waiting command, one at a time, in a container of the updater's image: root with every privilege, in the
# computer's processes, network and names, with its whole file system at /host and its Docker. chroot /host runs a
# command on the computer itself. A command past its time, or still running when access is closed, is stopped;
# nothing runs while access is closed. A command this updater started is marked, so after a restart it never runs a
# second time, and what still runs of it is stopped.
computer_runs() (
  local file id started answer command timeout out name watch code made
  enter_computer_queue "$COMPUTER_CONTROL" || return 0
  for file in ./*.started; do
    [ ! -L "$file" ] && [ -f "$file" ] || continue
    id=$(basename "$file" .started)
    case "$id" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    [ ! -f "./$id.json" ] || continue
    docker rm -f "hornhoof-computer-$id" > /dev/null 2>&1 || true
    rm -f -- "${file:?}"
  done
  for file in ./*.json; do
    case "$file" in *.out.json) continue ;; esac
    [ ! -L "$file" ] && [ -f "$file" ] || continue
    id=$(basename "$file" .json)
    case "$id" in '' | *[!A-Za-z0-9-]*) continue ;; esac
    started="./$id.started"
    answer="./$id.out.json"
    if [ -L "$started" ] || [ -L "$answer" ]; then
      printf '%s\n' 'Computer request refused: its answer or start marker is a link.' >&2
      continue
    fi
    [ ! -e "$answer" ] || continue
    name="hornhoof-computer-$id"
    out=$(mktemp)
    if [ -f "$started" ]; then
      docker rm -f "$name" > /dev/null 2>&1 || true
      printf 'The updater restarted while this command ran, so it was stopped. Look at what it did before you run it again.\n' > "$out"
      if computer_answer "$id" 125 "$out"; then rm -f -- "${started:?}"; fi
      rm -f -- "${out:?}"
      continue
    fi
    if ! computer_open; then
      printf 'Access to the computer is closed.\n' > "$out"
      # Nothing ran, so an answer that could not be written is tried again at the next look.
      computer_answer "$id" 126 "$out" || true
      rm -f -- "${out:?}"
      continue
    fi
    command=$(jq -r '.command // empty' "$file" 2> /dev/null || true)
    timeout=$(jq -r '.timeout // empty' "$file" 2> /dev/null || true)
    case "$timeout" in '' | *[!0-9]*) timeout=300 ;; esac
    if [ "$timeout" -lt 1 ] || [ "$timeout" -gt "$COMPUTER_MAX" ]; then timeout=300; fi
    if ! { [ ! -L "$started" ] && [ ! -e "$started" ] && (set -o noclobber; : > "$started"); } 2> /dev/null; then
      printf '%s\n' 'Computer request refused: its start marker could not be created.' >&2
      rm -f -- "${out:?}"
      continue
    fi
    code=0
    made=1
    # Made first and only then started, so the watch can always stop it.
    docker create --rm --name "$name" --privileged --pid=host --network=host --ipc=host --uts=host -v /:/host \
      -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash "$COMPUTER_IMAGE" -c "$command" > /dev/null 2>> "$out" || made=''
    if [ -z "$made" ]; then
      code=125
    elif [ ! -f "$file" ] || ! computer_open; then
      touch "$out.closed"
      docker rm -f "$name" > /dev/null 2>&1 || true
    else
      # The watch removes the container if its time is up, access closes or its keeper takes the command back.
      (
        i=0
        while [ "$i" -lt "$timeout" ]; do
          sleep 1
          [ ! -f "$out.done" ] || exit 0
          if [ ! -f "$file" ] || ! computer_open; then
            touch "$out.closed"
            docker rm -f "$name"
            exit 0
          fi
          i=$((i + 1))
        done
        touch "$out.late"
        docker rm -f "$name"
      ) > /dev/null 2>&1 &
      watch=$!
      docker start -a "$name" < /dev/null >> "$out" 2>&1 || code=$?
      touch "$out.done"
      wait "$watch" 2> /dev/null || true
    fi
    if [ -f "$out.late" ]; then
      printf '\nStopped after %s seconds.\n' "$timeout" >> "$out"
      code=124
    elif [ -f "$out.closed" ]; then
      printf '\nStopped: access to the computer was closed.\n' >> "$out"
      code=125
    fi
    # The app stops waiting for an answer and takes the command back after a while.
    # The mark goes only once the answer is in place: a command whose answer could not be written never runs again.
    if [ ! -f "$file" ] || computer_answer "$id" "$code" "$out"; then rm -f -- "${started:?}"; fi
    rm -f -- "${out:?}" "${out:?}.done" "${out:?}.late" "${out:?}.closed"
  done
)

# What the machine is, where no installer run on the computer itself has said: asked of the Docker engine, once it
# answers. A server that came to this build by Update from a release from before machines had names has no such line
# in its .env, and this container is not the computer. An engine that runs in a machine of its own (Docker Desktop,
# OrbStack) says nothing of the computer it runs on, so only another engine is believed: its system is Linux and its
# name is the computer's. Written as host.json {os, hostname} for the keeper to report; a name that is no host's name
# is left empty.
HOST_ASKED=''
learn_host() {
  local said system name
  [ -z "$HOST_OS" ] && [ -z "$HOST_ASKED" ] || return 0
  said=$(docker info --format '{{.OperatingSystem}}|{{.Name}}' 2> /dev/null) || return 0
  [ -n "$said" ] || return 0
  HOST_ASKED=1
  system=${said%%|*}
  name=${said#*|}
  case "$system" in '' | *'Docker Desktop'* | *OrbStack*) return 0 ;; esac
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$ ]] || name=''
  jq -cn --arg hostname "$name" '{os: "linux", hostname: $hostname}' > "$CONTROL/host.json.new" 2> /dev/null || return 0
  mv "$CONTROL/host.json.new" "$CONTROL/host.json"
  HOST_OS=linux
}

# The machine's own addresses on its local networks, for the keeper to report: where the other machines of the company
# dial this one. A container sees only Docker's own network, so one on the host's network reads them, on Linux alone;
# the interfaces Docker and its bridges made are left out. Written whole and then moved, and a look that failed leaves
# what was there.
write_addresses() {
  local now out ids nets='' list
  learn_host
  [ "$HOST_OS" = linux ] || return 0
  now=$(date +%s)
  [ "$now" -ge "$ADDRESSES_AT" ] || return 0
  ADDRESSES_AT=$((now + ADDRESSES_EVERY))
  out=$(docker run --rm --network host --entrypoint ip "$COMPUTER_IMAGE" -4 -o addr show scope global 2> /dev/null) || return 0
  if [ -n "$out" ]; then
    ids=$(docker network ls -q 2> /dev/null || true)
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2016,SC2086 # the dollars are the template's own; one word per network
      nets=$(docker network inspect --format "$NETWORK_FORMAT" $ids 2> /dev/null || true)
    fi
  fi
  list=$(
    {
      printf '%s\n' "$nets"
      printf -- '---\n'
      printf '%s\n' "$out"
    } | awk '
      $0 == "---" { addr_mode = 1; next }
      !addr_mode && NF {
        split($0, f, "|")
        if (f[1] != "") skip_if["br-" substr(f[1], 1, 12)] = 1
        if (f[4] != "") skip_if[f[4]] = 1
        n = split(f[6], items, ";")
        for (i = 1; i <= n; i++) {
          if (items[i] == "") continue
          split(items[i], sg, ",")
          if (sg[2] != "") skip_ip[sg[2]] = 1
          split(sg[1], cp, "/")
          if (split(cp[1], oct, ".") == 4 && oct[4] == "0") {
            skip_ip[oct[1] "." oct[2] "." oct[3] ".1"] = 1
          }
        }
        next
      }
      addr_mode && $3 == "inet" {
        iface = $2
        sub(/:.*/, "", iface)
        if (iface ~ /^(docker|br-|veth|virbr|cni|podman|flannel|calico|nerdctl)/ || skip_if[iface] || skip_if[$2]) next
        split($4, a, "/")
        if (a[1] != "" && !skip_ip[a[1]]) print a[1]
      }
    ' | jq -Rnc '[inputs | select(length > 0)]' 2> /dev/null
  ) || return 0
  jq -cn --argjson at "$now" --argjson addresses "$list" '{at: $at, addresses: $addresses}' > "$CONTROL/addresses.json.new" 2> /dev/null || return 0
  mv "$CONTROL/addresses.json.new" "$CONTROL/addresses.json"
}
