# Plan 2, Tasks 8 and 9: writer's report

Lane: `/home/altera/hornhoof-network/wt/p2t8`. Nothing staged or committed. Status: DONE_WITH_CONCERNS (see Concerns).

## Rules and skills read

- `/home/altera/hornhoof-network/CLAUDE.md`, `AGENTS.md` and `templates/skills/dev-engineering-rules.md` in the lane.
- Skills `test-driven-development`, `systematic-debugging`, `verification-before-completion` in
  `plugins/superpowers/skills/`.
- `network-build/briefs/p2t8-writer.md`, whole; `network-build/parallel-map.md`, sections 1 to 5 and my rows.

## Files changed

- `scripts/install.sh`
- `apps/server/test/install-script.test.ts`
- `apps/server/test/install-stubs/docker`

The diff of Task 8 alone, as it stood when its checks passed, is `network-build/runs/p2t8-task8.patch`, so the two tasks can
land as two commits. Task 9 is the rest of the lane's diff.

## Task 8: start order, machine id, handover

**Results.** Baseline before any change: 69 passed. After Task 8: 75 passed, from `apps/server`, through `light.sh`,
`npx vitest run test/install-script.test.ts --maxWorkers=2`. On the test machine (`p2t8-t8-shell`): `bash -n` clean,
`shellcheck` 0.11.0 printed nothing, exit 0. shellcheck is not on this machine, so it only ran there.

**How each new test failed first** (test and stub written, script untouched):

| Test | Failure seen |
|---|---|
| `starts the database, then the keeper and front, then the app, which migrates first` | the steps were not in `calls` (`expected false to be true`) |
| `says where to look when the database cannot be brought up to this build` | output had today's words, not the migrate message |
| `writes the machine id once: the host id by hand, a random one from the updater` | `.env` had no `HORNHOOF_MACHINE_ID` |
| `hands an update to this build's updater when an older updater runs it` | exit 0, expected 1: no handover |
| `stops when the hand-over helper does not start` | exit 0, expected 1: no handover |
| `goes on without a handover under an updater of revision 2` | first on the old `up` string; then, with the handover written without its revision check, it ran into the 60 s limit of `spawnSync` (`expected null to be +0`), since it sat in the handover's wait. The check made it pass |

The six older tests with `HORNHOOF_FROM_UPDATER` gained `HORNHOOF_UPDATER_REV: '2'`, and four failed on the new `up` strings
before the code.

## Task 9: host-wide port registry

**Results.** 92 passed, the same command. Final run on the test machine (`p2t8-final`, log
`network-build/runs/remote-p2t8-final-20261104-222000-985774.log`), on the lane's final code:

- `bash -n` clean; `shellcheck` printed nothing, exit 0.
- `npx tsc -p apps/server/tsconfig.json --noEmit` exit 0; `npm run typecheck:tests` exit 0; `npm run lint` exit 0.
- `install-script`, `compose`, `pins` and `updater` test files: 4 files, 143 tests passed.
- `gates-hornhoof.sh lanebase server test/install-script.test.ts`: `no source files of apps/server in this task`.

The three tests the plan says pass unchanged were not edited and pass: `installs a named server in its own folder, compose
project and free port`, `keeps the folder and port of a named server on the next run`, `leaves the port of another Hornhoof on
this computer to it, even while it is stopped`.

**How each new test failed first** (no registry in the script yet):

| Test | Failure seen |
|---|---|
| `keeps a host-wide list of ports, so four companies on one computer never share one` | `.env` had no peer port |
| `leaves the ports of a stopped and pruned company to it` | got 8080, expected 8081 |
| `skips ports any container publishes, running or stopped` | got 8080, expected 8081 |
| `gives an existing company a peer port and keeps its web port` | `.env` had no peer port |
| `chooses a new company's ports by the free search though its .env is there by then` | got 8080, expected 8081 |
| `takes the lock and gives it back` | no `docker create --name hornhoof-port-lock` call |
| `writes nothing when another install took its lock over` | exit 0, expected 1 |
| `takes over a lock older than two minutes by its id, and waits for a younger one` | no `docker rm lock-old` call |
| `moves a new port that something outside Docker holds, and its address with it` | `.env` had no peer port |

Tests beyond the plan's list:

| Test | Why it is there | First result |
|---|---|---|
| `counts a company whose first run stopped before it chose its ports as new` | Ruling 1 | failed against the plan's exact code: got 8080, which another company held |
| `gives a company whose folder is gone its ports and its address back` | Ruling 2 | failed against the plan's exact code: no `PUBLIC_URL` |
| `takes the last port of a range, and says so when a range has none free` | the plan's range and words | failed: no registry yet |
| `hands out no port when it cannot read the list` | an unread list must not count as empty | failed: no registry yet |
| `asks no port on localhost from the updater, whose localhost is its own container` | the plan's "run by hand" | failed: no peer port yet |
| `reads a folder with a space in its name from the list` | the line format has no quoting | passed at once; a breakage below failed it |
| `keeps to the ports in other companies' .env files when the list is gone` | the plan's held list, peer side | passed at once; a breakage below failed it |
| `says what did not start when a step fails for another reason` | the plan's words for `db` and "fails as today" | passed at once; a breakage below failed it |

**Hand breakages.** To check tests that had not failed one by one, I broke 36 single lines of `install.sh`, one at a time, and
ran the test meant to catch each. All 36 were caught. One first survived because I had named the wrong test; against
`keeps a host-wide list` it fails. This is not the mutator, which writers do not run and which does not read bash. The script
was restored and compared after each batch. Examples: no `trap`, no second lock read, stale limit at 0 and at 100000, retry
limit 4 and 6, range one short and one long, list written after `.env`, the address worked out before the start.

## Gates

crapper and dryer see no source file in this task: `gates-hornhoof.sh` keeps only non-test TypeScript, and they do not read
bash. So they gave no numbers on `install.sh`. I kept its functions small by hand. `dryer --threshold 0.8` run directly on
`install-script.test.ts`: `No duplicate candidates found`. crapper was not run on the test file, as it has no production
functions. Mutator not run (Ivan's word).

## Rulings

- Ruling: a new `.env` gets an empty `HORNHOOF_PORT=` line until the ports are chosen, and `ENV_BEFORE` is not set while that
  line is there - why: `.env` is written before the pull and the lock, so a first run that stops there (a failed download, or
  the lock message, which says to run the command again) left a `.env` that looked like a company from before ports were kept.
  Its next run took 8080 by the plan's rule, wrote it to the registry although another company held it, and then failed for
  good with `Port 8080 is taken by a program outside Docker`, which breaks Review Focus 2. The line holds no port, and compose's
  `${HORNHOOF_PORT:-8080}` and `port_of` both read it as unset - cost if wrong: small. While that first run stays unfinished,
  another install sees 8080 as held by it and takes the next port.
- Ruling: `PUBLIC_URL` is written whenever this run's `.env` is new, not only when the web port is also new - why: a company
  whose folder was removed gets its port back from its registry line, so its port is not new, and the plan's condition left it
  with no `PUBLIC_URL`, which compose then sets to `http://localhost:8080`, a wrong address for any other port - cost if wrong:
  none that I can find; it writes the address the company really has.
- Ruling: `local_url` and `public` are worked out after `start_server_services`, not right after `reserve_ports` - why: the
  retry inside step 3 can move the web port, and the check would then wait on the old port - cost if wrong: none; the updater
  path returns before them either way.
- Ruling: the migrate check matches `"migrate" didn` - why: from memory, older Compose 2 says `didn't completed successfully`.
  I could not check this against a real Compose here; the test uses the plan's wording only - cost if wrong: none, the pattern
  still matches the plan's wording.
- Ruling: added `say "Port <port> is taken, so Hornhoof takes another one."` before a retry - why: Docker's error is on the screen
  and the install then goes on, which reads like a failure - cost if wrong: one line of output.
- Ruling: a failed registry read and a failed registry write have words of their own (`Could not read the list of Hornhoof's
  ports on this computer. Run this command again.`, and the same with `write`) - why: the plan names the failure, not the words -
  cost if wrong: words only.
- Ruling: a `docker create` of the lock that fails for a reason other than the name also waits out the lock's wait and ends in
  the lock message - why: the plan handles only the name being taken, and this keeps to it - cost if wrong: in a rare Docker
  failure a person waits 3 minutes and reads the wrong reason; nothing changes on disk.

## Other changes to the plan's text

- `random_hex` is new, used by `new_password`, `machine_id` and the machine id, so one line of `od` lives in one place.
- `value_in` is new, used by `env_value` and `port_of`, for reading other companies' `.env` files.
- In `leaves the built-in node and plan nodes running in server mode when the node image is unchanged`, the last check now finds
  the exact `up -d --no-build` call: its prefix also matches steps 2 and 3, which come before the node's stop. The map's row for
  2 T8 foresaw this.
- `tee` joined the test's list of system tools: `compose_step` keeps what compose says while showing it as it comes.
- New test helpers: `fromUpdater`, `computer`, `linesOf`, `portsIn`, `portRange`.
- Stub switches beyond the contract: `STUB_BIND_WORDS=address`, `STUB_REGISTRY=unreadable`, `STUB_UP_FAIL`. `STUB_BOUND_IDS`
  defaults to one id when only `STUB_BOUND_PORTS` is given, as the plan's tests give only that.
- The plan's line numbers were off as the map says: the `up` strings at +22, the `docker rm` check at :787.

## Concerns for the lead

1. **Landing order.** The map lands 2 T8 and T9 (12, 13) well before 2 T7 (25), and 2 T1 (8) is not in this lane. Until T7 lands,
   `compose.yaml` has no `keeper`, `front` or `migrate`, so this `install.sh` cannot start a real install on the branch, whatever
   the stub tests say. Nothing is shipped in between under build ruling 2, so this only matters if someone runs it for real.
2. **Whole suite.** `CLAUDE.md` wants the whole suite at once for the install and update path. Per the brief that is your run at
   landing; I did not run it.
3. **Not run.** Nothing ran on bash 3.2 or macOS: both machines are Linux. I kept to what 3.2 has and avoided nested quotes
   in expansions, but a real 3.2 run is still open. Nothing ran against real Docker or Compose (build ruling 6), so Docker's error
   words in `refused_port` and in the stub are from memory plus the plan's contract.
4. **One throwaway value printed.** Task 8's first red run printed the start of a `HORNHOOF_SECRET` from a fresh `.env` in a test's
   temporary folder, in an assertion message. It was random, from a stub run, and used nowhere. My new tests use `linesOf` so a
   failure prints one key only. Older tests with `expect(env).toMatch` can still print a whole test `.env` when they fail; I left
   them, as they are not this task's.

## Log

- A run with the handover not yet checking the revision hit the 300 s limit of my command, as each updater test slept in the
  handover until `spawnSync` gave up at 60 s. I stopped it and ran that one test alone. No vitest of this lane was left running.
  Its `sleep 300` children ended by themselves.
- The lane was refreshed at 17:20 EST, at about the moment `p2t8-final` started: `lanebase` moved from `2fdd0666` to `41a3fde2`.
  `git diff 2fdd0666 41a3fde2` is empty and my files have no conflict markers, so that run stands, and the local run of 92 came
  after it. `p2t8-task8.patch` was made against the same tree.
- Real Docker was out of reach in every run: `light.sh` and `remote.sh` guard it, and the tests' `PATH` holds only the stubs.

## Addendum: two seams from 2 T1

The change is uncommitted in the lane on top of `83c5da6e`, your commit of Task 9, so `git diff` in the lane is exactly this
addendum: `scripts/install.sh`, `apps/server/test/install-stubs/docker`, `apps/server/test/install-script.test.ts`.

**Seam 1, the helper's two inputs.** The helper already got them: `docker run -d --rm` with the socket, `$SERVER_DIR:$SERVER_DIR`,
`<project>_control:/control` and `-e HORNHOOF_SERVER_DIR=$SERVER_DIR`. `apps/updater/Dockerfile:6` makes `hornhoof-updater` the entry
point, so `--take-over` reaches the script. I ran p2t1's `updater.sh --take-over` with an empty control folder: exit 0, nothing
written, as its report says. The installer cannot see that exit, since the helper runs with `-d`. So "fails loudly" on this side
means: it waits the wait out, says `The updater of this build did not take over`, and exits 1, and the older updater goes back. The
review's line that the older updater then "stays stuck in `install` until a person acts" does not hold: `install_new` goes to
`go_back` once the wait ends.

**Seam 2, the installer returning 0 under an older updater.** It held for every revision the old updater can send, and one hole was
found and fixed. `hand_over_update` never returns: it ends in `fail`, exit 1, or is killed with its container, and a killed
installer is not 0 either. The older updater's `bash install.sh ... || return 1` therefore never reaches `drop_orphans`. The one
`return 0` under an updater in `server_mode` comes after the handover check.

The hole: `[ "${HORNHOOF_UPDATER_REV:-1}" -lt 2 ]` is false for a value it cannot read, so `x` went on as revision 2, started the
services and exited 0, the path the review feared. The check is now `older_updater_runs_this`, where only a revision readable as 2
or more goes on, so anything else hands over. An older updater does not send this variable today, so this is a guard, not a live bug.

| New test | First result |
|---|---|
| `takes an updater that does not say a revision of 2 or more for an older one` | failed for `x`: exit 0, expected 1 |
| `fails loudly when the helper exits at once and takes nothing over` | passed at once, a guard; breakages below fail it |
| `gives the helper its two folders, and waits until it replaces the updater this runs under` | passed at once, a guard; breakages below fail it |
| `starts no helper for an updater that names no server folder` | passed at once, a guard; a breakage below fails it |

The stub's `take_over_helper` follows `take_over`'s contract: it does nothing and exits 0 without the socket, the server's folder at
its own path and the control folder of the project `.env` names; with `STUB_HELPER=replaces` it kills the installer a second later,
as compose does. `.env` in that test names a project other than the folder's, so a helper given the wrong volume does nothing.

**Hand breakages, 13, all caught, each by the meant test:** dropping each of the four `docker run` inputs, the control volume named
after the folder, no wait (two tests), `return 0` after the wait, going on after the wait, unreadable revision going on, revision 2
handing over, a run by hand handing over, no `.env` check.

**Results on the final code** (`network-build/runs/remote-p2t8-seam-20261104-223516-1032986.log`): `bash -n` clean; `shellcheck` printed
nothing, exit 0; `tsc` exit 0; `typecheck:tests` exit 0; `lint` exit 0; `install-script`, `compose`, `pins`, `updater`: 4 files, 147 tests
passed; gates: no source files of `apps/server`, as before.

**Still open.**
- No test runs the real installer and the real `take_over` together: T1's tests use a fake installer and mine a fake helper, each
  following the other's contract. Both pieces meet only once they are on one branch, and a real rehearsal is not for this build.
- The default wait of 300 s is not pinned by a test; only that it waits is. It is the plan's number, against T1's 60 s for the
  `goes on` line plus the time compose takes.
- If `compose up` in the helper took over 300 s, the installer would exit 1 and the older updater would go back while the helper still
  worked, which is the race the review names. Its way out is T1's: the new updater finds the update by its note when it starts.
