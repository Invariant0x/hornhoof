#!/bin/sh
# Runs the tests that need a real ACME server against Pebble, Let's Encrypt's test CA, in a container of its own.
set -eu

PEBBLE=ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199
NAME="hornhoof-pebble-$$"
WAIT_SECONDS=30

if ! docker info > /dev/null 2>&1; then
  echo 'test:real needs Docker' >&2
  exit 1
fi

TEMP=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# PEBBLE_VA_NOSLEEP drops the delay Pebble adds before each validation, which only slows these tests down.
docker run --detach --name "$NAME" -e PEBBLE_VA_NOSLEEP=1 -p 14000:14000 -p 15000:15000 \
  --add-host acme.test:host-gateway "$PEBBLE" -config test/config/pebble-config.json -strict > /dev/null

waited=0
until curl -ksf https://localhost:14000/dir > /dev/null 2>&1; do
  waited=$((waited + 1))
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "Pebble did not answer within $WAIT_SECONDS seconds" >&2
    docker logs "$NAME" >&2
    exit 1
  fi
  sleep 1
done

# Pebble's test CA stays in its image and is copied out at run time, so no certificate is ever committed.
docker cp "$NAME:/test/certs/pebble.minica.pem" "$TEMP/ca.pem" > /dev/null

NODE_EXTRA_CA_CERTS="$TEMP/ca.pem" \
PEBBLE_DIRECTORY=https://localhost:14000/dir \
PEBBLE_MANAGEMENT=https://localhost:15000 \
  npx vitest run -c vitest.real.config.ts
