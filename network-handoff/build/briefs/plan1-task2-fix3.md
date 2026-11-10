Third review of Plan 1 Task 2 by Codex; the build lead accepts all four. The controlled pending test is good, Login
and Ping are untouched, no deadlock. Same rules: failing test first, then the fix; no commit, no `git add`.

1. Critical, relay.py:324: an expired call still registers. Only the lock wait checks the budget; the reviewer
   reproduced a NewProxy let through, with the generation moved, after 1.105 s and 1.272 s. Apply the time left to
   every blocking step of a plugin call: each dashboard read gets min(0.5 s, time left) and refuses at once when
   nothing is left; SQLite waits inside a plugin call are bounded by the time left too (for example a per-call
   `PRAGMA busy_timeout` or a check around the write); and check the budget once more right before the upsert:
   expired means refuse with `relay error: frps does not answer` and no row change. One helper owns "time left";
   every step asks it.
2. Important, test_route.py:423: the deadline tests allow 1.6 s, so a 0.7 s lock wait plus a 0.5 s read passes.
   Assert under 1.1 s, and add a test where every step would succeed but the dashboard's (otherwise good) answer
   arrives after the budget ran out: the NewProxy is refused and the generation does not move.
3. Important, test_route.py:142: both race tests still require each refusal to be `router config conflict`. Accept
   the documented fail-closed `relay error: frps does not answer` as a refusal too, keeping one winner, the
   generation and the per-client trace checks.
4. Important, test_route.py:430: the barrier test passes plain `print`. Make interleaving happen: capture stdout with
   a writer whose `write` hands over to the other threads between calls (for example it waits on a shared barrier or
   event after each partial write), so `print` (two writes) interleaves. The reviewer's probe this way gave 0 valid
   records with plain print and 16 with your writer. Show the test failing on plain print.

Then the whole suite twice with `/opt/homebrew/bin/python3.12`, once with `python3`, and the gates
(`.../gates-relay.sh 9c83be0`), reporting all as before.
