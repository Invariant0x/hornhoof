# Plan 2 Task 4, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p2t4-r1-claude.md: 0 Critical, 0 Important, 6 Minor; the writer's ten rulings hold), Antigravity Argon high (runs/p2t4-r1-agy.md: 0 Critical, 2 Important, reproduced). Read both.

## Important: one fix round, each from a test that fails first

1. **Sockets leak when a client goes during a WebSocket handshake.** (Antigravity, reproduced twice) A client that closes while `headers()` awaits leaves `client` in CLOSE_WAIT: `server.getConnections()` stays 1. A client that wrote bytes then closed before 101 leaves client and target open. The brief says `upgrade` puts handling on the client's socket first, before anything is awaited, so that an error or a close on either destroys both. A person who refreshes during a handshake leaks a file descriptor until the container restarts, and enough of them stop `front` accepting, which cuts the company. Clean up on `socket` before the first await, destroy it when the asker has gone, and make sure a pre-101 EOF cannot hold both open behind unread bytes. Tests assert `getConnections()` reaches 0, in both cases.
2. **The two-hop test cannot see buffering.** (Antigravity) `front.test.ts`'s `send` collects to `end`, so an event stream buffered until its end passes. Assert `data: 1` arrives before the 3 s quiet window closes. Assert close going both ways across both hops, for the WebSocket and for the event stream. This is Review Focus 3.

## Minor: do these while you are there

- `limitConnect`'s timer is cleared on `close` as well as `connect`. (both reviewers)
- A client abort must not call `asker.refuse` as if the target had failed: detach `fail` before destroying `out`, and detach `fail` and `leave` once upgraded, and the comment that misleads. (both)
- If `opts.headers(req)` rejects on a request with a body, its unread bytes stay ahead of the next request on a reused socket: close that connection. Another caller could send them on as a request, the class of hole Task 7 of plan 1 closed in the relay. A test. (Antigravity)
- The front test that binds 0.0.0.0 goes: the build's rule is loopback only. (Claude)

## Deferred (ledger)

Five tests written after the code, proved by spoil and restore, not red first; helpers duplicated between the two test files, since test/helpers.ts is shared across lanes; front.ts logs nothing at start or on a server error (plan 2's later tasks); remaining minors in the two reviews.
