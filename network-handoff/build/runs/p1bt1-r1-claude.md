# Review: Plan 1b Task 1, the __Host- session cookie over the link (round 1, Claude reviewer)

Read: the brief p1bt1-r1-review.md (plan top, Global Constraints, build rulings, the task), CLAUDE.md, the skills
requesting-code-review and verification-before-completion, the writer's report p1bt1-report.md, parallel-map.md rows for
1b T1 and section 5, progress.md rulings, the package p1bt1-r1.diff, and the lane's code in wt/p1bt1 (app.ts, session.ts,
tunnel.ts, origin.ts, internal.ts, modules/auth/routes.ts, modules/people/routes.ts, modules/events/stream.ts,
modules/terminals/routes.ts, web.ts, the 0053 snapshot and journal). Also the relay's frpc template (hornhoof-edge
relay/relay.py:843) for how X-Forwarded-Proto reaches the app. Read only; nothing in either repository was changed.

Checked by running: `light.sh npx vitest run test/auth.test.ts` in the lane: 1 file, 26 tests passed (12 s). Snapshot chain:
0053_snapshot.json prevId equals 0052_snapshot.json id, and it carries `before_host_cookie` on sessions. No em dash in any
changed file (grep). No secret value in tests or code: tokens are compared, never printed.

Counts: Critical 0, Important 1, Minor 9.

## Critical

None found.

## Important

### I1. The hand-over starts a session without holding the person's row, so a password reset or a disable that lands at the same moment leaves a live 30-day session

`apps/server/src/auth/session.ts:96-114` (`moveOlderSession`).

What is wrong. `startSession` (session.ts:62-66, 76) locks the person's row `FOR SHARE` while it inserts, and the comment says
why: "a reset or a disable running at the same time either comes first and is seen here, or waits and then deletes the new
session". `reinvite` (people/routes.ts:80-87) and the disable path (people/routes.ts:246-249) rely on it: they update
`people` first, then delete that person's sessions. `moveOlderSession` inserts a new session too, but locks only the old
session row (`FOR UPDATE OF sessions`, line 103). Under READ COMMITTED on Postgres:

1. hand-over: `SELECT ... FOR UPDATE OF sessions` locks the old row S; the person reads active.
2. reinvite: `UPDATE people` succeeds (nobody holds that row), then `DELETE FROM sessions WHERE person_id = P` blocks on S.
3. hand-over: sets S's expiry, inserts S' (30 days, `before_host_cookie` false), commits.
4. reinvite's DELETE wakes, deletes S; S' was inserted after the DELETE's snapshot, so it is not seen and survives.

What a person would get. The owner resets (reinvites) or disables a person whose old `hh_session` cookie is in a browser
that is handing over right then, for example a lost laptop that is open on the company's link during the Update. The reset
is meant to end that access; instead S' lives on. While the person is `invited` or `disabled`, `requirePerson` refuses S'
on status, but once the person accepts the new invite (status back to `active`), S' works again for the rest of its 30
days, in the browser the reset was for. The window is one request's width, and the hand-over fires on every request with
the old cookie for 60 s, so it is small but not zero, and it is the exact hole the existing code guards against.

How I checked. By reasoning from the named lines: the plan asks only for `FOR UPDATE` on the session row, which the code
does; the invariant broken is the code's own (session.ts:62-66, people/routes.ts:80-81). PGlite has one connection, so a
test cannot interleave two transactions; an honest test is impractical here, which is why it needs a ruling in the ledger.

What would make it right. Take the person's row in the same statement, as `startSession` does: `FOR UPDATE OF sessions,
people` (drizzle's `.for('update', { of: [sessions, people] })`), or `FOR UPDATE OF sessions FOR SHARE OF people` by raw
sql. Then a reinvite or a disable either sees the hand-over's row and deletes it, or the hand-over waits and sees the
person no longer active and returns null. One line, no new test possible in PGlite; ledger line.

## Minor

### M1. Hook placement (the writer's concern 1): accept, with a ruling and one comment fixed

`apps/server/src/app.ts:82-85, 113-117`. The plan says the hand-over runs "right after the overLink one". It needs
`req.cookies`, which `@fastify/cookie` fills in its own `onRequest` hook at `register(cookie)` (app.ts:111), so it cannot
run before that. What sits between the two hooks: security headers (web.ts:33, writes response headers), error handling,
cookie parsing, the websocket plugin. None reads the session or the cookie, so a person sees no difference against the
plan's order. The alternative, registering the cookie plugin right after the `overLink` hook and the hand-over next, would
meet the letter of the plan; not worth a rework. Needs a `Ruling:` line in the ledger. One thing to fix: the pre-existing
comment at app.ts:114 ("After the socket plugin, so a refused socket is closed by it.") explained `fromOwnPages` and now
sits above the hand-over line; move it down to line 117 or merge the two comments.

### M2. Edits to migration-history.test.ts and migration-metadata.test.ts (the writer's concern 2): accept, and rule for the chain

`apps/server/test/migration-history.test.ts:91-92`, `apps/server/test/migration-metadata.test.ts:24, 62`. Both tests pin
the newest migration by design (count 52 to 53; latest snapshot tag), so adding any migration fails them; the edits are
the only honest change and they still test what they tested. Not in the plan's Files list, so a ruling is due. Since 1b
T3, 1b T7, 3 T2 and 4 T1 will hit the same two files, the ruling can name them as part of every migration lane's Files
(the map's ruling 4 already adds migration-history.test.ts to 3 T2's Done when).

### M3. The surviving mutant `decorateRequest('overLink', false)` to `true` (the writer's concern 3): equivalent, rule on it

`apps/server/src/app.ts:82`. The first `onRequest` hook (app.ts:83-85) assigns `req.overLink` on every request that reaches
any hook, including 404s and websocket upgrades, and `overLink` never throws (`fromTunnel` catches its lookup). Nothing
reads the decoration before that hook: the readers are `sessionCookieOf`, `clearingOptions`, `setSessionCookie` and
`needsHandOver`, all in route handlers or later hooks. The default is never observed, so no test can kill it. Needs the
ledger line "Ruling: app.ts:82 default false to true survives, equivalent, why: the first hook assigns before any read".

### M4. Every request within the 60 s grace mints another 30-day session

`apps/server/src/auth/session.ts:96-114`, the writer's deviation 5. The plan wants a burst of three with the old cookie to
be three 200s, and each becomes its own new session row; the browser keeps only the last `__Host-hh_session` it received,
so the others are orphans that nothing holds and that logout (which deletes only the cookie's row) never removes. They
expire in 30 days and are swept at a sign-in. By plan, so not a gap; worth a line in the ledger as accepted, and a later
task could move once and let the other burst requests through on the old row alone.

### M5. The accepted residual: a signed-out visitor can be signed in as another member of the same company

`apps/server/src/auth/session.ts:96-114, 116-118`. Every name shares the site hornhoof.org, and a name's owner serves
whatever they like behind their tunnel, so a page on `other.hornhoof.org` can set `hh_session=<token>; Domain=hornhoof.org`
in a visitor's browser. The hand-over moves such a token only when it is a row of this company marked
`before_host_cookie`, unexpired, of an active person, and only when the browser has no `__Host-hh_session`. So the attack
left is: an active member of the same company plants their own pre-Update token, and a signed-out colleague who then
opens the company's link is signed in as that member (login CSRF: anything the colleague then enters, such as a plan
sign-in, lands in the member's account). One shot per such token, and only until pre-Update sessions expire (30 days).
This is what the team lead's ruling accepted ("read only for that move, and only for a session made before the Update"),
and it is strictly narrower than today, where any valid token planted that way is read on every request and shadows a
signed-in person's cookie. Noted so the ledger says it was seen. A small follow-on: the clearing at session.ts:124 sets
a host-only `hh_session` and cannot remove a `Domain=hornhoof.org` one, so a browser carrying a planted cookie repeats the
lookup and the Set-Cookie on every request. Harmless, one indexed select per request.

### M6. `overLink` looks the tunnel host up in DNS on every request over the link, and a failed lookup reads as signed out

`apps/server/src/auth/tunnel.ts:9-17, 27-29`, `apps/server/src/app.ts:83-85`. Before this task `cameOverHttps` ran at
sign-in only; now it runs for every request with `x-forwarded-proto: https`, which is every request over the link
(`dns.lookup` goes through libuv's threadpool). When the lookup fails or times out, `overLink` is false, the request's
cookie name becomes `hh_session`, the person's `__Host-hh_session` is not read and the request is 401, so a DNS blip in
Docker shows as a signed-out page for that request. The plan's Interfaces say `cameOverHttps(req, config)` for now and
Task 5 replaces this with the listener's sockets, so this is inherited, not the writer's. If the lead wants it softer
before Task 5: a short cache of the lookup (a few seconds) in `fromTunnel`.

### M7. `sessionFrom` takes the first cookie of either name

`apps/server/test/helpers.ts:101-105`. In a hand-over response both names are present and the cleared `hh_session` (value
'') comes first, so `sessionFrom` would return '' for such a response. No current test calls it on one (the hand-over
tests read `res.cookies` directly), so nothing fails; prefer the `__Host-` cookie when both are there, so a later test
cannot be fooled.

### M8. TDD evidence is the report's word

The lane has no commits, so the red run cannot be re-checked from history. The failures the report describes (the cookie
named `hh_session` over the link; `update "sessions" set where ...` on the missing column; `column "before_host_cookie"
does not exist` in the migration test) are what the code before the change produces for these tests, so the claim is
consistent. Green I confirmed myself (26 passed).

### M9. `drizzle/meta/_journal.json` lost its final newline

`apps/server/drizzle/meta/_journal.json`, drizzle-kit's own output. Cosmetic; every later `generate` will do the same.

## Checked and found right

- `__Host-hh_session` is set with `secure`, `path: '/'`, no domain, `httpOnly`, `sameSite: lax` (session.ts:49-58), and
  cleared with the same attributes over the link (session.ts:47, 91), as a browser requires for the prefix. A page on
  another name cannot set or shadow a `__Host-` cookie, and over the link nothing but the hand-over reads `hh_session`
  (grep: `requirePerson` and `endSession` read `sessionCookieOf(req)` only; no other reader of `req.cookies` in src).
- The hand-over gives a new token (`newToken()`), never reuses the old one, so the switch does not fix a session; the old
  row's expiry is `least(expires_at, now() + 60 s)`; a marked row of a disabled person, an expired row and an unmarked
  (post-switch) row are refused, each with a test that would fail if the check were dropped.
- Localhost and the updater's health path are unchanged: `hh_session`, no `secure`, `/api/health` untouched.
- `startSession` and the hand-over write `beforeHostCookie: false`; the migration's default `true` marks every existing
  row, including one an old app writes between the migration and its own stop, which is right.
- The invite accept and setup paths go through `startSession`, so they get the link cookie (test present for the invite).
- Websocket upgrades skip the hand-over (`needsHandOver`), and the terminal socket authenticates on the upgrade request
  with `req.overLink` already set; the relay's frps sets `x-forwarded-proto` per proxy (relay.py:843), which Go's reverse
  proxy applies to upgrades too.
- Tests assert concrete values: exactly one cookie on sign-in over the link, the name and flags, 401 versus 200 on each
  side, the expiry in the past on logout, `before_host_cookie` false on the new row. None would pass with the code wrong
  as far as I can see; the only soft assert (`expiresAt - now <= 60 s`) is backed by the burst test proving the row still
  lives.
- No Docker, nothing on the droplet, no secret in any message, no personal data, no em dash, English throughout.
