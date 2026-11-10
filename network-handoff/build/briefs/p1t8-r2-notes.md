# Notes for this review from the build lead

- This is review round 2 of plan task 8, written in the lane `/home/altera/hornhoof-network/wt/p1t8`. The change under review is the package
  `/home/altera/hornhoof-network/network-build/runs/p1t8-r2.diff`: the lane's own work against its start, the tag `lanebase`. What it stacks on is reviewed separately.
- The writer's report, claims to verify and not to trust: `/home/altera/hornhoof-network/network-build/runs/p1t8-report.md`. It says what ran and how each test failed first.
- Where this task meets others: `/home/altera/hornhoof-network/network-build/parallel-map.md` sections 1, 3 and 4 for this task, and section 5's rulings, all taken. Build ruling 5: migration numbers are the plan's plus 11.
- The lead runs the full suite and the three gates itself, on the test machine. You run at most focused tests, in the lane, through
  `/home/altera/hornhoof-network/network-build/light.sh <command>`.

# This is a scoped re-review, round 2

Say for each finding below ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its test really fails without the fix. Report new Critical or Important breakage only in what the fix changed. Do not reopen what was accepted or deferred, and do not review the rest of the task again.

# Plan 1 Task 8, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1t8-r1-claude.md: 0 Critical, 1 Important, 6 Minor), Antigravity Argon high (runs/p1t8-r1-agy.md: 0 Critical, 0 Important, 4 Minor). Verified by them: the four SHA-512 values match the release's checksum file; each Caddyfile anchor matches once; no test reaches a real host.

## Important: fix from a test that fails first

1. **The wrong-checksum test proves nothing.** (Claude, reproduced) `relay/test/test_edge_today.py:671-687` passes with the check deleted from `caddy.sh`, because the fake download is not gzip and `tar` stops the script by itself. The fake `curl` serves a real `.tar.gz` holding a `caddy` entry, so that only the checksum can stop it; the test asserts the checksum failure's text and that nothing is installed. See it fail with the check removed, in a copy, then restore the check.

## Minor: do these while you are there

- `.github/workflows/tests.yml`: `- run: sh relay/test/caddy.sh` after the `frp.sh` step, as the README lists.
- `_dns_names`: cache a tuple, hand each Answer its own list.
- `test_method_and_body_reach_the_company`: the recorder's threads are daemon, and its thread is joined in cleanup.

## Deferred minors (ledger)

`RELAY_CADDYFILE` stays a stub on a Caddy stack (the writer's ruling stands, Task 9 points it at the rendered file if a test needs it); the login-count assertion in test_reload_leaves_a_tunnel_alone never seen failing; tests import private harness names; caddy.sh duplicates frp.sh line for line, by plan.
