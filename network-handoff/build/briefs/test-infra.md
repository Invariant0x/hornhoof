# Test infrastructure on home-api

You build the one command the whole team uses to run heavy tests on the test machine. Read
`/home/altera/hornhoof-network/CLAUDE.md` first, all of it, above all "The test machine home-api". Its rules bind you, and
David AI's answer in `/home/altera/hornhoof-network/QUESTIONS.md` ("Answers from David AI", item 4) binds you too.

## Hard limits, on another person's server

- Reach it only with `ssh -F /home/altera/hornhoof-network/.ssh/config home-api`. rsync with `-e` that same ssh. Never print or
  copy the key. The machine answers in about 3 seconds per ssh connection, so reuse connections or batch commands.
- Work there only inside `~/hornhoof-network-tests`. Read nothing else on that machine.
- `sudo -n docker` only, and only on containers, images, volumes and networks you created, all named with the prefix `hnb-`.
  It also runs Ivan's projects and his company's node (`hornhoof-machine-*`, `k3d-*`). Never stop, restart, exec into, inspect,
  remove or prune them. `docker system prune`, `docker image prune`, `docker builder prune`, `docker volume prune` and
  `docker container prune` are forbidden: they reach other people's things. List only with `--filter name=^hnb-`.
- Never mount `/var/run/docker.sock` into anything. A container that can talk to the host's Docker can reach Ivan's containers.
- Containers run as uid 1000 gid 1000 (the host user `ubuntu`), so that files they write stay removable without sudo. Only the
  Docker-in-Docker container is privileged and root, as David AI allowed.
- Disk is 80% full, 51 GB free. Containers, volumes, networks and run folders are removed when each run ends, also when it fails
  or is killed (a trap, plus `remote.sh clean` for leftovers).
- David AI's rule: images are removed after each run too. So keep the built image as a file
  `~/hornhoof-network-tests/images/hnb-build.tar` (about 1 to 2 GB is fine), `docker load` it when a run starts if the image is
  not there, and `docker rmi` it when the last running run ends. A build must leave no shared builder cache: a builder cache cannot
  be pruned by owner, so build through `docker run` plus `docker commit`, or a `docker buildx` builder of your own named `hnb-builder`
  removed afterwards. If you pull a base image, first check it was not already on the machine, and remove it afterwards only if you
  brought it.

## What to deliver: `/home/altera/hornhoof-network/network-build/remote.sh`

    remote.sh run [--dind] <label> '<command>'

It runs `<command>` with bash in a fresh isolated container on home-api, in a snapshot of the code at the moment of the call,
at THE SAME ABSOLUTE PATHS as on this machine, so every script and brief works in both places:
`/home/altera/hornhoof-network/hornhoof`, `.../hornhoof-edge`, `.../network-build` (its scripts and `nodocker/` only, not `runs/`
or `briefs/`), `.../quality`, `/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`,
`/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`. The exit code is the command's. Its
output goes to stdout and to a log, `network-build/runs/remote-<label>-<stamp>.log`.

Steps of one run:
1. Sync. rsync this machine's `hornhoof`, `hornhoof-edge` and those `network-build` files to `~/hornhoof-network-tests/base/`,
   under a local flock so that two callers do not race. Include `.git` (gates use `git diff`), `relay/test/.bin`, `target/coverage`
   and `.metrics`. Exclude `node_modules`, `__pycache__`, `target/mutation-workers`. Nothing private lives in those folders; never
   send `.ssh` or `quality/uv-cache`.
2. Dependencies. When `hornhoof/package-lock.json` changed since the base's last install, run `npm ci` in the base through the
   image, with the same `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and build `@hornhoof/protocol`.
3. Snapshot. `cp -al` the base to `~/hornhoof-network-tests/runs/<label>-<stamp>/` (rsync replaces files by rename, so a later sync
   does not change a running snapshot). Keep `packages/protocol/dist` a real copy.
4. Slot. At most 3 runs at once on home-api: a local flock on 3 slot files, waiting, as `network-build/heavy.sh` does.
5. Container `hnb-run-<label>-<stamp>`: image `hnb-build:1`, `--user 1000:1000`, `--cpus 4`, `--memory 24g`, `nice -n 10` around the
   command, `HOME=/home/altera`, `VITEST_MAX_WORKERS=4`, the snapshot mounted at the same paths as here, a Docker guard as in heavy.sh
   (`nodocker` first on PATH, `DOCKER_HOST` at a dead socket) unless `--dind`. `network-build/heavy.sh` and `light.sh` must still work
   when they run inside it. Set `MUTATOR_WORKERS=4` and teach `network-build/mutate.sh` and `mutate-helper.sh` to read it, default 2.
6. Results back: rsync only each repository's `target/coverage/` and `.metrics/` to this machine. Nothing else comes back.
7. Clean: container, snapshot folder, and the image if this was the last run.

`--dind`: for `npm run test:real` and `test:lab`. Start `hnb-dind-<stamp>`, an official `docker:<exact version>-dind` image, privileged,
`DOCKER_TLS_CERTDIR=""`, its own volume `hnb-dind-<stamp>` on `/var/lib/docker`, the snapshot mounted at the same paths. Run the test
container with `--network container:hnb-dind-<stamp>` and `DOCKER_HOST=tcp://127.0.0.1:2375`, so that ports the inner Docker publishes
are on the test's own 127.0.0.1 and bind mounts have the same paths on both sides. The test container gets a docker CLI in the image and no
guard. Everything inner dies with the volume. Remove the container and the volume at the end. Count these against the same slots.

    remote.sh clean     removes this build's leftover hnb- containers, volumes, networks and run folders that no live run owns.
    remote.sh status    shows only hnb- things and the disk.

## The image `hnb-build:1`

From the same base as `hornhoof/apps/node/Dockerfile`'s final stage (`node:22.23.4-bookworm-slim` with that digest). Add the system
tools that image has and that tests use: at least `git ca-certificates curl ripgrep jq file tmux procps python3 python3-venv patch
openssl rsync`, and a pinned shellcheck and docker CLI with the checksum checked where one is published. Then uv, Python 3.12 and 3.14 at the
paths above, and Uncle Bob's tools built by `network-build/setup-quality.sh` (adapt it so that it works in both places, without changing
what it builds), including `quality/py312` with coverage 7.17.1. Wrappers in `quality/bin`, grammars baked in. `/home/altera` writable
by uid 1000. The definition lives in `network-build/remote/`.

## Prove it, and report what you observed

The local trees are being edited by writers right now, so for proofs make the snapshot clean first, inside it only: start the command with
`git -C /home/altera/hornhoof-network/hornhoof-edge checkout -f HEAD -- . && git -C ... clean -fdq relay` and the same for `hornhoof` (no
`-x`, keep ignored files). Never run such a thing outside the container.
1. `remote.sh run proof-relay` with `/home/altera/hornhoof-network/network-build/gates-relay.sh <HEAD>~1` on hornhoof-edge's committed HEAD: its
   tests pass, crapper and dryer print scores, and `target/coverage` and `.metrics` came back. Give the time.
2. `remote.sh run proof-hh` with `npm test -- --testTimeout=90000` from `hornhoof`: green. Give each workspace's counts and the time.
3. `remote.sh run proof-mut`: `mutate.sh` on one line of `relay/relay.py` that a test surely kills, with a scoped test command. Killed.
4. `remote.sh run --dind proof-dind`: `docker run --rm alpine:<exact version> echo ok` and a published port reachable on 127.0.0.1 from the test
   container. Then `remote.sh status` shows nothing left but the base, the image file, the slot state.
5. Kill a run with SIGTERM midway: nothing of it stays.
6. Show that the count of containers not named `hnb-` did not change and none restarted: compare `sudo -n docker ps -q --filter ... | wc -l`
   type counts only, before and after; do not inspect them.

On this machine, in a-host, keep to `nice -n 10`, and do not start heavy local runs: other agents use its slots. English in files, no em dashes, comments say why,
small functions in the shell. Do not touch `hornhoof` or `hornhoof-edge` working trees here, or `.git`, and do not commit. Do not dispatch subagents.

Write `/home/altera/hornhoof-network/network-build/runs/test-infra-report.md`: what was built, sizes, timings, how each proof came out, anything you could not do. Reply with the
status and at most six lines. Say only what you observed.
