#!/bin/bash
# Every test or gate run of the build goes through this. It keeps real Docker out of reach, and limits heavy runs to two
# at once, whoever starts them, because Ivan's company runs on this machine.
#   heavy.sh <command> [args...]               a heavy run: full suite, coverage run. Waits for a free slot.
#   HEAVY_SLOTS=2 heavy.sh <command> [args...] takes both slots: a mutator run with two workers.
#   light.sh <command> [args...]               a focused run of a few tests: no slot, the same Docker guard.
set -u
root=/home/altera/hornhoof-network/network-build
# remote.sh --dind gives a run its own inner Docker at this address, which nothing answers on anywhere else. Any other value
# gets the guard, whatever it points at.
if [ "${DOCKER_HOST:-}" != tcp://127.0.0.1:2375 ]; then
  export PATH="$root/nodocker:$PATH"
  export DOCKER_HOST="unix://$root/tmp/no-docker.sock"
fi
if [ "${LIGHT:-}" = 1 ]; then exec nice -n 10 "$@"; fi
slots_dir=$root/tmp/heavy-slots
mkdir -p "$slots_dir"
want=${HEAVY_SLOTS:-1}
exec 8>"$slots_dir/slot-1" 9>"$slots_dir/slot-2"
if [ "$want" = 2 ]; then
  flock 8; flock 9
else
  while :; do
    flock -n 8 && { exec 9>&-; break; }
    flock -n 9 && { exec 8>&-; break; }
    sleep 5
  done
fi
nice -n 10 "$@"
