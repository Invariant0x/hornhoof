# Review: batch 4, slice limits (1b T3 sign-in limits, 1b T5 TLS listener), Claude reader

Read only. Package `runs/batch4-limits.diff`, branch batch-4 in the hornhoof clone. No test run of my own: every claim below is from
named lines, and the lead's suite run stands.

Counts: Critical 0, Important 2, Minor 6.

## Critical

None found.

## Important

### I1. The seam test of T3 and T5 is still an `it.todo`

`apps/server/test/link-listener.test.ts:1090` (diff line; file line 195 of the test): `it.todo('counts the limit of 30 an hour per
address by the visitor of the PROXY header')`. T5's writer held it because T3 was not in the lane; both are on batch-4 now, and the
plan's Step 1 of Task 5 names this test: 30 wrong sign-ins with emails `x<i>@acme.com` from visitor `203.0.113.7`, then a wrong one
from `203.0.113.7` is 429 and from `203.0.113.8` is 401; on an app with `TUNNEL_HOST: '192.0.2.10'` the same 30 make `203.0.113.8`
429, since both are `127.0.0.1` there.

What a person would get: the per address limit is the one that stops a guesser who spreads tries over many emails on a company's
link, and no test proves it over the listener. The existing test `takes the visitor from the PROXY header of the tunnel container
only` (test lines 1077 to 1087) proves the header's address reaches `clientAddress` through today's 10 per email and address limit,
and by reading `tunnel.ts:636-642` with `sign-in-limit.ts:142-146` the 30 limit follows from the same argument, so I expect the
code is right. It is a gap against the brief, not a bug found.

What would make it right: write the plan's test in place of the todo (both halves) and drop the `LIMITED_AFTER` form or keep it
beside it.

### I2. The 100-at-once test passes with the lock outside a transaction

`apps/server/test/sign-in-limit.test.ts:552-558`: the test checks that the statement right before each insert is
`SELECT pg_advisory_xact_lock(...)` with `[SIGN_IN_LOCK]`. The plan's test asks for "pg_advisory_xact_lock before its insert, in one
transaction, which is what holds the limit on a pool". The transaction is not checked: PGlite's `client.transaction` issues
BEGIN and COMMIT itself (`drizzle-orm/pglite/session.js:114-128`), not through `PglitePreparedQuery.execute`, so the `statements()`
spy (`test/helpers.ts:46`) never sees them. If `insertIfUnder` (`sign-in-limit.ts:175-184`) lost its `db.transaction` wrapper and
ran the lock and the insert as two plain statements, the two would still be adjacent in the log and PGlite's one connection would
still answer exactly 30 and 70, so the test passes. On Postgres with a pool, `pg_advisory_xact_lock` outside a transaction block is
released when its own statement ends, the inserts of a burst take their snapshots without waiting for each other, and more than 30
of 100 wrong sign-ins from one address reach the password check.

What a person would get: a guesser's burst gets past the limit the task promises, and nothing in CI would say so.

What would make it right: have the test see the transaction as well, for example a `vi.spyOn(PGlite.prototype, 'transaction')`
counted at 100, or let `statements()` record whether `this.client` was the PGlite instance or a transaction handle and assert the
lock and the insert share one.

## Minor

- M1. `apps/server/src/modules/tls/proxy-header.ts:860-861` and `apps/server/src/auth/sign-in-limit.ts:142-146`: an IPv4 mapped
  IPv6 source in a TCP over IPv6 header comes out as `0:0:0:0:0:ffff:cb00:7107` and `addressKey` folds it, and `::1`, to
  `0:0:0:0::/64`, one key for every such visitor. frp's go-proxyproto sends a mapped IPv4 as family 0x11, so no case today; a fold
  of `0:0:0:0:0:ffff:x:y` to its dotted IPv4 in `addressKey` would close it for good.
- M2. `apps/server/src/modules/tls/listener.ts:731-744`: `isTunnelAddress` does a DNS lookup for every new connection, and when the
  lookup fails every link visitor is counted as the tunnel container's address, so 30 wrong sign-ins from anyone lock the whole link
  for an hour. The 8080 path has had the same fallback since before; T3's address limit makes it bite harder. A short cache of the
  lookup and a log line on the fallback would help.
- M3. `apps/server/src/main.ts:675`: `new URL(publicLink.url).hostname` throws on a malformed stored link and the app dies at start;
  the plan's "fail toward a working link" would rather take `null` there.
- M4. `apps/server/src/main.ts:672-673`: when port 8443 cannot be bound the app dies after 8080 is already up, so a one machine
  install loses its 8080 for a port it does not use. A logged warning and going on without the listener would keep the Global
  Constraint on port 8080.
- M5. T3's rulings (`rowsIn`, the SQL built from one table of scopes and windows, `longestWait`'s default answer, the form of the
  statement order check) are in `runs/p1bt3-report.md`, and T5's are in its commit message; neither set is in
  `network-build/progress.md`, which the brief names as the ledger.
- M6. The writer of T3 reports one dryer pair at 1.00, `apps/server/src/db/agent-sql.ts:78-99` and `:103-111`, in code older than
  this task, left as is. Not of this task; noted so the lead can rule.

## Checked and found right

- `readProxyV2` (`proxy-header.ts`): signature, version and command at 12, length at 14 and 15 at most 512, family 0x11 needing
  12 and 0x21 needing 36, `more` for fewer bytes, `source: null` for LOCAL and other families; the buffer it is given is bounded
  (`more` only below 16 + following, following at most 512), no index can go past the buffer, nothing throws. Tests cover each
  refusal, including a declared length of 600 before its bytes come.
- The header is believed only from the tunnel container's address (`listener.ts:741-744`); a visitor cannot write one, since frpc
  sends it first and the visitor's bytes come after; X-Forwarded-For over the listener is ignored (`tunnel.ts:636-639`, test at
  1092 to 1098). `addressKey` reads the header's IPv6 form (eight groups, no `::`) as the right /64.
- `signInTry`: delete older than an hour, then lock as its own statement and one guarded insert in one transaction, the wait from
  the oldest row of each full limit; the login route takes it in place of both `guard` calls and takes the try back once the session
  started; `limiter` and `guard` stay for invites; `HIDDEN` gains the table and both orchestrator lists check it.
- Migration 0054 with its snapshot and journal entry, next in the chain after 0053; `migration-history` and `migration-metadata`
  bumped.
- No em dash, no private name or address (documentation ranges only), no key value in any test message; no Docker; no relay file.
- Gates by the writers' logs: T3 worst changed CRAP 9.0 (login route), T5 8.0; dryer none in T5, one old pair in T3 (M6).
