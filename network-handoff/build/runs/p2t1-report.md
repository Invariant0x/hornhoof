# Plan 2 Task 1: the updater, revision 2. Writer's report

Status: DONE_WITH_CONCERNS. The Done when passes. The concerns are the four places I went past the plan's letter (section 5), for the lead to rule on, and what could not be run here (section 6).

Lane: `/home/altera/hornhoof-network/wt/p2t1`. Nothing staged, committed or pushed. No subagents. Real Docker was never reached: every run went through `light.sh` or `remote.sh`, and the tests put the stub `docker` first on PATH.

## 1. Skills and rule files read

- Skills: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, in `plugins/superpowers/skills/<name>/SKILL.md`.
- Rules: `/home/altera/hornhoof-network/CLAUDE.md`, `AGENTS.md` and `templates/skills/dev-engineering-rules.md` in the lane, the brief `network-build/briefs/p2t1-writer.md`, and `network-build/parallel-map.md` sections 1, 3, 4, 5.

## 2. Files changed

- Created `apps/server/test/updater-rev1.sh`: the updater at `73d086ba`, with only the second line added (`diff` shows that one line).
- Modified `apps/updater/updater.sh`: `note`, `recall`, `backup`, `install`, `healthy`, `interrupted`, the start, the header comment. New: `services_of`, `names_service`, `start_app`, `project_containers`, `remove_unnamed`, `stop_installer`, `run_installer`, `health_url`, `update_running`, `read_status`, `handed_over`, `go_on_handed_over`, `go_on`, `taken_over`, `take_over`.
- Modified `apps/server/test/updater-stubs/docker`: the plan's contract, plus what section 5 lists.
- Modified `apps/server/test/updater.test.ts`: `runOnce` split into `run`, `pass`, `runOnce`, `runRev1`, `takeOver`, and a new `describe('updater, revision 2')` with 34 tests. The 36 tests there before are unchanged.

## 3. Commands and results

Fresh, on the final code:

| Command | Where | Result |
|---|---|---|
| `VITEST_MAX_WORKERS=2 npx vitest run test/updater.test.ts`, from `apps/server` | local, `light.sh` | 70 passed, exit 0, 138.94 s |
| `bash -n apps/updater/updater.sh apps/server/test/updater-rev1.sh` | local | prints nothing, exit 0 |
| The same two, plus `shellcheck 0.11.0 apps/updater/updater.sh`, `npx tsc -p apps/server/tsconfig.json --noEmit`, `npm run typecheck:tests`, `npm run lint`, `gates-hornhoof.sh lanebase server test/updater.test.ts` | `remote.sh run p2t1-checks3`, log `runs/remote-p2t1-checks3-20261104-215446-772602.log` | every step exit 0; 70 passed in 199.15 s |
| `dryer --threshold 0.8 apps/server/test/updater.test.ts` | local, `light.sh` | No duplicate candidates found |

The whole suite is the lead's run, by the brief. I did not run mutator.

The file takes longer now: 33 s for 36 tests before, 139 s for 70 now. Part of that is the new tests, part is that `run_installer` polls each second, so each install costs up to one second more. It adds nothing that shows on a real install.

## 4. Gate numbers

`gates-hornhoof.sh` printed `== no source files of apps/server in this task`: it reads `.ts` and `.tsx` outside tests, and this task changes shell and a test file. So **crapper and dryer gave no number on this task's real code, the shell**. I ran dryer by hand on the test file (above). Shell functions were kept small by hand; `update` and `computer_runs` are as they were.

## 5. Where I went past the plan, and why

Each is small and has its own test. If you rule against one, it comes out alone.

1. **Ruling: a rev 2 restart at step `backup` starts the app's container again before it starts over** (`go_on`, plan says "every other step, and a note with rev 2, as today"). Why: today that path means "nothing changed yet", but `backup()` now stops the app, so an updater killed during the copy would start over with the app down. A re-download that then fails writes `failed` and "nothing changed" with the company's app stopped and no way back running, which is a stranded install. Starting it first makes "nothing changed" true again, and `update` then reads the running build as today. The copy is still taken after a new stop. Cost if wrong: the old app runs a few seconds longer during a restart. Test: `starts the app it stopped again when it was stopped while saving the database`.
2. **Ruling: a note with empty `rev` and a copy in it at step `backup` also goes the hand-over way** (plan names step `install` only). Why: if the new updater is killed during the second copy, the status says `backup` and the note is still the older updater's. As today it would start over, which re-downloads and, with `.env` and `compose.yaml` already the new installer's, could end `failed` without writing them back. Going on keeps the note, and any failure goes back. A note with no copy in it means an older updater stopped before its own copy, so that one starts over as today. Cost if wrong: one more copy of the database. Tests: `goes on from the hand-over when it was stopped during the second copy`, `starts over when an older updater was stopped before it saved its own copy`.
3. **Ruling: the time limit kills the installer's whole process group, not only its process** (`set -m` around the start, `kill -9 -- -<pid> <pid>`; plan says "the installer's process is killed"). Why: a `docker compose up` the installer started would live on after its parent and could go on starting the new build while the old one goes back. Plain `kill` is still in the same command, so if `set -m` ever does not take, the installer itself dies and `wait` cannot hang. Cost if wrong: none seen on Linux; see section 6 for what was not run. Test: `stops what a hung installer started, too`.
4. **Ruling: the line `This build's updater goes on with the update.` is written to `status.json` at once**, with `step install "..."`, before `applied` (the plan's text has `say`, which only fills memory). Why: `applied` may wait up to 120 s for a slow database, while the helper waits 60 s for that line and would otherwise send the update back. Cost if wrong: one more status write. Test: `says it goes on before it asks the database anything`.

Smaller ones:

- Ruling: the fixture comes from `git show 73d086ba:apps/updater/updater.sh`, since this lane has no `main`. Why: `parallel-map.md` says main is 73d086ba, and `git diff 73d086ba lanebase` on the updater files is empty. Cost if wrong: none.
- Ruling: a failed `compose stop app` is ignored and the dump goes on, as `restore` already does. Why: the plan is silent; such a copy is what today's updater takes, and nothing strands. Cost if wrong: on that rare failure the copy may miss the last changes, as today.
- A failed second copy also says `Could not save the database again.` before `go_back`, so the log tells why it goes back.
- `drop_orphans` now calls the shared `names_service`, and `services_without_node` the shared `services_of`, as `parallel-map.md` section 4 asked. No behaviour change; the old tests pin it.
- Stub beyond the contract: the hand-over path also writes `.env`, as the real installer does, so `.env has HORNHOOF_VERSION=0.4.0` proves the old installer wrote it back; `STUB_RM_FAILS`; `STUB_UPDATER_UP=never`; `hung-child` and `status-when-asked` files; a small `word` helper shared by the lookups.
- Tests beyond the plan's list: `keeps its revision in the note of the update`, `leaves the app alone when it was stopped before the copy began`, `looks for those containers in the compose project of this server`, `leaves alone a container that has no service, and one of a service the build names`, `says so and goes on with the install when a container cannot be removed`, `asks the address it was given, when it was given one`, `says what to do by hand when the install on the way back hangs too`, `goes back when the installer fails, without waiting out its time`, `finishes the move-in under the new updater when the new build answers`, `goes back when the second copy of the database fails`, `goes on with the copy it has when the new build changed the database already`, `copies the database once when it was stopped during an install it began itself`, `goes back under this build's updater too, once the helper marked the way back`, `goes back the same way when this build's updater starts but never takes the update`, `says what to do by hand when no updater can start`, `waits for the new updater to say it goes on`, `does nothing when there is no status at all`.

Facts checked against the code: the plan's `updater.sh` cites hold. `updater` in `compose.yaml` has no healthcheck, so `--wait` returns as soon as it runs and proves little; the line in `status.json` is the real proof, as the plan has it. `compose.yaml` does not set `HORNHOOF_HEALTH_URL`, so `health_url` decides in production.

For Task 8: the helper needs `HORNHOOF_CONTROL_DIR` or `/control` mounted, and `HORNHOOF_SERVER_DIR` set with that folder mounted at the same path, or `take_over` exits 0 and does nothing. `HORNHOOF_UPDATER_REV` is exactly `2`.

## 6. What I could not do

- **Not run on macOS bash 3.2 or Alpine's bash.** Everything ran on Debian's bash 5.2 and the test machine's image. The plan's tests are meant to pass on 3.2. `set -m`, `<<<` and `kill --` should be there on 3.2 from what I know of it, but I did not see it. `set -m` as PID 1 in the Alpine updater image without a terminal has not been seen either, and the rehearsal is not for this build (ruling 2).
- **Everything about Docker is the stub's word.** `docker ps --format '{{.Label ...}}'`, `compose ps -aq`, `compose stop migrate app` and `compose up --wait` follow the plan and what I know of Docker, not a run. One to know: on the way back `compose stop migrate app` runs against the old file, which names no `migrate`. Real compose may refuse the whole command, leaving `app` running; that path ends in `Could not go back` anyway, and the failure is ignored.
- crapper and dryer give no number on shell (section 4).

## 7. How each test failed before the code

Run `-t "revision 2"` with the stub and fixture in place and `updater.sh` untouched: 23 failed, 8 passed.

Failed for the plan's reasons:

| Test | Failure | Reason |
|---|---|---|
| `tells each build's installer...` | line lacks `HORNHOOF_UPDATER_REV=2` | no revision |
| `keeps its revision in the note...` | undefined, wanted `'2'` | no revision |
| `stops the app before it saves...` | `-1`, no `compose stop app` | no stop before the copy |
| `starts the app it stopped again...` | `-1`, no `docker start appcid` | no start on restart |
| `removes the containers of services...` | `-1`, no `docker rm -f c-tunnel` | no removal |
| `looks for those containers...` | no `docker ps -a --filter` | no removal |
| `says so and goes on...` | no such line in the log | no removal |
| `goes back to a build from before front...` | state `failed`, old installer hit the bind error | no removal |
| `checks health at front...` | first `failed` as above; once removal existed, `curl ... http://app:8080` lacks `http://front:8080/api/health` | no removal, then health always at the app |
| `moves in by handing over...` | first no `goes on` line; once take-over existed, `http://app:8080` as above | no take-over, then health |
| `finishes the move-in...`, `goes back when the second copy...`, `goes on with the copy...`, `goes on from the hand-over...` | status stayed `running` | no take-over |
| `stops an installer that does not end...`, `says what to do by hand when the install on the way back hangs too` | still `running` at the 30 s kill | no time limit |
| `stops what a hung installer started, too` | child still alive | no time limit |
| `brings the older updater back...`, `changes nothing once...`, `does nothing unless...`, `does nothing when there is no status at all` | exit code null, killed at 30 s or by the hand-over, as `--take-over` was not known | no take-over |
| `goes back the same way...`, `says what to do by hand when no updater can start` | no `--wait` call, state not `failed` | no take-over |

Passed before the code, on purpose, as guards of what must stay so: `leaves the app alone when it was stopped before the copy began`, `leaves alone a container that has no service...`, `removes nothing when the build's compose file names no updater` (the plan's), `asks the address it was given...`, `goes back when the installer fails...`, `copies the database once...`, `stays on the old build, working, when the new installer cannot start the hand-over helper` (the plan's; it runs the fixture only, and proves the stub and fixture).

`waits for the new updater to say it goes on` passed in that run for a wrong reason: the old script's own hand-over killed it, so the test proved nothing. I added the assertion that the line is in the log. That edit and `starts over when an older updater...` went in together with the code, and `goes back under this build's updater too...` and `says it goes on before it asks the database anything` came after it, so these four were not seen red against the old script. For those four, and for four more key behaviours, I broke the code by hand, saw the test fail, and restored it (`cmp` said identical):

| Broken by hand | Test that failed |
|---|---|
| `taken_over` does not wait | `waits for the new updater to say it goes on` |
| `handed_over` without its check of the copy | `starts over when an older updater...` |
| `handed_over` without its check of the step | `goes back under this build's updater too...` |
| the line only by `say` | `says it goes on before it asks the database anything` |
| group kill replaced by a plain kill | `stops what a hung installer started, too` |
| `start_app` line of `go_on` removed | `starts the app it stopped again...` |
| `backup` not handed over | `goes on from the hand-over...` |
| `compose stop app` removed from `backup` | `stops the app before it saves...` |

## 8. Log of what I did and why

1. Read the brief, skills, rules and map, then `updater.sh`, the test, the stubs, `compose.yaml`, and `install.sh`'s start and `.env` code, to check the plan's facts.
2. Ran the test file for a baseline: 36 passed in 33 s. Tried a process group kill in a throwaway script before relying on it.
3. Wrote the fixture and the stub; the 36 old tests still passed on the new stub.
4. Wrote the tests, ran them, read each failure (section 7). One cleanup command of mine (`pkill -f`) matched its own shell and ended it; I found nothing stray with a safer pattern.
5. Wrote the code with `health_url` held back, and saw exactly the two health tests fail for that reason. Then wrote `health_url`: all green.
6. Read my own diff against the plan, line by line. Found and fixed: a test assertion that `-1` passed, a `wait` that could hang if the group kill missed, and a `< /dev/null` that changed nothing.
7. Broke the code by hand as in section 7, then ran the final checks in section 3.
