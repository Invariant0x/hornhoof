# Batch 2, slice install (2 T1, 2 T8, 2 T9), review (Claude)

Package: `network-build/runs/batch2-install.diff`, the three commits `fa5e1090`, `29c2d105`, `81a58e47` on branch `batch-2` of
`/home/altera/hornhoof-network/hornhoof`. Read only; no file in either repository touched; no test run (the lead's suite result
stands, and no doubt needed one). The earlier reader's six Minors on 2 T1 (`runs/p2t1-r1-claude.md`) are not repeated; they
are judged against 2 T8 below.

## Counts

Critical: 0. Important: 0. Minor: 8.

## What I checked, and how

- Each Interface line of the three tasks against the code, by reading: 2 T8 `start_server_services` steps 1 to 4 and the four
  `up` strings (`install.sh:979-1000`), the migrate words (`install.sh:972`), `HORNHOOF_MACHINE_ID` once, by `host_id` or
  `random_hex 16` (`install.sh:1081`), the handover's exact `docker run` line, place (after `compose.yaml`, before the pull
  and before `reserve_ports`, `install.sh:1092`), both failure texts and the sleep (`install.sh:1005-1011`); 2 T9
  `take_port_lock`, `remove_stale_port_lock`, `drop_port_lock`, `read_registry`, `write_registry`, `bound_ports`, the order
  of held ports and the two searches, registry line before `.env`, the second read of the lock's id, the lock dropped by an
  EXIT trap on every path, `reserve_ports` after the pull and before the start, the step 3 retry up to 5 times for a port
  marked new only (`install.sh:787-950`). All match, or differ only where the ledger has a ruling (line 212: empty
  `HORNHOOF_PORT=` in a new `.env`, `PUBLIC_URL` on any new `.env`, `local_url` after the start).
- The stub contracts of 2 T8 and 2 T9 against the plan's words: `STUB_MIGRATE`, `STUB_RUN`, `STUB_PORTS_DIR`, the lock's
  conflict text and `lock-<n>`, `STUB_LOCK_SINCE`, `STUB_BOUND_IDS`/`STUB_BOUND_PORTS`, `STUB_BIND_FAIL`, `STUB_REGISTRY`,
  `STUB_LOCK_TAKEN`: present and as written.
- Every test the plan names for 2 T8 and 2 T9 is present and asserts what the plan says. Orderings use `indexOf` of exact
  strings, so a missing step gives -1 and fails; ports are read as whole `.env` lines; the lock and registry tests check the
  write's position against the lock's create and `rm`. None passes with the code wrong on what the task promises.
- `refused_port` (`install.sh:926`) run by hand on four Docker wordings: `Bind for 0.0.0.0:8080 failed`, `Bind for [::]:8081
  failed`, Docker 28's `failed to bind host port for 0.0.0.0:8080:172.18.0.2:8080/tcp: address already in use`, and a line
  preceded by compose's `Container ... Starting`: each gives the right port.
- Em dashes and IP addresses in the package: none. No secret value reaches a log, a test message or this report; the new
  tests read `.env` through `linesOf`, one key at a time. Hostnames: only `hornhoof.example.test`, `hh.acme.test`, as before.
- bash 3.2: the new code uses `<<<`, `until`, `${!#}`, `local -a`, `$(( ))`, `trap ... EXIT`; nothing newer. The test tool
  list gained `tee`, which `compose_step` needs.
- The three tasks together, as the real run would go (the stubs cannot show this), from named lines:
  - Forward under revision 2: `update` reads the build to go back to, `backup` stops the app and dumps, `install` unpacks,
    `remove_unnamed` removes `tunnel` by the project label (the lock container, the registry's short containers, the
    hand-over helper and plan nodes carry no compose label, so none is touched), `run_installer` runs the new `install.sh`
    with `HORNHOOF_UPDATER_REV=2` and `HORNHOOF_PULLED=1`: it skips the handover, runs `reserve_ports` inside the updater's
    container (`docker` through the socket; `port_answers` is skipped there; `.env` keeps its owner through `set_env`'s
    `cp -p`), a company from before with no `HORNHOOF_PORT` line is `ENV_BEFORE` and keeps 8080, then `stop app`, `up db`
    with `--remove-orphans` (the updater itself is in the file, so it stays), `up keeper front`, `up app`. Health is asked
    at `front:8080`; `overLink` needs `x-forwarded-proto: https` from `TUNNEL_HOST`'s address (`auth/tunnel.ts:22-28`), so
    an internal request gets `commit` as long as the keeper adds that header for link traffic only, as the plan's ruling
    says (seam for 2 T5, below).
  - The handover: the revision 1 installer writes `.env` (new refs, `HORNHOOF_MACHINE_ID`, project name) and `compose.yaml`,
    starts the helper with `<project>_control` and the folder at the same host path, then sleeps; it exits 1 only after the
    sleep or when the helper could not start, so the earlier reader's worry for Task 8 is met: it blocks until compose
    recreates its updater. `take_over` reads the same `status.json` and note, `compose up --wait updater` recreates the
    updater (plan 2 T7 keeps `updater` as it is, with no `depends_on`, so nothing else of the new build starts), the new
    updater takes the second copy with the app stopped, and the new installer, now at revision 2, runs the install above.
    On failure the way back runs the old installer with the old file, after `remove_unnamed` removed `front`, `keeper` and
    `migrate`; `health_url` reads the old file and asks the app.
  - A rollback with migrations restores the database while the new keeper still reads it every 3 s: `DROP DATABASE ... WITH
    (FORCE)` ends those connections, the rename needs none on `hornhoof_restore`, and the keeper's container goes before
    the old installer runs. No data path lost.
- Gates: crapper and dryer read no bash, as both writers say; the test files were run through dryer by the writers with no
  pair. By reading, the new shell functions are small and named for what they do; one near pair is Minor 6. TDD: both
  writers' reports list each new test's first failure, and the three 2 T9 tests that passed at once were broken by hand.

## Findings

No Critical. No Important.

### Minor

1. `apps/updater/updater.sh:388-408` (`health_url`, `healthy`): `health_url` is worked out on every try, and each try runs
   `docker compose config --services` (a second or so), so `HEALTH_WAIT` counts tries, not seconds: 120 becomes three to
   four minutes before the updater gives up, forward and on the way back. A person waits longer in maintenance when a build
   is dead. Work out the address once per `healthy` call.
2. `scripts/install.sh:972` (`start_app`): the migrate check matches only `"migrate" didn`. Newer Compose 2 reports a
   dependency that exited as `dependency failed to start: container <name>-migrate-1 exited (1)`; then the person gets the
   general `Hornhoof did not start` line, as today, and not the one that names `docker compose logs migrate`. Match
   `migrate` with `exited` too. The writer's report says the words are from memory; real Compose was out of reach here.
3. `scripts/install.sh:814-820` (`bound_ports`): a container that publishes a host port range (`8080-8090`) prints the range
   as one word, so none of those ports counts as held. Edge; a port in such a range would then be refused by Docker at step 3
   and moved by the retry when it is new.
4. `scripts/install.sh:936-950` (`start_keeper_and_front`) with `install.sh:1038`: a new company whose chosen web port Docker
   refuses, and whose retry then fails on the lock (`fail "$PORT_LOCK_BUSY"`), keeps the refused port in `.env`; the next
   run reads a non-empty `HORNHOOF_PORT`, so `ENV_BEFORE` is set, the port is no longer marked new, and the run ends with
   `Port <port> is taken by a program outside Docker`, which the person can only fix by editing `.env`. Two rare things at
   once; a note in that message that a new company may remove the `HORNHOOF_PORT` line, or marking the port new again when
   the registry line was written by a run that did not finish, would close it.
5. `scripts/install.sh:797-805` (`take_port_lock`): a `docker create` that fails for any reason but the name (image not on
   this computer, daemon error) loops for `HORNHOOF_PORT_LOCK_WAIT` and ends with the lock message, hiding the cause. The
   writer ruled on it in the report; the ruling is not in the ledger (see Minor 8).
6. `scripts/install.sh:830-842` (`other_lines`, `own_ports`): the two read the registry line by line and compare the folder,
   one keeping the other lines, one giving this folder's ports; a near pair that dryer would not see on bash. One walk that
   returns both would do.
7. `apps/server/test/install-script.test.ts:68` (`fromUpdater`): a test that calls it without `HORNHOOF_UPDATER_REV: '2'`
   and without `HORNHOOF_HANDOVER_WAIT` sits in the handover's `sleep 300` until `spawnSync` gives up at 60 s and fails
   with `expected null to be +0`, as the writer's own first run did. A default `HORNHOOF_HANDOVER_WAIT: '1'` in the helper
   would make the next such mistake fail in a second with the handover's own words.
8. Ledger: 2 T8/T9's commit messages and ledger line 212 carry the `.env`, `PUBLIC_URL` and `local_url` rulings; the
   writer's report has four more (the migrate words, the `Port <port> is taken, so Hornhoof takes another one.` line, the
   read and write failure words, the lock's other failures) that the ledger does not. One line each.

## Earlier Minors on 2 T1, against 2 T8

The six hold as written and 2 T8 changes none of them. The note the earlier reader left for Task 8 is met: the hand-over
installer never returns 0, it sleeps until compose recreates its updater and fails only after `HORNHOOF_HANDOVER_WAIT`
(default 300 s, longer than the helper's 60 s) or when the helper could not start; the helper gets `/control` and
`HORNHOOF_SERVER_DIR` with the folder at the same path.

## Seams for the lead

- 2 T1 and 2 T5/T6: the updater reads `commit` from `http://front:8080/api/health`. That works only while the keeper adds
  `x-forwarded-proto: https` for link traffic alone and `/api/health` is served as a read in `maintenance`; in `off` the
  app answers 503 and the updater retries until the keeper's first word arrives. Check in the keeper slice.
- 2 T1 and 2 T7: `take_over` and `swap_updater` run `compose up ... updater` without `--no-deps`; plan 2 T7 keeps `updater`
  with no `depends_on`, so nothing else starts. If T7 ever gives it one, add `--no-deps` here.
- 2 T8 and 2 T7: `up -d --no-build --remove-orphans --wait db` needs `db` to have a healthcheck (it does) and the service
  names `keeper front migrate app` in the file; until T7 lands step 3 fails on `no such service`, as ruling 195 says.
- 2 T9 and 2 T7: `front` must publish `${HORNHOOF_PORT:-8080}` and the keeper `${HORNHOOF_PEER_PORT:-8180}` with `:-`, since
  a new `.env` holds `HORNHOOF_PORT=` empty until the ports are chosen and `compose pull` reads it before that.
- 2 T9 and the registry's helper containers: they run `"$APP_REF"` as `--user 0 --entrypoint sh`; the app image is
  `node:22-alpine`, which has `sh` and `mv`.
