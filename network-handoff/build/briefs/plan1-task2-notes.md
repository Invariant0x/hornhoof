# Notes for this task from the build lead

- Work in the relay repo `/Users/0x/Projects/hornhoof-edge`, branch `main`. Task 1 is committed (HEAD 9c83be0).
  Do not `git add`, do not commit: the build lead commits after review. Step 5's commit is the build lead's.
- Run the relay tests with `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` (the droplet's
  Python) and with `python3`. Leave no frps/frpc/relay process running when you finish.
- Gates, after the Done when passes: run
  `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh 9c83be0`.
  It runs the whole relay suite under coverage (relay.py measured in the processes the harness starts), then crapper
  and dryer on this task's .py files, and prints both reports. Rules:
  - Every function this task adds or changes scores under CRAP 10. Bring it under by splitting it into smaller
    functions, by testing it through the relay's behavior, or both.
  - Old functions this task only touches may keep their old score if the task does not raise it. Today's scores:
    `admin` 285.4, `Handler.do_DELETE` 96.4, `Handler.create_binding` 26.2, `plugin` 16.4. `plugin` is where
    `NewProxy` lives: do not raise its score; put the new NewProxy rules in new small functions it calls.
  - `harness.Stack.plugin_calls` (23.2 at Task 1, no caller yet) gets callers in this task: it must end under 10.
  - dryer: no pair at 0.8 or above that involves code this task added.
  - Do not write into the gate script's folder; it writes `.metrics/` and `target/` in the relay repo (git-ignored).
  - Report both results (the worst CRAP among the task's new or changed functions, and dryer's pairs) at the end.
