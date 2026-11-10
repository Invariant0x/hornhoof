Second review of Plan 1 Task 2 (Codex checked your fixes: items 2 to 5 are fixed with honest tests). Four Important
findings remain; the build lead accepts all four. Same rules: a test that fails on the current code first, then the
fix; no commit, no `git add`. Report each with its test name and how it failed.

1. relay.py:288, the per-name lock has no deadline. A registration waiting behind one route read took 1.414 s with
   each dashboard read at 0.35 s. Global Constraints and Review Focus 3: no plugin call takes over 1 s, and a timeout
   refuses the op. Give each plugin call one deadline of 1 s from when it starts: the lock is acquired with the time
   left, each dashboard read uses min(0.5 s, time left), and running out refuses with `relay error: frps does not
   answer` (the same fail-closed refusal). A route read through the API may use its own deadline the same way (503
   `unknown` on expiry). Test: hold the name's lock from the test (or make the fake dashboard slow) and show a NewProxy
   is refused in under 1 s instead of waiting.
2. test_route.py:44, the race helper knows only "started" and "router config conflict" as outcomes; a client refused
   with the valid fail-closed `relay error: frps does not answer` made the suite fail in the reviewer's run
   (`test_r1_1_race_after_empty`). Track each client's first outcome, any refusal reason included, and match the
   trace records to clients by client id. The asserts stay: exactly one started, generation grew by the number of
   NewProxy records let through (one), every NewProxy under 1000 ms.
3. test_route.py:105, the young-pending-plus-offline regression passed the old code (it depends on scheduling). Add a
   controlled test with the fake dashboard: a `pending` row younger than PENDING_S, the dashboard answering `offline`
   with another clientID: the route reads `held`, a NewProxy is refused with `router config conflict`, and the
   generation does not move. It must fail on the deviation-1 code (`offline` emptied a young pending row).
4. test_route.py:88, the race tests do not reliably expose interleaved trace lines. Add a synchronized concurrent
   trace test: many threads released at once (a `threading.Barrier`) each emit one trace record through the real
   trace function with stdout captured; every line must parse as one complete JSON record, one per call. It must fail
   on a plain `print(...)` per record.

Then the whole relay suite twice with `/opt/homebrew/bin/python3.12` and once with `python3`, and the gates
(`.../gates-relay.sh 9c83be0`), reporting both as before.
