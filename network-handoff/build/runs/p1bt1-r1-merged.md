# Plan 1b Task 1, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1bt1-r1-claude.md), Antigravity Gemini 4 Argon high (runs/p1bt1-r1-agy.md). Read both for detail. Critical: none.

## Important: fix in this one round, each from a test that fails first

1. **The event stream eats the hand-over and delivers no cookie.** (Antigravity, reproduced: 200, no Set-Cookie, old row at 60 s, 2 rows.)
   `handOverSession` runs on `GET /api/stream`, which `reply.hijack()`s, so @fastify/cookie's onSend never runs. A person whose open tab reconnects its
   event stream after the Update, and who does nothing else within 60 s, is signed out a minute later. Each reconnect also mints a 30-day orphan
   row. The test: `GET /api/stream` over the link with an older cookie. The right fix is the smallest one that holds for every hijacked route: the
   hand-over must not be consumed unless its cookie is delivered. Check other hijacked routes in the code (`reply.hijack` across `apps/server/src`).
2. **A reset password can leave a stolen session alive.** (Claude, reasoned from named lines.) `moveOlderSession` inserts the new 30-day session holding only
   the old session row, not the person's row as `startSession` does (`session.ts:76` FOR SHARE). A reinvite or disable at that instant misses the new row, so
   it survives the reset. Fix: lock `people` too, as `startSession` does. PGlite cannot interleave two transactions, so the red test here captures the statement
   and fails until the person's row is locked; see the ledger ruling. The real concurrent test waits for plan 3's Postgres harness.
3. **Gate conditions no test pins.** (Antigravity.) `needsHandOver`'s `!req.cookies[LINK_SESSION_COOKIE]` and `!req.headers.upgrade` can be removed with tests green. Test: both
   cookies over the link; an older cookie with `Upgrade: websocket`: no cookie set, older row untouched.
4. **Clearing is not asserted.** (Antigravity.) `moves it once` and `refused` must assert `hh_session` cleared: value '', `secure: true`, `path: '/'`, no domain, expiry in the past.
5. **`moveOlderSession`'s effects are not pinned.** (Antigravity.) Seed a second person's session and assert it is untouched (the `where`). Assert the old row lands between about 50 s and 60 s on a 30-day
   session, and stays near 10 s when it started at 10 s (the `least`). Assert `httpOnly`, `sameSite: 'Lax'`, about 30 days on the new cookie and its row.
6. **The plain logout test.** (Antigravity.) Assert the cleared `hh_session` has `path: '/'` and no `secure`, so a plain-http LAN address can still sign out.

Why the mutator did not catch 3 to 6: 22 of 22 killed on `session.ts` says the tool's sites were covered, not these. Say in the report what the mutator does not mutate that these findings do.

## Minor: do these two while you are there

- `app.ts:114`'s comment moves back above `fromOwnPages`.
- `sessionFrom` in `test/helpers.ts` requires a non-empty value.

## Accepted as they are (ledger)

Hook placement after the cookie plugin; the two pinned migration tests, edited by every migration lane; `decorateRequest('overLink', false)` is an equivalent mutant.

## Deferred minors (ledger)

Each request in the 60 s grace mints its own 30-day orphan session (by plan, but fix 1 may reduce it; say); login-CSRF residual for a same-company member's pre-Update token planted on the parent domain, narrower than today; overLink's DNS lookup per link
request, and a failed lookup answers 401 (plan's cameOverHttps; Task 5 replaces it); `_journal.json` lost its trailing newline (generated).
