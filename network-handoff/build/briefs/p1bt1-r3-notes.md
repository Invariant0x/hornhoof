# Notes for this review from the build lead

- This is review round 3 of plan task 1, written in the lane `/home/altera/hornhoof-network/wt/p1bt1`. The change under review is the package
  `/home/altera/hornhoof-network/network-build/runs/p1bt1-r3.diff`: the lane's own work against its start, the tag `lanebase`. What it stacks on is reviewed separately.
- The writer's report, claims to verify and not to trust: `/home/altera/hornhoof-network/network-build/runs/p1bt1-report.md`. It says what ran and how each test failed first.
- Where this task meets others: `/home/altera/hornhoof-network/network-build/parallel-map.md` sections 1, 3 and 4 for this task, and section 5's rulings, all taken. Build ruling 5: migration numbers are the plan's plus 11.
- The lead runs the full suite and the three gates itself, on the test machine. You run at most focused tests, in the lane, through
  `/home/altera/hornhoof-network/network-build/light.sh <command>`.

# This is a scoped re-review, round 3

Say for each finding below ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its test really fails without the fix. Report new Critical or Important breakage only in what the fix changed. Do not reopen what was accepted or deferred, and do not review the rest of the task again.

# Plan 1b Task 1, review round 2: what the lead accepted

Reviewers: Claude fable (runs/p1bt1-r2-claude.md: all ADDRESSED), Antigravity Argon high (runs/p1bt1-r2-agy.md: 3 Important, reproduced). Round 3 is this task's last review round (BRIEF.md), so get this right.

## Important: fix from tests that fail first

1. **A response can carry two `__Host-hh_session` cookies, one for the wrong person.** New breakage from fix 1, reproduced: accepting an invite over the link, with Ivan's older `hh_session` in the browser, sends `hh_session` cleared, a new 30-day `__Host-hh_session` for Ivan, and one for Maria. Logout sends a live and an expired one. The hand-over's cookie is written by `reply.header` while `setSessionCookie` and `endSession` use the plugin's `setCookie`, which appends. What must hold: a response has at most one `__Host-hh_session`, and it is the one that request means; no session is minted for a person who is signing out or being replaced in that same request. Tests over the link with an older cookie: sign-in, invite acceptance, logout. Check `sessions` rows too: no orphan is left for the older person from such a request.
2. **Any hijacked route can eat the hand-over.** `POST /mcp` over the link with a bearer token and an older cookie: 200, no cookie, old session shortened, 2 rows (reproduced). Claude judged it theoretical, since agents carry no browser cookie, and that is likely so today; but a later hijacked route would meet the same. One rule in one place, so that no route has to remember: either the hand-over delivers on every route, or it does not run on a route that cannot deliver it. Antigravity proposes `reply.raw.setHeader`; before you take it, check how Node merges it with the `set-cookie` Fastify passes to `writeHead` on a normal reply that also sets a cookie, because `writeHead`'s value can replace it, and finding 1 must hold. Choose the smallest shape that meets both. Revert `stream.ts` if it is no longer needed: it is outside the task's Files.
3. **The lock test can pass with the lock wrong.** Assert status 200, one transaction, and the order: person's row locked, then the session row, then the insert, with the lock really on `people`. Use `statements` in `test/helpers.ts`, as `tasks-merge.test.ts:118-127` does, and restore the spy.

## Minor: while you are there

An unknown `hh_session` token over the link: a test for `if (!owner) return null`.
