#!/bin/sh
# Runs the tests that need a real ACME server against Pebble, Let's Encrypt's test CA, and the tests that need real
# Postgres against the image compose's db runs, each in a container of its own. With HH_REAL_PG set, Postgres is that one.
set -eu

PEBBLE=ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199
NAME="hornhoof-pebble-$$"
WAIT_SECONDS=30
POSTGRES=postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1
PG_NAME="hornhoof-pg-$$"
PG_WAIT_SECONDS=60

if ! docker info > /dev/null 2>&1; then
  echo 'test:real needs Docker' >&2
  exit 1
fi

TEMP=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" "$PG_NAME" > /dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# pg_isready over TCP, since the image's first start runs a server on its socket alone and then restarts it.
start_postgres() {
  password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  # By name, so that the value is on no command line for ps to show.
  POSTGRES_PASSWORD=$password docker run --detach --name "$PG_NAME" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 "$POSTGRES" \
    -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 -c max_prepared_transactions=0 > /dev/null
  waited=0
  until docker exec "$PG_NAME" pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -ge "$PG_WAIT_SECONDS" ]; then
      echo "Postgres did not answer within $PG_WAIT_SECONDS seconds" >&2
      docker logs "$PG_NAME" >&2
      exit 1
    fi
    sleep 1
  done
  published=$(docker port "$PG_NAME" 5432/tcp | head -n 1)
  HH_REAL_PG="postgres://postgres:$password@127.0.0.1:${published##*:}/postgres"
}

if [ -z "${HH_REAL_PG:-}" ]; then
  start_postgres
fi

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

HH_REAL_PG="$HH_REAL_PG" \
NODE_EXTRA_CA_CERTS="$TEMP/ca.pem" \
PEBBLE_DIRECTORY=https://localhost:14000/dir \
PEBBLE_MANAGEMENT=https://localhost:15000 \
  npx vitest run -c vitest.real.config.ts
