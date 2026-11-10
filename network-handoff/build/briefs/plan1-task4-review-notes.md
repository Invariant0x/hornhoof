# What to review

Plan 1 Task 4, written by Kimi in `/Users/0x/Projects/hornhoof-edge` on `main`, not committed: the change is
`git -C /Users/0x/Projects/hornhoof-edge diff d6a50bc` plus the untracked `relay/test/test_restart.py`. The build
lead's note to the writer said: "`write(sql, args)` is the one write helper for the plugin and the API: build it from
`execute_bounded`, retrying `database is locked` for up to min(0.8 s, time left) inside a plugin call, then refusing
with `relay error: busy`. Every SQLite write goes through it, `touch()`'s `bindings.last_seen` update included."
Run Done when with the droplet's Python: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` from
the relay repo root. Then the gates:
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh d6a50bc`
(every function the task added or changed under CRAP 10; old ones not raised: admin 285.4, do_DELETE 47.4,
create_binding 26.2; no dryer pair at 0.8 or above with new code). Look hardest at Review Focus 1 and 3, whether
`relayStarted` is right in every case the plan names, and the setup script and unit files (they run only on the
droplet: read them and `sh -n`, never run them).

The writer reports these deviations; judge each on its merits:
1. test_route.py (Task 2's file): `test_expired_call_does_not_register` now expects `relay error: busy`, and
   `REFUSALS` gained `relay error: busy`.
2. `init_db`'s DDL goes through `write()` (four calls instead of `executescript`).
3. The watcher's dashboard probe reuses `_dash_get` (0.5 s read cap) instead of a separate 1 s-timeout GET.
4. `test_restart_burst` creates its 40 bindings by inserting into the relay's SQLite directly, because the API allows
   5 new bindings per address per hour.
5. The health body has no `passthrough` key yet (Task 9 adds it).
6. `test_r2_2_generation_survives_relay_restart` and `test_restart_burst` passed on the old code too; kept as
   regression tests.
