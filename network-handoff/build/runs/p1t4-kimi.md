Task 4 done. Report below.

## Report

**Files changed**
- `relay/relay.py`:
  - frps watcher: daemon thread `watch_frps()` probes every 0.5 s (TCP connect to `RELAY_FRPS_BIND`, then `GET <api>/healthz` via the existing `_dash_get`, 1 s connect timeout, 0.5 s read cap), keeping `frps_ok_at` (last success) and `frps_back_at` (first success after a failure or start).
  - `relay_started()` = max(process start, `frps_back_at`, int in `RELAY_FRPS_STARTED`, 0 when unreadable); route answers and health carry it.
  - `GET /api/v1/health`: 200 `{ok: true, frps: true, relayStarted}` while the last probe is under 2 s old, else 503 `{ok: false, frps: false}`.
  - `write(sql, args)` is now the one SQLite write helper (replaces `execute_bounded`, which is deleted): busy_timeout = min(0.8 s, plugin-call time left), raises `WriteBusy` past that; a plugin call refuses with `relay error: busy`. Every write goes through it: plugin (`straighten_route`, `upsert_route`, `touch`), API (`create_binding`, `do_DELETE`), `admin`, and `init_db` (converted from `executescript` to four `write()` DDL calls).
- `relay/test/test_restart.py` (new): the four tests from the brief, all named by row id.
- `relay/test/test_route.py`: two expectations updated for the new refusal reason (see deviations).
- `relay/frps.service`: `RuntimeDirectory=frps`, `RuntimeDirectoryMode=0755`, `ExecStartPost=/bin/sh -c 'date +%%s > /run/frps/started'`.
- `relay/hornhoof-relay.service`: `EnvironmentFile=/etc/hornhoof-relay.env`.
- `relay/setup-relay.sh`: writes `/etc/hornhoof-relay.env` (0640 root:hornhoof-relay) with the five vars, reusing the password the script reads or makes today. Checked with `sh -n` and by reading; not executed.

**Tests: how they failed before the fix** (run first, as required)
- `test_r4_1_health_follows_frps`: `KeyError: 'frps'` — health answered the old `{ok: true}` body.
- `test_r2_2_generation_survives_frps_restart`: `AssertionError: 1793721674 not greater than 1793721674` — `relayStarted` was the constant process start and never moved.
- `test_r2_2_generation_survives_relay_restart` and `test_restart_burst` passed already on the old code; they guard behavior the new code must keep (generations live in SQLite; a burst produces no busy refusals), so I kept them as regression tests.

**Test commands and results**
- `python3.12 -m unittest relay.test.test_restart relay.test.test_route -v`: 30 tests OK.
- Full suite `python3 -m unittest discover -s relay/test`: 4 full runs, all 47 tests OK (three on python3 3.14, one on python3.12).
- One intermediate python3.12 run flaked: `relayStarted` is second-resolution and the whole test had run inside one second, so "moved to the restart" read equal. Fixed the test to let the second roll over before `restart_frps()` (deterministic: `before <= marked < marked+1 <= held`), then ran `test_restart` 3 more times on 3.12: all OK, plus the gate run below.
- Gates `gates-relay.sh d6a50bc` (whole suite under coverage passed, 47 tests OK): worst CRAP among this task's new/changed functions is **8.4** (`upsert_route`); all others at or below 5.0; the only scores above 10 are the grandfathered `admin` 285.4, `do_DELETE` 47.4, `create_binding` 26.2, unchanged. **Dryer: no duplicate candidates found** (no pair at 0.8+).
- No frps/frpc/relay processes left running. Nothing committed or `git add`ed, per the build lead.

**Deviations from the plan**
1. `relay/test/test_route.py` (Task 2's file) needed two edits because the build lead's note redefines a budget-exhausted write as `relay error: busy`: `test_expired_call_does_not_register` now expects that reason, and `REFUSALS` gained `relay error: busy`. Without this, a committed Task 2 test fails by the note's own ruling.
2. `write()` handles `init_db`'s DDL too (via four calls instead of `executescript`), honoring "every SQLite write goes through it".
3. The watcher's dashboard probe reuses `_dash_get` (0.5 s read cap) instead of a separate 1 s-timeout GET; it is within the plan's 1 s per-probe bound and keeps one HTTP-read helper.
4. `test_restart_burst` creates its 40 bindings by inserting into the relay's SQLite directly: the API's documented limit is 5 bindings per address per hour, so 40 from 127.0.0.1 through the API would 429. Cleanup is the Stack's `ExitStack` close, which runs on failure too.
5. The 200 health body has no `passthrough` key yet; the task's interface line for Task 4 lists the body without it and the plan assigns it to Task 9 ("false before").
