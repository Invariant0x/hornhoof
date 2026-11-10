# Notes for this task from the build lead

This is the end of Task 7, not its start. A previous writer finished its code; it is uncommitted in the working tree of
`/home/altera/hornhoof-network/hornhoof-edge` on top of bd24cc1 (`relay/relay.py`, `relay/hornhoof-relay`, new
`relay/test/test_keys.py`, and the approved fixture edits in `relay/test/test_route.py` and `relay/test/test_sync.py`).
Keep all of it. Read `network-build/runs/p1t7-codex-detail.md` for what was done, and the ledger
`network-build/progress.md` for every ruling that stands. 140 tests pass on Python 3.12 and 3.14 right now. Do not stage
or commit. The lead commits after review.

Two gates are not met. Close them, and nothing else:

1. **The mutator cannot see the relay yet.** mutator runs each mutant in a worker tree that holds a private copy of
   `relay/relay.py` with everything else symlinked. `relay/test/harness.py` has `ROOT = Path(__file__).resolve().parents[2]`,
   so inside a worker it follows the symlink, starts the ORIGINAL relay.py, and every mutant survives falsely. Reproduce
   this first: pick one changed line that a test in test_keys.py surely kills (`relay/relay.py` `name_live`'s `==`), run the
   mutator on that line, and see the mutant survive. Then fix it so that a worker's own copy runs (`.absolute()` in place
   of `.resolve()` in harness.py's ROOT and BIN is the likely smallest change; grep `relay/test/` for other uses of
   `resolve()` that load relay.py). Run the same line again and see it killed. That is this fix's test. Nothing else
   about the harness changes. Report both runs.
2. **`Handler.create_binding` scores CRAP 16.6 and this task changed a line of it.** CLAUDE.md: every changed function
   under 10. Split it into small functions with names that say what they do, behavior unchanged (refactoring: the
   existing tests pin it; run them before and after). Keep the order of its checks, its error bodies and status codes
   exactly. `admin` (17.3) is not changed by this task; leave it.

Then the mutator on the task's changed lines. Commands, from anywhere:

- Coverage and CRAP and dryer: `/home/altera/hornhoof-network/network-build/gates-relay.sh bd24cc1` (it runs the whole relay
  suite under coverage, about 8 minutes, and writes `target/coverage/python/lcov.info`). Start it through
  `network-build/heavy.sh`. Scores of every function you add or change must be under 10; dryer must find no pair at 0.8.
- Mutator: `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof-edge bd24cc1 relay/relay.py '/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12 -m unittest relay.test.test_keys'`.
  About 75 s per mutant with two at once. It needs the coverage file above. If a mutant on a changed line is only reached
  by another test module, add that module to the test command for that run, for example `relay.test.test_peers`.
- A survivor is killed by a new test in `relay/test/test_keys.py` (see it fail first), or, if it is truly equivalent,
  listed in your report with why, for the lead to rule on in the ledger. An uncovered site on a changed line is covered by
  a test the same way. Add no test that only exercises a line without checking what a person of the relay would see.
- Python 3.12: `/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`. 3.14:
  `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`. At the end run the whole
  suite on 3.14 through heavy.sh: `python3.14 -m unittest discover -s relay/test -v`, from the repo root.
- Never print a generated key; tests compare with booleans and fixed messages. Leave no frps, frpc or relay process running.
- The report file: `/home/altera/hornhoof-network/network-build/runs/p1t7-gates-report.md`. Give the mutator's totals (killed,
  survived, uncovered), each survivor and what you did about it, the worst CRAP among changed functions, dryer's result.
