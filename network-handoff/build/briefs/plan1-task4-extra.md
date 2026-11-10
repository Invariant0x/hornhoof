- Task 2 already has a bounded write helper, `execute_bounded`, on the plugin call's 1 s budget. This task's
  `write(sql, args)` is the one write helper for the plugin and the API: build it from `execute_bounded` (one
  decision in one place, no second helper), retrying `database is locked` for up to min(0.8 s, time left) inside a
  plugin call, then refusing with `relay error: busy`. Every SQLite write goes through it, `touch()`'s
  `bindings.last_seen` update included.
- `test_restart_burst` starts 40 frpc processes: keep it to what the Stack can clean up, and make sure every process
  stops when the test ends, also when it fails.
- `setup-relay.sh` and the unit files run only on the droplet. Do not run them here; check them with `sh -n` and by
  reading. No real address or password goes into them: the password is the one the script reads or makes today.
