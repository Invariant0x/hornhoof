# Notes for this task from the build lead

- Work in the relay repo `/Users/0x/Projects/hornhoof-edge`, branch `main`. The tasks before this one are committed
  (HEAD 6faf6c8). Do not `git add`, do not commit: the build lead commits after review. The task's "Commit" step is
  the build lead's.
- Run the relay tests with `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` (the droplet's
  Python) and with `python3`. Run the whole suite twice at the end to catch flakes. Leave no frps/frpc/relay process
  running when you finish.
- relay.py today (after Task 2): every plugin call has one 1 s budget (`PLUGIN_CALL_S`, `call_deadline()`); the
  per-name lock (`hold_route_lock`), each dashboard read (`_dash_get`, min(0.5 s, time left)) and each write
  (`execute_bounded`) draw from it, and a spent budget refuses with `relay error: frps does not answer`. Keep every
  new blocking step inside a plugin call on that budget. Trace and log lines go through `log_line` (one atomic write).
- Gates, after the Done when passes: run
  `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh 6faf6c8`.
  It runs the whole relay suite under coverage (relay.py measured in the processes the harness starts), then crapper
  and dryer on this task's .py files, and prints both reports. Rules:
  - Every function this task adds or changes scores under CRAP 10. Bring it under by splitting it into smaller
    functions, by testing it through the relay's behavior, or both.
  - Old functions this task only touches may keep their old score if the task does not raise it. Scores now:
    `admin` 285.4, `Handler.create_binding` 26.2; every other function is under 10.
  - dryer: no pair at 0.8 or above that involves code this task added.
  - The gate script writes `.metrics/` and `target/` in the relay repo (git-ignored); write nothing into its folder.
  - Report both results (the worst CRAP among the task's new or changed functions, and dryer's pairs) at the end.
- A test that would still pass with the code wrong is not a test: check each new test fails for the reason you expect
  before the fix, and say how it failed in your report.
- After Task 4: `write(sql, args)` is the one SQLite write helper (bounded by the plugin call's budget inside plugin
  calls, `relay error: busy` there, 503 `{error: 'busy'}` with `Retry-After: 1` on API paths). The sync post writes
  through it. "On disk before the answer" means the write has committed under `PRAGMA synchronous=FULL` before the
  200 is sent.
- The sync post's holder check reads frps (`route_of` under the per-name lock, Task 2): take the same lock for the
  check and the write, so a registration cannot slip between them, and guard the write by the generation read.
- Files holding a secret are written only through `write_private` (relay/private-file.sh), if this task writes any.
