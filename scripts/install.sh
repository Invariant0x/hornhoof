#!/usr/bin/env bash
# Hornhoof node installer. The server fills in its own address when it serves this file.
set -euo pipefail
SERVER="${HORNHOOF_SERVER:-__HORNHOOF_SERVER__}"
echo "The Hornhoof installer for $SERVER is not ready yet." >&2
exit 1
