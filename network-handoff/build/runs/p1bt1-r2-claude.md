# Plan 1b Task 1, review round 2 (Claude, read only)

Package: `network-build/runs/p1bt1-r2.diff` in lane `wt/p1bt1`. Focused run in the lane through light.sh:
`npx vitest run test/auth.test.ts`: 33 passed, 33 total. No file changed, no subagent.

## Finding 1, the event stream ate the hand-over: ADDRESSED

- `session.ts` `handOverSession` (diff lines 274 to 284) now writes both cookies with `fastifyCookie.serialize` straight into
  the reply's `set-cookie` header in onRequest, no longer through `reply.setCookie`. `stream.ts` `eventStreamHeaders` (diff
  389 to 399) copies `reply.getHeader('set-cookie')` into the stream's own `writeHead`, so the hijacked reply carries the
  cleared `hh_session` and the new `__Host-hh_session`.
- Test `delivers the new cookie on the event stream, which sends its own headers` goes over real HTTP (`listen`, `openStream`
  with `cookie: hh_session=<old>` and `x-forwarded-proto: https`, `TUNNEL_HOST: 127.0.0.1`), asserts a `__Host-hh_session=`
  Set-Cookie with Secure and Path=/, that its token's row has `before_host_cookie` false, and an `hh_session=;` clearing.
- Fails without the fix, reasoned from the plugin's code: `@fastify/cookie` 11.1.5 `index.js:48` stores `setCookie` in a map
  and writes the header only in onSend (`index.js:121-131`), so in onRequest `reply.getHeader('set-cookie')` is undefined and
  the stream's `writeHead` would carry nothing; the test's `toMatch` on an undefined header fails. Without the `stream.ts`
  half alone the old fixed `writeHead` sends no Set-Cookie either. Round 1 reproduced exactly this (200, no Set-Cookie).
- Normal routes: `index.js:92-118` merges the plugin's cookies into an existing header array instead of replacing it, so a
  sign-in over the link with a stale `hh_session` delivers cleared, hand-over token and the sign-in's token in that order;
  the browser keeps the last. `moves it once` and `refused` show both headers arrive on `/api/me`.
- The open tab stays signed in after the minute: `stream.ts` `look()` calls `requirePerson(req)` on the same request, whose
  `req.cookies['__Host-hh_session']` the hand-over set to the new token (`session.ts` diff line 283), so the ping validates
  the new row once the old one has expired. Not pinned by a test; the reasoning is from those lines.
- Only the stream needs this: `grep -rn "hijack\|reply\.raw\|writeHead" apps/server/src` gives `events/stream.ts` and
  `tools/mcp.ts:126` only. `POST /mcp` signs in by a job's bearer token (`tools/job.ts:20`), is called by agents from inside
  the machine, never by a browser, and `jobOf` throws before `hijack()`, so a refused call still answers through the plugin
  with the cookies. Theoretical only: a bearer-authenticated `/mcp` call that also carried a browser's old `hh_session`
  over the link would consume the hand-over and the MCP transport's own `writeHead` would drop the cookie. No client does
  that; Minor, no action needed. Sockets carry `Upgrade` and are skipped by `needsHandOver`.

## Finding 2, the person's row not locked: ADDRESSED

- `moveOlderSession` (diff 241 to 265): reads the session's owner unlocked, then `people ... status = 'active' FOR SHARE`,
  then the session row `FOR UPDATE`, then update and insert, all in one transaction.
- Deadlock check against the other writers, from named lines: `reinvite` (`people/routes.ts:84-87`) updates `people` then
  deletes `sessions`; disable (`people/routes.ts:246-249`) updates `people` then deletes `sessions`; `startSession`
  (`session.ts`) locks `people` FOR SHARE then inserts `sessions`. Every writer takes `people` before `sessions`, the move
  too, so there is no cycle. The move's unlocked first read of `sessions` takes no lock. Two moves of the same token both
  hold FOR SHARE (compatible) and serialise on the session row's FOR UPDATE; under READ COMMITTED the second re-evaluates the
  row after the wait, still marked and unexpired at `now() + 60 s`, and mints one more row (the deferred grace minor, by
  plan). A reinvite that comes first makes the move's FOR SHARE wait and then see `status <> 'active'`, so no new row; one
  that comes second waits on the share lock and then deletes the new row too. `startSession`'s autocommit delete of expired
  rows holds nothing the move needs.
- Test `holds the person's row while it makes the new session, as a sign-in does` spies on PGlite's `transaction`, records
  each statement, and wants one matching `from "people"` and `for (share|update)`. Without the lock, the transaction's
  statements are `from "sessions"` (owner read, FOR UPDATE read), the update and the insert; none names `people`, so `some`
  is false and the test fails. It would also accept a FOR SHARE without the `status = 'active'` condition, and it does not
  pin the order of the lock before the insert; the real concurrent test waits for plan 3's Postgres harness (ledger).

## Findings 3 to 6 and the minors

3. ADDRESSED. `does nothing when the request already carries __Host-hh_session` (both cookies, keeps `x-forwarded-proto`
   through `viaLink`): without `!req.cookies[LINK_SESSION_COOKIE]` the hand-over runs, sets two cookies and cuts the old row,
   failing `toHaveLength(0)` and the 29-day check. `does nothing for a socket upgrade` spreads `viaLink().headers` so the
   request is still over the link; without `!req.headers.upgrade` it answers 200 with cookies instead of 401 with none.
4. ADDRESSED. `expectOldCookieCleared` asserts value '', `secure: true`, `path: '/'`, no domain, expiry in the past, in
   `moves it once` and in `refused` (three times).
5. ADDRESSED. Another person's marked session unchanged (`toEqual(before)` on the whole row); old row in (50 s, 60 s] on a
   30-day session; stays at or under 10 s on a 10 s session; new cookie `httpOnly`, `sameSite: 'Lax'`, about 30 days, row too.
6. ADDRESSED. Plain logout asserts `path: '/'`, `secure` falsy, expiry in the past.
- Minors: the comment is above `fromOwnPages` again (`app.ts` diff 128); `sessionFrom` keeps only non-empty values.

## New breakage in what the fix changed

None at Critical or Important. Minor, no action: `handOverSession` writes the clearing header on every refused request
over the link that still carries a stale `hh_session`; the browser drops the cookie on the first answer, so it is one.

## crapper

`GET /api/stream` at 9.2 with its own tests in the list is under 10; the route gained one call and no branch.
