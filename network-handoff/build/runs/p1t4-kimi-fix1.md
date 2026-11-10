All items fixed. Report below.

## Fix report (Plan 1 Task 4 review)

**Fix A — secret files created world-readable**
- New `relay/private-file.sh`: `write_private <dest> <mode> [group]` takes content on stdin, removes a stale temp, creates the temp with `(umask 077 && : > "$tmp")`, writes, `chgrp`/`chmod`, then `mv -f` over the destination (mode preserved); prints `changed`/`unchanged` and leaves an equal destination untouched.
- `relay/setup-relay.sh` sources it (`# shellcheck source=private-file.sh`) and uses it for both `/etc/frp/frps.toml` (640 frps, result feeds `restart_frps`) and `/etc/hornhoof-relay.env` (640 hornhoof-relay). Nothing else changed.
- Tests `relay/test/test_setup.py`: `test_temp_file_is_private_while_the_content_arrives` — written first against the naive helper (`cat > "$dest.new"`), failed as expected with `AssertionError: 36 != 0 : the temp file is readable by others: 0o644`; passes after the fix (temp is 0600). Also `test_unchanged_content_keeps_the_destination`, `test_unchanged_content_keeps_the_inode`, `test_shell_files_parse`. `shellcheck` line in `.github/workflows/tests.yml` now includes `relay/private-file.sh` (shellcheck itself is not installed on this machine; `sh -n` passes and the helper is plain POSIX sh).

**Item 2 — expired budget still ran the SQL** — test `test_write_refuses_before_executing_when_the_call_budget_is_spent` (failed before: `AssertionError: WriteBusy not raised`, and the row existed). Fix: `write()` raises `WriteBusy` before executing when the plugin call has no time left.

**Item 3 — `touch()` swallowed `WriteBusy`** — test `test_login_refuses_busy_when_the_write_lock_is_held` (failed before: Login answered `{'reject': False, 'unchange': True}` after 0.8 s on a locked DB, `last_seen` untouched). Fix: `touch()` lets `WriteBusy` propagate; `plugin()` converts it to `{'reject': True, 'reject_reason': 'relay error: busy'}` in one place.

**Item 4 — API write paths dropped the connection** — test `test_busy_write_answers_503_instead_of_dropping_the_connection` (failed before: `http.client.RemoteDisconnected` on both POST /bindings and DELETE /bindings/acme). Fix: `Handler.handle_one_request` catches `WriteBusy` and answers 503 `{error: 'busy'}` with `Retry-After: 1`. This override was chosen deliberately so the grandfathered `do_DELETE`/`create_binding` keep their CRAP scores (do_DELETE actually improved to 9.6 via the new test's coverage).

**Item 5 — watcher probe used 0.5 s** — test `test_watcher_takes_a_slow_good_healthz_answer` (failed before: `frps_answers()` returned False on a good 0.7 s answer). Fix: `_dash_get(path, cap=0.5)` gained a timeout parameter (same read helper, no second one); the watcher passes `cap=1.0`.

**Item 6 — restart test sampled the API, not company traffic** — `test_r2_2_generation_survives_relay_restart` now runs a traffic sampler on `stack.get('acme.hornhoof.org')` alongside the route sampler and requires every answer to be 200 throughout the restart. The down window is now also measured deterministically from the main thread (split stop + `refuse_route_calls` + start) instead of hoping a 0.2 s sampler lands inside a ~0.1 s window. This mattered: the coverage run flaked exactly there, and the samplers sometimes never got scheduled into the window at all. Samplers now sample before waiting and signal a `started` event the main thread awaits, so sampling genuinely spans the restart.

**Item 7 — busy assertion could not see busy refusals** — `test_restart_burst` now asserts on the trace directly: every one of the 40 clients has a post-restart NewProxy (`registered == expected`) and no plugin call after the restart was rejected; the log scan for `relay error: busy` is kept as a secondary check.

**Item 8 — health bounds** — `test_r4_1_health_follows_frps` now requires 503 within 2 s of `stop_frps()` (was 3 s); the 3 s bound for coming back up is unchanged.

Note on items 6 to 8: the code was already correct there, so the strengthened assertions pass on the pre-fix code as well; they are test-side fixes, as the findings framed them.

**Final verification**
- `python3.12 -m unittest discover -s relay/test`: two full runs, 55 tests OK each; `python3`: one full run, 55 tests OK. `test_restart` additionally run 3× after the sampler fix.
- `sh -n relay/setup-relay.sh relay/private-file.sh`: OK.
- Gates `gates-relay.sh d6a50bc`: whole suite under coverage passed (55 tests OK); worst CRAP among this task's new/changed functions is **8.4** (`upsert_route`; `write` is 6.0 after item 2, everything else at or below 4.0); grandfathered scores unchanged (`admin` 285.4, `create_binding` 26.2, `do_DELETE` 9.6). **Dryer: no duplicate candidates found.**
- No frps/frpc/relay processes left running; no em dashes; nothing committed or `git add`ed.
