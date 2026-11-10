# Plan 1 Task 7, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1t7-r1-claude.md: 0 Critical, 1 Important, 7 Minor), Antigravity Argon high (runs/p1t7-r1-agy.md: 1 Critical, 3 Important). Read both for detail. Lead's check: 152 OK on 3.12 under coverage and on 3.14; create_binding 4.0, binding_body 8.0, dryer none.

## Critical: fix first

C1. **Request smuggling through unread bodies.** (Antigravity, reproduced in process; the lead confirmed the pattern is in 0bc6cd5, the deployed code; see QUESTIONS.md item 7.) `Handler` speaks HTTP/1.1 behind Caddy's pool. A request answered without its whole body read, key_answer always and every early `error` return, stays on a kept connection, and its remaining bytes parse as the next request: from 127.0.0.1, no X-Forwarded-For, which `handle_plugin` and `client_ip` trust. A chunked body is unread by construction, since `read_json` goes by Content-Length.
    The right shape, one rule in one place: after any request whose body was not read in full, or that carries Transfer-Encoding, the connection closes, for every route, without each route having to remember. Keep keep-alive for a clean request: frps's plugin calls rest on it, and Task 10 asks 50 ms per new connection. Tests fail first: an unauthenticated POST whose body holds a whole request: the second request does not run, on every route shape that returns early (key, sync, visitor-key, DELETE, bindings' 415); a chunked POST the same; a clean plugin call on a kept connection still works twice. test `key_answer` with a `{}` body followed by a good request on the same connection. task8-writer proves the same through the real Caddy separately.

## Important: the same round, each from a test that fails first

I1. **A freed name's sync record goes to its next owner.** (Claude I1, reproduced) `release_binding` leaves `sync`: a new company on that name sees the stranger's copy and epoch, and its posts at or below that epoch are refused `stale_epoch`. `DELETE FROM sync` in `release_binding`'s transaction. Ruling: the `routes` row stays, because the generation only grows across owners, so an old holder's generation can never match. Test: rebind, route shows the empty sync record, a post with epoch 1 is taken.
I2. **`ping_keys` keeps a released owner's hashes for good, and the README says otherwise.** (Antigravity 3, Claude M1) Delete them in `release_binding`'s transaction, under its guard. README: what the relay keeps now includes retired key hashes, until release. Test: rows gone after release.
I3. **A name with a trailing newline answers 503.** (Antigravity 1) `LABEL.match` with `$` passes `'globex\n'`. `LABEL.fullmatch`, and cover it in BindingRequestTests. `admin add` benefits too.
I4. **The approved fixture left a dead assertion.** (Antigravity 2, Claude M2) `test_route.py:190` asks `started('acme')` of a client named by the random name, so it can never be true. Ruling: `started(name, within=2)`: the approval's point was that assertions keep reaching their paths; this restores it, and changes nothing else in the fixture.

## Minor: do these while you are there

The module docstring's admin line: `show` is not a command, `add` is.

## Deferred minors (ledger)

Rotating a blocked binding's key answers 404 where DELETE answers 403 (M3); dashboard reads now run under create_lock, up to 1 s (M4); a lost answer after the commit leaves a company with no key it knows, which plan 9's chosen key (A1) answers (M5); BIN in harness.py no longer resolves, harmless since the worker links relay/test.
