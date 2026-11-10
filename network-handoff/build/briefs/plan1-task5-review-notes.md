# What to review

Plan 1 Task 5, written by Codex in `/Users/0x/Projects/hornhoof-edge` on `main`, not committed: the change is
`git -C /Users/0x/Projects/hornhoof-edge diff 6faf6c8` plus the untracked `relay/test/test_sync.py`. The build lead's
notes to the writer said: the sync post writes through `write()`; "on disk before the answer" means committed under
`PRAGMA synchronous=FULL` before the 200; the holder check and the write take the per-name lock and the write is
guarded by the generation read. Ruling during the task: an `epoch` or `generation` above 2**63 - 1, or a JSON bool
where an integer is wanted, is 400 `invalid`. Codex reports "shared authentication extraction" (a helper shared by
the route and sync endpoints) and six extra tests.
Run Done when with the droplet's Python: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`. Then
the gates: `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh 6faf6c8`
(every function the task added or changed under CRAP 10; admin 285.4 and create_binding 26.2 not raised; no dryer pair
at 0.8 or above with new code). Look hardest at R2.4 row by row, Review Focus 2 (the sync post of the machine that
lost the race is refused), fail-closed answers (a pending row is not held for sync), and what the README now says.
