# Report: Plan 1b Task 1, the __Host- session cookie over the link

Lane: /home/altera/hornhoof-network/wt/p1bt1 (Hornhoof). Nothing staged or committed.

## Read before writing

Skills (plugins/superpowers/skills/<name>/SKILL.md): test-driven-development, systematic-debugging, verification-before-completion.
Rules: /home/altera/hornhoof-network/CLAUDE.md, hornhoof/AGENTS.md, hornhoof/templates/skills/dev-engineering-rules.md, the brief
network-build/briefs/p1bt1-writer.md (with its quality rules), network-build/parallel-map.md rows for 1b T1.

## Files changed (all in apps/server)

- src/db/schema.ts: `sessions.beforeHostCookie` (`before_host_cookie`, not null, default true).
- drizzle/0053_session_handover.sql, drizzle/meta/0053_snapshot.json, drizzle/meta/_journal.json: from `npx drizzle-kit generate --name session_handover`.
- src/auth/tunnel.ts: `overLink` (calls `cameOverHttps`, which is no longer exported since nothing else uses it).
- src/auth/session.ts: `LINK_SESSION_COOKIE`, `sessionCookieOf`, `handOverSession` (with `moveOlderSession`, `needsHandOver`), shared `setSessionCookie` and `clearingOptions`; `startSession` writes `beforeHostCookie: false`; `endSession` and `requirePerson` use `sessionCookieOf`.
- src/app.ts: `FastifyRequest.overLink`, `decorateRequest`, the first `onRequest` hook, the hand-over hook.
- test/helpers.ts: `TUNNEL`, `viaLink`, `sessionFrom` takes either cookie name.
- test/auth.test.ts: new tests (9 new, 1 changed as the plan says), test/migrations.test.ts: 1 new.
- test/migration-history.test.ts, test/migration-metadata.test.ts: see deviation 3.

## Red first

Run on the new tests before any code (auth.test.ts and migrations.test.ts, 10 failed, 50 passed):
- the cookie tests failed because the cookie was `hh_session` over the link (`expected { name: 'hh_session', ... } to match { name: '__Host-hh_session' ...}`), `/api/me` with the link cookie gave 401 instead of 200, and the changed https-only test gave `{ name: 'hh_session', secure: true }` instead of the `__Host-` name;
- the hand-over tests and the localhost test failed in their setup because the column `before_host_cookie` did not exist (`update "sessions" set  where ...`);
- the migration test failed with `column "before_host_cookie" does not exist`.

## Green and Done when

- `light.sh npx vitest run test/auth.test.ts test/people.test.ts test/origin.test.ts test/migrations.test.ts`: 4 files, 85 tests passed.
- `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing. `npm run typecheck:tests` and `npm run lint` print no errors (after fixing two type errors and an unused import in my own tests).
- Whole suite through remote.sh (`npm test -- --testTimeout=90000`): first run had 3 failures in migration-history and migration-metadata (both pin the newest migration, see deviation 3). After the fix those two files pass (6 tests). The other 108 files passed in that first run (1829 passed). I did not rerun the whole suite after the two-file fix.

## Gates (remote.sh, base lanebase)

- crapper: every function I added or changed is at most CRAP 6.0 (buildApp 5.9 is the highest, its complexity pre-exists); the new ones are 4.0 or lower.
- dryer 0.8: No duplicate candidates found.
- mutator, session.ts: 22 killed, 0 survived, 0 uncovered.
- mutator, tunnel.ts: 0 sites in my change. One UNCOVERED at `tunnel.ts:15` (`if (!config.tunnelHost) return false` in `fromTunnel`), a line I did not touch.
- mutator, app.ts: 1 survivor, `app.ts:82 false -> true`, the default of `app.decorateRequest('overLink', false)`. Equivalent: the first onRequest hook always assigns `req.overLink` before anything reads it, so the default is never seen. Left for the lead to rule on.

## Deviations and facts

1. Hook placement. The plan says the hand-over hook runs right after the `overLink` one. It needs `req.cookies`, which the cookie plugin parses in its own onRequest hook, so the hand-over hook is registered after `register(cookie)` and `register(websocket)`, just before `fromOwnPages`. The `overLink` hook is first. A request with `Upgrade` is skipped by the hand-over itself. For 2 T3 (parallel-map row): order is overLink, cookie, socket plugin, hand-over, fromOwnPages; 2 T3 can put its mode check in `handOverSession`.
2. `cameOverHttps` is no longer exported (only `overLink` is). 1b T5 changes `overLink`.
3. Not in the plan's file list: `test/migration-history.test.ts` (migration count 52 to 53, twice) and `test/migration-metadata.test.ts` (latest snapshot `0052_dismissed_command_blocks` to `0053_session_handover`, twice). Both pin the newest migration and fail by design when one is added; the same will happen to 1b T3, T7, 3 T2, 4 T1.
4. Mutator scope. The plan's command includes migrations.test.ts. With it, the baseline run failed on the 30k-row migration 0049 test under default timeouts, and one run of session.ts hit my own 1500 s `timeout`. The final mutator runs used `test/auth.test.ts test/people.test.ts test/origin.test.ts --maxWorkers=1 --testTimeout=90000`. Nothing in migrations.test.ts touches session.ts or app.ts.
5. Burst behaviour as specified: each request that carries the old cookie within the 60 s grace makes its own new session (the old row stays marked until it expires). Fine for the plan, but a burst leaves a few extra session rows.
6. Facts that held: `migrationsUpTo` in `test/migrations.test.ts`; tag before is `0052_dismissed_command_blocks`; no Docker used; no secrets printed.

## Not done

Nothing left from the task. No commit (Step 5 skipped as instructed).

# Fix round 1 (review findings 1 to 6 and two minors)

Read again first: systematic-debugging (for finding 1), test-driven-development, verification-before-completion. Hijacked routes checked with
`grep -rn hijack apps/server/src`: only `modules/events/stream.ts` (`/api/stream`, session cookie, affected) and `modules/tools/mcp.ts`
(`POST /mcp`, signs in by the job's bearer token, never by the session cookie, so nothing to hand over there). Sockets carry `Upgrade` and are skipped.

## Findings

1. Event stream ate the hand-over. Root cause: @fastify/cookie writes the cookies set with `reply.setCookie` in its onSend hook, and a hijacked
   reply never reaches onSend, so the person got 200, no cookie, and an old row cut to 60 s. Test `delivers the new cookie on the event stream, which
   sends its own headers` (real HTTP, `TUNNEL_HOST: 127.0.0.1`, `openStream` with the older cookie). Red: `.toMatch() expects a string, got undefined`
   (no `__Host-hh_session` Set-Cookie on the response). Fix: `handOverSession` now writes both cookies straight into the reply's `set-cookie` header
   (`fastifyCookie.serialize`, same attributes through the shared `sessionCookieOptions`), and `/api/stream` sends the reply's `set-cookie` in its own
   `writeHead` (`eventStreamHeaders`). For normal routes the plugin merges with an existing header. Each reconnect inside the 60 s grace still mints
   one more 30-day row (by plan); the delivered cookie means the browser stops sending the old one after the first, so the orphans no longer pile up.
2. Person's row not locked. Test `holds the person's row while it makes the new session, as a sign-in does` records the statements of the
   transaction (PGlite cannot interleave two) and wants a `from "people"` statement with `for share`. Red: expected false to be true. Fix:
   `moveOlderSession` reads the session's owner, locks the active person `FOR SHARE`, and then locks the session row `FOR UPDATE`: the person's row
   first, the order a reset takes, so no lock cycle. The real concurrent test waits for plan 3's Postgres harness (ledger ruling).
3. Gate conditions. Tests `does nothing when the request already carries __Host-hh_session` and `does nothing for a socket upgrade`. They passed on
   the code as it was (the behaviour existed, no test pinned it). Shown to bite by deleting `!req.cookies[LINK_SESSION_COOKIE]` and then
   `!req.headers.upgrade`: each makes exactly its test fail. Code restored.
4. Clearing asserted. `moves it once` and `refused` now assert `hh_session` value '', `secure`, path `/`, no domain, expiry in the past. Mutant
   without `secure: true` in the serialize call fails both.
5. Effects pinned. New tests: new cookie `httpOnly`, `sameSite: 'Lax'`, about 30 days, row too, old row between 50 and 60 s; a 10 s session stays
   at or under 10 s; another person's marked session is unchanged. Mutants: `least` to `greatest` fails the first two; the `where` cut to `true` fails
   the third.
6. Plain logout. `ends the session and clears the cookie` asserts path `/`, no `Secure`, expiry in the past. Mutant giving `endSession` the
   secure options everywhere fails it.

Minors: the comment sits above `fromOwnPages` again; `sessionFrom` throws on an empty value.

Why the mutator missed 3 to 6: it mutates operators, literals and negations on the changed lines it can see and judges them by whether any test
fails. The removal of a whole `&&` operand whose value tests never varied, the swap of `least` for `greatest` inside a SQL template string, a
`where` clause inside a drizzle call, and object-literal options such as `secure: true` are not sites it generates, so 22 of 22 meant only that the
sites it had were covered. I checked these by hand-made mutants (above).

## Command results

- Focused: auth, people, origin, migrations, access, events tests: all pass (auth.test.ts 33 tests, with the 7 new ones).
- `npx tsc -p apps/server/tsconfig.json --noEmit`, `npm run typecheck:tests`, `npm run lint`: no output / no errors.
- gates (remote, lanebase, 6 test files): 111 tests pass; dryer: no duplicate candidates; crapper: all changed functions under 10 except
  `GET /api/stream` 15.4 (complexity 9, coverage 57 % under these six files). I changed one line of that route (it now calls
  `eventStreamHeaders`) and added no branch; the complexity is the route's own. For the lead to rule. `sessionFrom` in test/helpers.ts was CRAP 20
  and is now 2.5 after I split its predicate out.
- mutator `session.ts`: 24 killed, 1 survived: line 129 `new Date(0)` to `new Date(1)` in the clearing cookie, equivalent (still a time in the
  past). mutator `stream.ts`: no mutable sites on the changed lines; `app.ts` unchanged since round 0 except a comment move.
- Whole suite through remote.sh `hh-suite.sh` (label p1bt1-r2-suite): release checks pass; typecheck:tests passes; workspaces: server 110 files /
  1839 tests, node 49 / 767, protocol 5 / 127, web 87 / 1206, all pass.

Files touched this round: src/auth/session.ts, src/modules/events/stream.ts, src/app.ts (comment), test/auth.test.ts, test/helpers.ts.
No staging, no commit.

# Fix round 2 (review round 2: three Important and one Minor)

Read systematic-debugging again first. Response paths walked: sign-in and setup and invite acceptance (`startSession`), logout (`endSession`), a plain
reply, the event stream, `/mcp` and any later hijacked route, a socket upgrade (skipped).

Root cause of finding 1: fix 1 wrote the hand-over's cookies with `reply.header('set-cookie')`, a second channel next to the cookie plugin's
`setCookie` list that `startSession` and `endSession` use. The plugin appends to the header, so two `__Host-hh_session` cookies went out, and
the hand-over had already made a session for the older person, who in a sign-in, an invite or a sign-out is not the person the request means.

Fix, one shape (all in `src/auth/session.ts`; `src/modules/events/stream.ts` is back to its original, outside the task's files):
- The hand-over uses the cookie plugin like everybody. The plugin keys its list by name, domain and path, so a route that sets or clears
  `__Host-hh_session` itself replaces the hand-over's cookie: at most one in a response, and it is the one the request means.
- The hand-over remembers `{ from, to }` for the request (a WeakMap). `startSession` deletes `to` once its own session exists; `endSession` deletes the
  cookie's session and `from`. So a sign-in leaves the older row (cut to 60 s) and its own one; an invite leaves Maria's one and the older row of the
  other person; a logout leaves nothing.
- Hijack (finding 2): the hand-over wraps `reply.hijack` of that request so that, when a route hijacks, the cookies are first put into the raw response
  with `setHeader('set-cookie')`. Node's `writeHead(status, headers)` merges with `setHeader` values and its own value wins only for a header it names, so the
  stream (which names no set-cookie) and `/mcp` keep the cookies; a route that names `set-cookie` itself in `writeHead` is its own choice. I did not
  use `setHeader` for ordinary replies: Fastify's `writeHead` with the plugin's `set-cookie` would replace it, which is the same two-channel trap.

Tests (all in test/auth.test.ts), red first on the old code:
- sign-in, invite acceptance and logout with an older cookie over the link: each failed with `expected [ {...}, {...} ] to have a length of 1 but got 2`.
  They also check the sessions table: sign-in two rows, invite one row for each person and none new for the older person, logout none.
- a route that hijacks and writes only `writeHead(200)`: red with `expected [] to deeply equal [ '__Host-hh_session', 'hh_session' ]`. It stays green with
  the stream test; with the delivery removed, both the stream test and this one fail.
- finding 3: the lock test now asserts status 200, exactly one transaction, and the order `select ... from "people" ... for share`, then `select ... from
  "sessions" ... for update`, then `insert into "sessions"`, through `statements()` of test/helpers.ts. It passed on the first run because the code
  already took that order (fix round 1); it fails if the person lock is dropped (shown in round 1 with the earlier form of the test).
- Minor: unknown `hh_session` over the link: 401, only `hh_session` cleared, the sessions table unchanged (pins `if (!owner) return null`).

Results: tsc, `npm run typecheck:tests`, `npm run lint`: clean. Focused tests (auth, people, origin, migrations, access, events): 116 pass.
gates-hornhoof.sh through remote.sh (label p1bt1-r4-gates, auth, people, origin, migrations, access, events, conversation, decisions, notebook, socket
tests): dryer no duplicate candidates; crapper: every function of session.ts and app.ts under 10 (requirePerson 8.2 highest); the stream route is not
in the changed files now. In test/helpers.ts the report lists `agentSqlOn` 12.0 and `openStream` 10.1, functions I did not touch (the file counts as changed);
for the lead to rule. No mutator, no whole suite, as told. Nothing staged or committed.
