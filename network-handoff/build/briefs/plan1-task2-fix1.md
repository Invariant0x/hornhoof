Review of your Task 2 (by Codex, judged by the build lead). Fix every item below. For each: first a test that fails
on the code as it is now (run it, see it fail for the expected reason), then the fix. Do not commit, do not `git add`.
Report each item with its test name and how it failed before the fix.

Rulings on your deviations:
- Deviation 1 is reverted. Keep the plan's rule: a pending row younger than PENDING_S reads held unless frps shows the
  route online; an `offline` record does not empty it. Why: frps keeps the previous registration's offline record
  until the new one shows, so two registrations got through (the reviewer reproduced generation 2). Fix Task 1's
  `test_fact_dashboard_shows_the_route` instead: read the relay's route (`GET /api/v1/links/acme/route`) while its
  first client is online, so the row is `held` before that client stops; say so in a comment.
- Deviation 2 (the plugin's refusal message in `test_fact_proxy_name_is_unique`) is accepted.

Findings to fix:
1. Critical, relay.py:203: the offline exception above. Test: `acme` held by a client whose route was read held,
   stopped, route empty; then 10 clients with 10 client ids at once: exactly one NewProxy let through, generation grew
   by exactly one, the route names the one that runs.
2. Critical, relay.py:229: an online route with no routes row reads `empty`. The plan says it raises `FrpsUnknown`
   and logs the name: route answers 503 `unknown`, and a NewProxy is refused with `relay error: frps does not answer`.
   Test: delete the row from `relay.db` while the client is online, then read the route and start a second client.
3. Critical, relay.py:177: `frps_route` returns after finding the http record without reading https. The plan: read
   `/api/proxy/http/<name>` and then `/api/proxy/https/<name>`; both found raises `FrpsUnknown`. (https proxies are
   refused by the plugin until Task 9, so test this against a small fake dashboard in the test: an
   `http.server` on a free port answering both paths, relay functions imported with `RELAY_FRPS_API` pointing at it,
   or relay.py started against it.)
4. Critical, relay.py:172: a missing or empty `clientID` is taken as `None`. Global Constraints: a missing field in an
   answer about a route reads as unknown. Validate `status` and `clientID` (non-empty string); else `FrpsUnknown`.
   Test with the same fake dashboard.
5. Critical, relay.py:205: route reads (`route_of` from `GET .../route`) change the row outside the per-name lock, and
   the update guard compares only the second-resolution `since`, so a stale read cleared a newer pending generation
   written in the same second. Take the per-name lock for every read-and-straighten of a row (register_route already
   holds it: make the lock re-entrant or split route_of so the locked part is called once), and guard each UPDATE by
   `generation` (and state) as read, not by `since`. Test: the fastest honest one you can make; if an honest test is
   impractical, say why and show the guard by a test of the guard itself.
6. Important, relay.py:318: trace lines from concurrent plugin calls interleave on one line, and the parser drops
   them. Write each trace record as one complete line atomically (one `write` of the whole line under a lock, then
   flush). Test: the racing test below must see all ten NewProxy records.
7. Important, test_route.py:76: the race test stops at the first success. Wait until all ten clients have an outcome
   (started, or refused with `router config conflict` in their log, and ten NewProxy records in the trace) before
   asserting one winner, generation equal to the let-through count, and every NewProxy under 1000 ms.

Then run the whole relay suite with `/opt/homebrew/bin/python3.12` and `python3`, run it a second time to catch
flakes, then the gates (`.../gates-relay.sh 9c83be0`): every function you added or changed under CRAP 10, `plugin` not
above its old 16.4, no dryer pair at 0.8 or above with new code. Report both.
