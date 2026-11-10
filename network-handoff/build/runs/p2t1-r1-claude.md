# Plan 2 Task 1, review round 1 (Claude)

Change: `network-build/runs/p2t1-r1.diff`, lane `wt/p2t1`, against `lanebase`. Read only; no file in either repository touched.

## Counts

Critical: 0. Important: 0. Minor: 6. The four rulings the writer asks for: all four hold, see below.

## What I checked, and how

- Focused run, `light.sh npx vitest run test/updater.test.ts -t "revision 2"` from `apps/server`: 34 passed, 36 skipped, 64.9 s, exit 0.
  The writer's remote log `runs/remote-p2t1-checks3-20261104-215446-772602.log` shows `== shellcheck` exit 0 and 70 passed; I did not rerun shellcheck (not installed here).
- Fixture: `diff <(git show lanebase:apps/updater/updater.sh) apps/server/test/updater-rev1.sh` is exactly the one comment line the plan asks for.
- bash 3.2 and Alpine: grep for `mapfile`, `declare -A`, `${x,,}`, `${x^^}`, `&>>`, `|&`, `;;&`, `;&`, `coproc`, `+=`, `[[`, negative substrings, `printf -v`, `read -a` in `updater.sh`, the stub and the fixture: none. What is used (`<<<`, `set -m`, `kill -- -pgid`, `kill -0`, `wait pid`, `${!#}`) is in bash 2.05b/3.2. `set -m` in a non-interactive shell: tried a script with `set -m; (...)&; set +m; kill -9 -- -$p $p; wait`: the group dies (wait 137, the grandchild gone), and no `[1]+ Done` notices reach stderr (bash 5.2 here; the code path is the same in 3.2 but I did not run 3.2).
- Plan nodes: `install.sh:404` starts them with `docker run --label hornhoof.subscription=... --label hornhoof.server=...` and no compose project label, so `project_containers` never lists them and `remove_unnamed` cannot touch them. The `hornhoof-computer-<id>` containers are `docker create --name` with no compose label: the same.
- `project_containers`'s project: `install.sh:836-844` has written `COMPOSE_PROJECT_NAME` into `.env` since the commit that added the updater (`e00946fe`), so every install with an updater has it; the fallbacks in the plan are not reached on a real install.
- The Interfaces, one by one against the code: `HORNHOOF_UPDATER_REV=2` (`run_installer`), `rev` in `note`/`recall`, `backup` (ps -q before stop, dump, `docker start` on failure, same message), `remove_unnamed` (updater guard, project label, format, never service `updater`, one `say` on failure), `install` (background, `${HORNHOOF_INSTALL_WAIT:-900}`, `compose stop migrate app`, kill, the exact line, no `drop_orphans` on failure), `health_url`, `interrupted` on an empty `rev`, `take_over` (exit 0 unless running/install with a note, `--wait`, the line within `${HORNHOOF_TAKE_OVER_WAIT:-60}`, `running rollback`, `HORNHOOF_UPDATER_REF=<back.updater>`, the `failed` text): all match. Every test the plan lists by name is present and asserts what the plan says; `indexOf`/`findIndex` of -1 fails every ordering assertion, so none passes with the code wrong.
- Em dashes, private data in the four files and the diff: none. No secret value printed anywhere.
- The paths a person could get hurt by: new build never answers (restore from the copy taken with the app stopped, front/keeper/migrate removed before the old installer, health at app): covered and tested. Installer hangs forward and back: tested, the group kill leaves no child (`process.kill(child, 0)` throws ESRCH). Restart at pull/backup/install/health/rollback under rev 2: `go_on` with ruling 1 for backup. Rev 1 note at install and backup: `handed_over`. Rev 2 updater installing a rev 1 build (the way back): `remove_unnamed` plus health at app, tested. Copy skipped only when `applied` differs from `before`, i.e. the new build already migrated, when the older copy is the right one.

## Findings

### Minor

1. `apps/updater/updater.sh:601-604` (`interrupted`): with a `running` status at step `backup` and a note `recall` cannot read, the update ends `failed` with "Check that Hornhoof answers" and the app's container stays stopped, since revision 2 stops it before the copy and nothing here starts it. Today that path left the app running. Needs the note gone while status says running (a person deleting `backups/update.json`, or `HORNHOOF_SERVER_DIR` wrong in the new compose), so rare. A `start_app "$(compose ps -aq app ...)"` before that `stop_with` would make the message true.

2. `apps/updater/updater.sh:629-632` (`take_over`): the line and the old updater's start are not one step. If the new updater writes `This build's updater goes on with the update.` right as the 60 s run out, the helper still writes `running rollback` and brings the old updater back, which kills the new one mid-copy; the old one then reads whatever step the new one wrote last (`backup` or `install`) and starts over or hands over again, with the app stopped by the new one. A recheck of the line after `write_status`, or a second look before the old updater's `compose up`, would narrow it. Plan-level design; one extra copy or one more hand-over if it bites, no data lost since the copy from before is still on disk.

3. `apps/updater/updater.sh:568` (`go_on_handed_over`): `applied` returns empty when the database does not answer within 120 s, and empty differs from `before`, so the second copy is skipped and the install goes on with the older updater's copy, taken while the app worked on. If that install then fails, `go_back` restores that older copy and the writes between the two are gone. Needs the database down right after the hand-over, which this build's installer does not touch, so unlikely; treating an empty `applied` as "take the copy" (or stopping) would close it.

4. `apps/updater/updater.sh:340` (`stop_installer`): `compose stop migrate app` runs against the compose file in the server folder. On the way back that is the old file, which names no `migrate`, and compose v2 refuses the whole command for an unknown service, so `app` is not stopped before the kill. The writer noted it; the path ends in "Could not go back" and the person is told to run `install.sh server`. One `compose stop app` beside it, or stopping only the services `names_service` finds, would make it do what it says on both ways.

5. `apps/updater/updater.sh:585` (`go_on`): `compose ps -aq app` may print several ids when an extra `app` container exists (a `compose run` left behind); `start_app` then passes them as one argument and `docker start` fails, ignored, so the app is not started before the update starts over. Edge; `head -n 1` or a loop fixes it.

6. `apps/server/test/updater.test.ts`, the hand-over tests (`handedOver`): the fixture is killed by the stub installer (`kill -9 $PPID`) before `rm -rf "$WORK"`, so each such test leaves one `mktemp -d` folder in the OS temp dir, as the `stand()` folders already do. Test hygiene only.

## The four rulings

1. Restart at step `backup` starts the stopped app first (`go_on:585`). Holds. Without it, "nothing changed" after a failed re-download is false with the company's app down, and nothing is left running that would start it. Cost as the writer says: the old app runs for the seconds between the start and the next stop. Test `starts the app it stopped again when it was stopped while saving the database` pins it.

2. A rev 1 note with a copy at step `backup` goes the hand-over way (`handed_over:560`). Holds. The rev 2 updater writes `backup` only inside `go_on_handed_over`, after the hand-over, so a rev 1 note at `backup` with a copy means the new updater died in its second copy; starting over would re-download with `.env` and `compose.yaml` already the new installer's, and a failed download would then end `failed` without writing them back. The no-copy case keeps today's path, and the test for it is there. Cost: one more dump.

3. The time limit kills the installer's process group (`run_installer:351-355`, `stop_installer:341`). Holds, and is needed: a `docker compose up` the installer started would otherwise live on and start the new build while the old one goes back. `set -m` is on only around the fork, bash gives no terminal to an async job and prints no job notices in a non-interactive shell; the plain pid is in the same `kill`, so `wait` cannot hang if the group kill ever misses. Not seen on bash 3.2 or as PID 1 in the Alpine image; the mechanism is the same there. Test `stops what a hung installer started, too` pins it.

4. The line goes to `status.json` before `applied` (`go_on_handed_over:567`, `step install "$TAKEN_OVER"`). Holds. The helper reads the line from `status.json`'s `log`, so the plan's `say` alone could never reach it, and `applied` may wait 120 s against the helper's 60. The plan's letter is inconsistent with itself here; the writer read it the only way that works. Test `says it goes on before it asks the database anything` pins it.

## For the lead and Task 8

- `take_over` assumes the rev 1 installer, having started the helper, waits until compose replaces its updater (the stub models it as `kill -9 $PPID`). If Task 8's installer returned 0 instead, the rev 1 updater would go on: `drop_orphans` with the new compose file (`--remove-orphans db` recreates db with the new settings and removes `tunnel` while the old app runs), then 120 s of health at `app:8080`, then `go_back`, racing the helper's swap. Worth a line in Task 8's brief: the hand-over installer blocks until it is killed, and exits 1 only when the helper could not start.
- `take_over` needs `HORNHOOF_CONTROL_DIR` (or `/control`) and `HORNHOOF_SERVER_DIR` with the folder mounted at the same path in the helper, as the writer's report says; otherwise it exits 0 and does nothing, and the rev 1 updater stays stuck in `install` until a person acts.
- Gates: crapper and dryer give no number on shell (the gate reads `.ts` only); the functions are small by reading and the duplication the parallel map warned about (`config --services`) is shared through `services_of`. Dryer on the test file: no pair, per the writer; I did not rerun it.
