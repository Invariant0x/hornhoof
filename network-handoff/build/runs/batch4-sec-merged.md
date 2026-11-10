# Batch 4, sign-in, TLS and ACME: what the lead accepted from its one review

Readers: limits slice, Claude fable (`runs/batch4-limits-claude.md`) and Antigravity Argon high (`runs/batch4-limits-agy.md`); ACME slice, the same two (`runs/batch4-acme-claude.md`, `runs/batch4-acme-agy.md`). Critical: none. One fix round, each from a test that fails first. No third round.

## Important

1. **IPv4-mapped IPv6 addresses share one counting bucket.** (Antigravity, reproduced; Claude had it as a Minor since frp gives none today) `readProxyV2` writes family 0x21 as eight plain hex groups, `addressKey` knows only the `::ffff:a.b.c.d` form, so every such visitor lands in `0:0:0:0::/64`, with `::1`. One stranger's 30 failures lock out the CEO and everyone in that shape for 60 minutes. Parse a colon address into its 8 groups, once: IPv4-mapped forms count by their IPv4, others by the /64. A pure function, direct tests, also on `readProxyV2`'s own output.
2. **The seam test is still a todo.** (both) `link-listener.test.ts`'s `it.todo`: 30 wrong sign-ins across distinct emails from the PROXY header's visitor, through LinkListener: the 31st from that visitor is 429, another visitor 401; and with `TUNNEL_HOST` elsewhere the header is not believed. T3 is in the base now.
3. **The 100-at-once test does not show one transaction.** (Claude) It checks that the lock statement is next to the insert; with `db.transaction` removed it still passes on PGlite's one connection, while on a real pool the lock releases at once and a burst gets past the limit. Show that the lock and the insert run inside one transaction by spying what opens it, as far as PGlite lets you. A real concurrent test comes with plan 3's Postgres harness: leave a one-line note where it belongs.
4. **`account()` swallows too much.** (Antigravity; Claude finds the writer's way right for the first call) The lead's ruling, meeting both: while no URL was held at the start of the call, keep the writer's way: the follow-up update's refusal is ignored only after this very call got the URL, and it leaves no `lastProblem` behind. When a URL is already held, make no createAccount call and return it: nothing is verified, and nothing false is said. Any failure of the create itself is thrown as today. `onlyReturnExisting` is not taken: an extra request and its own swallow, for nothing the app needs.
5. **A long challenge token misses its route.** (Antigravity, reproduced) TOKEN allows 128 characters, Fastify's default `maxParamLength` is 100, so a 101 to 128 character token gets `index.html` and issuance fails. Route `/.well-known/acme-challenge/*`, keep TOKEN's bound. Test: 128 answers 200 text/plain, 129 answers 404. Keep before-sign-in's sweep right.

## Minor: while you are there

`longestWait` seeds from the first wait, so a 60-minute limit in its last second does not say 15 minutes. `retryAfterSeconds` does not hand a non-date to Date.parse. `problemOf`'s content type is case-insensitive. `closedPort()` once in helpers, if that does not widen your check. Correct the 1b T3 commit's claim about invites in your message: only sign-ins moved to the database.

## Deferred (ledger)

A failed tunnel lookup counts every link visitor as the tunnel's address; main.ts dies on a malformed stored link URL or a taken 8443 after 8080 is up; `listener.use(null, null)` makes the stand-in twice at start; T7 or T8 re-finds the account on accountDoesNotExist; ari's non-JSON directory reads as no ARI; an order invalid at finalize reads unreachable; the sweep cannot see the challenge route.
