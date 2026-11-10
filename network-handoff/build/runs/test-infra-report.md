# Test infrastructure on home-api: report

Status: remote.sh works and is in daily use by the writers. All six proofs of the brief and the lane proof ran on home-api. Two
things in the brief's proofs I could not show in full (see "Not shown"). One real finding in relay.py came out of it, reported
to the lead and not fixed (see "test_restart_burst").

## What was built

| File | What it is |
|---|---|
| `network-build/remote.sh` | `run [--dind] <label> '<command>'`, `clean`, `status`, and `image` (added: builds the image files) |
| `network-build/remote/host.sh` | The half that runs on home-api. Every Docker action goes through functions that refuse a name without `hnb-` |
| `network-build/remote/provision.sh` | Turns a container of the Dockerfile's base into `hnb-build:1`, committed with `docker commit` |
| `network-build/remote/test/` | `test-remote.sh` with fake ssh, sudo and Docker: real rsync, flock and scripts, 348 checks, all pass |

Changed: `heavy.sh` (keeps its guard unless DOCKER_HOST is exactly the run's inner Docker), `mutate.sh` and `mutate-helper.sh`
(read `MUTATOR_WORKERS`, default 2), `setup-quality.sh` (installs Python 3.12.14 when absent, builds `quality/py312` with coverage
7.17.1). The new lines of `setup-quality.sh` ran only in the image build, not on a-host, because heavy local runs are not allowed.

Added at the lead's request while the work went on: `REMOTE_EDGE_TREE` and `REMOTE_HORNHOOF_TREE`, a base per lane, and 3 slots of
`--cpus 3` with `VITEST_MAX_WORKERS=3` and `MUTATOR_WORKERS=3`, which replace the brief's `--cpus 4` and 4 workers.

Rulings are in the ledger (`progress.md`, "Test infra").

## Sizes and timings

- `images/hnb-build.tar` 317 MB (1.28 GB loaded). `images/hnb-dind.tar` 139 MB (539 MB loaded). Image build: 594 s.
- Base: main hornhoof 376 MB with node_modules, hornhoof-edge 38 MB. A Hornhoof lane on the main lock: 31 MB, node_modules linked.
- Disk free: 51 GB at the start, 47 GB at the end, with three runs live and both images loaded.
- A prepare (sync plus snapshot) took 8 to 38 s when nothing else held the lock.
- Whole relay suite: about 7 minutes. Whole Hornhoof suite: about 27 minutes. Both with 2 other runs alongside.
- Load on home-api during the day: 15 to 25 at the samples I took, on 8 cores, with the runs at `nice -n 10`.

## Proofs

Every run below went through `remote.sh` and the snapshot clean of the brief, unless noted.

1. **proof-relay: passed on the second run.** First run 123 tests in 472 s, `test_restart_burst` failed (see below). Second run:
   123 tests OK in 415 s, 422 s in all; crapper printed scores (for example `admin` 29.4, `create_binding` 26.2, `proxy_check` 9.2) and
   dryer printed "No duplicate candidates found". `target/coverage/python/lcov.info` and `.metrics/{crap,dry}.edn` came back with a new
   checksum and the run's time. Base used was `<HEAD>~2`, because `<HEAD>~1` changes only a test file and the gate then stops early.
2. **proof-hh: green, 27 minutes** (1628 s), through `network-build/hh-suite.sh`.

   | Part | Files | Tests | vitest time |
   |---|---|---|---|
   | test:release | | 44 passed | |
   | protocol | 5 | 127 passed | 0.9 s |
   | node | 87 | 1206 passed | 245 s |
   | server | 109 | 1805 passed | 1201 s |
   | web | 49 | 767 passed | 110 s |

3. **proof-mut: killed, on the second run.** Line 477 of the committed relay.py, `test_sync...test_r2_4_bad_bodies`: 3 killed, 0 survived,
   100%, exit 0, about 20 s. The first run gave 3 false survivors: at committed HEAD `harness.py` still follows the worker's symlink,
   as the ledger's Plan 1 Task 7 ruling says. The second run keeps the working tree's `harness.py`, with that fix.
4. **proof-dind: passed.** `docker run --rm alpine:3.24.3 echo ok` printed ok, client and server 29.7.1. A port published on 127.0.0.1
   answered `hello-from-inner` from the test container, as uid 1000. Bind mounts worked at the same path, for the repository and for `/tmp`. Compose
   v5.4.0, buildx v0.36.0, and `heavy.sh docker version` reached the inner Docker. A root-owned folder written by an inner container was taken
   back and removed at the end ("taking back files that a root process left"). A second run showed dockerd on `127.0.0.1:2375` only, with no port
   bindings, and the host's connection to its 2375 refused.
5. **SIGTERM: nothing stayed.** While waiting for a slot: exit 143 in 4 s, the folder gone. With the container running: exit 143 in 3 s,
   container, network and folder went from 1, 1, 1 to 0, 0, 0, live file gone.
6. **Other people's containers: counts unchanged.** Not named `hnb-`: 9 total, 7 running, 2 exited, 0 restarting, at the start and at each sample
   through the end. No container, volume, image or network without the prefix was acted on. The node base I pulled is the one exception,
   removed after use: the failed first build left it, the build's log shows it was downloaded, and an earlier check by tag found none.

7. **Lane: passed.** A lane whose relay.py differs from the real one: the container saw the lane's checksum (4fe73a5a), not the real tree's
   (2f717367), and its `.lane-repo` and own file. `lanebase` was readable. `gates-relay.sh lanebase` passed, 123 tests. Results came back to the lane, and the
   real tree's `lcov.info` kept its earlier time. A Hornhoof lane saw its own file, `lanebase`, node_modules and its dist; my command showed no vitest count there, so that run proves the tree, not a test
   result. Writers' Hornhoof lanes measure 31 MB in the base, so their modules are links. Removing both lanes here and running `clean` removed their bases. Three runs from one lane at once kept separate snapshots.

Guard, in a plain run: uid 1000, `docker` resolves to `nodocker`, exit 127; the real CLI fails on the dead socket; no `/var/run/docker.sock`; `heavy.sh` and `light.sh` work;
Python 3.12.14 and 3.14.7, coverage 7.17.1, node 22.23.4, shellcheck 0.11.0, crapper, dryer and mutator answer; `/home/altera` is writable.

Hard links: after several Hornhoof suites, no file in the main base's node_modules was newer than its install (0 of 16668).

Quality gates: crapper, dryer and mutator do not read shell, so they do not apply to this code. Shellcheck at warning level: no warning on remote.sh, host.sh, provision.sh, the fakes,
heavy.sh, mutate.sh, mutate-helper.sh; setup-quality.sh clean. test-remote.sh had SC2034 (variables read through an evaluated string) and SC2010; I disabled those two with a comment
and did not run shellcheck again after adding it.

## Defects the proofs found, all fixed with a failing test first

- Output was held back: `tail` on a pipe holds output in 4096-byte blocks, so logs stayed empty for minutes. My first test missed it, because it matched
  the word in a line of the runner's own. Now `stdbuf -oL`, and a test that fails without it.
- Slots were random: my proofs waited over an hour while newer runs passed. Now oldest call first, and `remote.sh status` shows the queue.
- `chown -R` in `provision.sh` hit the read-only mounts and failed the first image build. A failed build also left the base image behind. It now cleans up on failure.
- A lane's git had no objects in the container: its alternates path is the lane itself there. The snapshot now takes the objects in.

## test_restart_burst: a real finding in relay.py

Reported to the lead, not fixed. Every rejection I traced is `relay error: busy`: `write()` spends its 0.8 s SQLite budget. 43 tries of that test alone, on committed relay.py.
The reason, the write times and the dashboard times were added to the trace inside the snapshots only. The test's assertions were unchanged.

| Relay DB on | Burners in the container | Failed tries | NewProxy max ms, median (worst) | Throttled | Load |
|---|---|---|---|---|---|
| real disk, plain | 0 | 1 of 13 | 597 and 810 in the two sets (815) | 0 | 8 to 17 |
| real disk, coverage | 0 | 0 of 9 | 705 and 713 (808) | 0 | 4 to 9 |
| tmpfs, plain | 0 | 0 of 8 | 14 (23) | 0 | 5 to 8 |
| tmpfs, coverage | 0 | 0 of 4 | 57 (109) | about 0 | 3 to 4 |
| tmpfs, plain | 6 and 12 | 0 of 6 | about 320 (409) | 9 to 33 s | 4 to 16 |
| real disk, plain | 6 | 2 of 3 | 994 (1042) | 12 to 26 s | 17 to 18 |

Observed:
- Not coverage: a plain run failed. Not CPU alone: tmpfs held under 410 ms at load 16 with 12 burners, and the plain failure had 0 ms of throttling and no slow dashboard read.
- The disk is the difference: same burst, worst NewProxy 23 ms on tmpfs against 815 ms on disk. CPU starvation on top of the disk pushes it over: 2 of 3 failed at load 17 to 18.
- The burst makes about 118 writes, each its own commit under `synchronous=FULL`. One fsync took about 3 ms (p50) on this disk. The slowest write waited 735 to 857 ms.
- a-host's `/tmp` is tmpfs, so these tests never paid for a real sync there.

What I think, not measured:
- The wait beyond the serial fsync time may be SQLite's busy backoff.
- p1t8's passes are chance: it sits on the edge.
- The droplet runs on a real disk, whose fsync I have not measured, so 40 links after an frps restart could get refusals there.

Limits: no truly quiet machine was available. The lowest load on real disk was 4.1. On the full suite I saw 2 failures (first proof-relay, p1t7-gates) and 5 passes (three p1t8 runs, the second proof-relay, the lane proof).

Options, for the lead: in relay.py, fewer commits per call, one writer, or another `synchronous` or budget setting. For the runs only: `TMPDIR=/dev/shm` makes the relay gates steady, but it hides this disk behaviour, so I did not set it.

## Not shown

- **"None restarted" is not proven by counts.** A container that restarted and came back between two samples leaves the counts unchanged. `docker events` counted per name would show it. It reads about other people's containers beyond the brief's count type, so I did not run it; say if you want it.
- **An empty `status`.** Writers' runs were live through the end, so I never saw the state with nothing but the base and the image files. What I saw: no container, network or folder of any finished proof left. Removing the image with the last run is covered by the fake-Docker tests and not observed on the real machine.
- `test:real` and `test:lab` do not exist yet in Hornhoof. The dind proof is the brief's own, not those suites. Plan 10 or 13's Docker networks and `lab.Dockerfile` have not been tried.

## For the team

- Proofs replaced `hornhoof-edge/target/coverage/python/lcov.info` (from committed HEAD) and `.metrics/`. Do not use `gates-relay.sh --no-tests` on the real tree without a fresh coverage run.
- `gates-hornhoof.sh` still sets `VITEST_MAX_WORKERS=2` and `--maxWorkers=2`, also on home-api. I left it, since the brief named only the mutate scripts.
- A `timeout` around `remote.sh` counts the time in the queue, and one Hornhoof suite holds a slot for about 27 minutes.
- `remote.sh` and `host.sh` must be replaced by rename, not edited in place: bash reads a running script as it goes.
