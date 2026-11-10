# What to review

Plan 1 Task 3, written by Codex in `/Users/0x/Projects/hornhoof-edge` on `main`, not committed: the change is
`git -C /Users/0x/Projects/hornhoof-edge diff dc70994` plus the untracked `relay/test/test_eviction.py`. Codex reports
eviction measured at 20.16 to 20.46 s, bound kept at 30 s, and a measured-times comment in relay.py beside
`EVICTION_BOUND_S` (Step 4 asks for it; the Files list does not name relay.py).
Run Done when with the droplet's Python: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` from
the relay repo root. Then the gates:
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh dc70994`
(gate rules: every function the task added or changed under CRAP 10; no dryer pair at 0.8 or above with new code).
Look hardest at: do the tests prove R3.1 and R3.2 (would they pass with heartbeatTimeout = 90 and keepalive 30, as
Step 2 says they must fail?), Review Focus 4 (a today's tunnel idle for minutes is not dropped), and whether the
frps.toml comment says what is true. Report the gate results with your findings.
