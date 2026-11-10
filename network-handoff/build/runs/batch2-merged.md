# Batch 2: what the lead accepted from its one review

Readers: install slice, Claude fable: 0 Critical, 0 Important, 8 Minor; app slice, Antigravity Argon high: 0 Critical, 0 Important, 3 Minor; sign-in slice (1b T2, security class), Claude fable: 0 Critical, 0 Important, 4 Minor, and Antigravity: 2 Important. Under the rule on tests a missing test counts only with a named harm: here the harm is a stranger with a company's link learning its people or reaching a terminal, and the sweep is the task's whole promise.

## Important: one fix round, each from a test that fails first

1. **The sweep looks at the wrong rows.** `apps/server/test/before-sign-in.test.ts`: `idsOfEveryTable` takes one id per table, which picks the template department with a null name and Ivan, and never Zebra Payments, Maria, or a sub-unit. A route that leaked those names would pass. Take every id, assert it is not empty, and add a team under Zebra Payments, for `teamId`, with its name in the names checked. See it fail by leaking a name in a copy, or from a seeded route.
2. **The sweep does not touch WebSockets.** `@fastify/websocket` answers a plain GET with 404, so an unauthenticated socket route passes the sweep unseen, and a stranger could reach a terminal. The three of today are safe, by hand; the test must keep it so. Record whether each route is `websocket`, and open each socket route with `app.injectWS`, without a session, from loopback and over the link: it is refused before anything is sent. A new socket route without a gate must fail this test.

No change in production code is expected. If one is, stop and tell the lead.

## Deferred minors (ledger)

The minors in `batch2-install-claude.md`, `batch2-signin-claude.md`, `batch2-app-agy.md`, `batch2-signin-agy.md`. Worth a later look: `VersionMark` fetches /api/version once at mount, so a person who signs in on the link sees no version until a reload (2 T10 or 1b T9); a second open tab may miss the maintenance bar until its 5-minute poll.
