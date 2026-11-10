# Plan 1b Task 1, review round 3 (Claude, read only)

Package: `network-build/runs/p1bt1-r3.diff` in lane `wt/p1bt1`. Focused run in the lane through light.sh,
`npx vitest run test/auth.test.ts`: 38 passed, 38 total. No repository file changed, no subagent. Mechanism checks
were done with a throwaway Fastify app in `network-build/tmp/p1bt1-r3-claude/mech.mjs` that loads the lane's own
`fastify` and `@fastify/cookie` 11.1.5 and uses the same hand-over shape (onRequest setCookie plus a wrapped
`reply.hijack` that calls `reply.raw.setHeader('set-cookie', [...])`).

## Finding 1, two `__Host-hh_session` cookies in one response: ADDRESSED

- `session.ts`: the hand-over now goes through the plugin (`reply.clearCookie`, `setSessionCookie`, diff lines 300 and
  303), and `startSession` and `endSession` use the same `setSessionCookie` and `clearCookie` with path `/` and no
  domain. `@fastify/cookie` keys its pending list by `name;domain;path` (`index.js:48`), so the later call replaces
  the earlier one. Reproduced with mech.mjs: a route that sets `__Host-hh_session=B` after the hook set `A` sends
  `[hh_session=, __Host-hh_session=B]`; a route that clears it sends `[hh_session=, __Host-hh_session=]`; a plain
  route `[hh_session=, __Host-hh_session=A]`; a route that throws (500 through the error handler, `errors.ts:137`,
  `reply.send` runs onSend) also `[hh_session=, __Host-hh_session=A]`. One `__Host-hh_session` on every path.
- Orphans: `handedOver` (WeakMap per request) keeps `{ from, to }`; `startSession` deletes `to` once its own row is in
  (diff 234), `endSession` deletes the cookie's token and `from` (diff 243). Rows per path, from the code and the
  tests' assertions: plain reply, old row cut to 60 s plus the new one (by plan); sign-in, old row cut to 60 s plus
  the sign-in's own, `rowsOf(...).toHaveLength(2)`; invite acceptance, Maria's row plus the older person's old row
  only, `ivan.toHaveLength(1)` with `tokenHash === hashToken(token)`; logout, none, `toEqual([])`. No session is left
  for a person being signed out or replaced.
- Tests fail without the fix: the three tests assert `linkCookies(res).toHaveLength(1)`; with the round 2 code
  (`reply.header('set-cookie')` for the hand-over plus the plugin's list) the plugin merges into an existing header
  instead of replacing (`index.js:106-117`), so two go out. Round 2 (Antigravity) reproduced exactly that, and the
  writer reports the red run with `got 2`. The row assertions would also fail on the round 2 code, which never deleted
  the hand-over's session.
- `startSession` returning false (a reset in the same instant) leaves the hand-over's cookie and row in place: the
  request started no session, so the person of the older cookie stays signed in as before. Correct.

## Finding 2, a hijacked route eats the hand-over: ADDRESSED

- `deliverIfHijacked` (diff 283 to 289) wraps `reply.hijack` for that request only; the wrapper puts the hand-over's
  cookies on the raw response with `setHeader` and then hijacks. Node 22.23 `writeHead(status, object)` merges with
  `setHeader` values and a name in the object replaces only that header. Reproduced with mech.mjs: `writeHead(200,
  { 'content-type': ... })` sends `[hh_session=, __Host-hh_session=A]`; `writeHead(200, ['content-type', ...])` the
  same; `writeHead(200, { 'set-cookie': 'other=1' })` sends `[other=1]`, that route's own choice. Neither hijacking
  route names `set-cookie`: `stream.ts:22` writes four fixed headers; `/mcp` goes through Hono's node adapter
  (`@hono/node-server/dist/index.mjs:1001,1011` `writeHead(status, resHeaderRecord)`), which puts `set-cookie` in the
  record only when the web Response carries one (`index.mjs:792`), and the MCP transport sets no cookie. So the stream
  and `/mcp` both deliver the hand-over's cookies.
- Does the wrap hold across Fastify's own use: Fastify never calls `reply.hijack()` itself; it reads the symbol
  `this[kReplyHijacked]` (`fastify/lib/reply.js:111,135`), which the original, called through the wrapper, still
  sets. `@fastify/websocket` calls `reply.hijack()` only for an upgrade (`index.js:195-197`), which `needsHandOver`
  skips (`!req.headers.upgrade`), so the wrapper is not even installed there. A new Reply is built per request
  (`reply.js:1029`), so the own-property assignment in an onRequest hook is the right place and lives exactly one
  request. Per request is right: the cookies are that request's.
- Test fails without the fix: `delivers the cookies of a route that hijacks the reply and sends only a status` adds a
  route that hijacks and writes `writeHead(200)`; the plugin writes cookies only in onSend (`index.js:121-131`), which a
  hijacked reply never reaches, so without `deliverIfHijacked` `res.cookies` is empty and `toEqual(['__Host-hh_session',
  'hh_session'])` fails; writer reports that red. The event-stream test over real HTTP (`getSetCookie()`) covers the
  real route.
- `stream.ts` is back to its original: it is not in the r3 diff, `git status` in the lane does not list it.

## Finding 3, the lock test: ADDRESSED

- Test `holds the person's row, then the session's, before it makes the new session, in one transaction` (diff 678
  to 694): asserts status 200, `client.transaction` called once (spy created after `olderSession`, so setup's own
  transaction is not counted, restored with `onTestFinished`), and through `statements()` (`test/helpers.ts:46`,
  restored the same way) the indexes of `select ... from "people" where ... for share`, `select ... from "sessions"
  where ... for update`, `insert into "sessions"` in that order with `people >= 0`. Reading `moveOlderSession` (diff
  251 to 275): owner read unlocked, person `FOR SHARE` on `people`, session `FOR UPDATE`, update, insert, one
  `db.transaction`. Without the person lock `people` is -1 and `toBeGreaterThanOrEqual(0)` fails; with the order
  swapped `people < session` fails; with a second transaction `toHaveBeenCalledTimes(1)` fails. The test fails when
  the lock is wrong.

## Minor from round 2, unknown `hh_session` over the link: ADDRESSED

- `only clears hh_session when the token is unknown, and makes no session`: 401, cookies `['hh_session']`, sessions
  table unchanged. Pins `if (!owner) return null`.

## New breakage in what the fix changed

Critical: none. Important: none.

Minor, no change asked (no person's harm):
- The hand-over's cookies are described twice: once as plugin calls (diff 300, 303) and once as serialized strings for
  the raw path (diff 301, 304). A smaller shape with the same result: build one list of `{ name, value, options }`
  and feed both from it; or drop the wrapper and always call `reply.raw.setHeader('set-cookie', cookies)` next to the
  plugin calls, since on a normal reply Fastify's `writeHead(status, reply[kReplyHeaders])` (`reply.js:590`) names
  `set-cookie` whenever the plugin set one and so replaces the raw value with the plugin's list, which already holds
  the hand-over's cookies (verified by the `/hijack-names` case: a named header replaces). The writer's reason for
  not doing that ("the two-channel trap") does not apply once the hand-over is in the plugin's list too. Either
  shape is fine; the one shipped is clear and tested.
- The hijacked path delivers the hand-over's cookies as they were in onRequest; a hijacking route that itself set a
  cookie through the plugin before hijacking would lose its own. No such route exists today.

## Gates and rules, from the lead's r4 gates log

crapper: every function of `session.ts`, `tunnel.ts` and `app.ts` under 10 (highest `requirePerson` 8.2); in
`test/helpers.ts` `agentSqlOn` 12.0 and `openStream` 10.1 are untouched functions in a touched file, for the lead to
rule. dryer: no duplicate candidates. No em dash in the diff (grep count 0). No token value printed anywhere in the
tests; cookies are compared by name, attributes and booleans, and the one token read from a header is used only as a
lookup key.
