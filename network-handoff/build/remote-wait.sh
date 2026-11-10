#!/bin/bash
# remote-wait.sh <label>: for a run started in the background with remote.sh. Blocks up to 9 minutes, then says where the run stands.
# Call it again while it says WAITING. Writers must not end their turn while a run of theirs is pending: a notice may never reach them.
set -u
label=${1:?label}; deadline=$((SECONDS + 540)); root=/home/altera/hornhoof-network/network-build
while [ $SECONDS -lt $deadline ]; do
  if ! pgrep -f "remote.sh run( --dind)? $label( |$)" > /dev/null; then
    log=$(ls -t "$root"/runs/remote-"$label"-*.log 2>/dev/null | head -1)
    echo "DONE: $log"; sed 's/\x1b\[[0-9;]*m//g' "$log" | tail -25 | cut -c1-160; exit 0
  fi
  sleep 15
done
echo "WAITING: $label still queued or running; call again"
