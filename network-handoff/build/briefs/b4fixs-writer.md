# How this build works now: conveyor v4, Ivan's word

Rules that bind you, not optional: `/home/altera/hornhoof-network/CLAUDE.md`, the build rulings below, and
`/home/altera/hornhoof-network/FROM-DAVID-conveyor-v4.md`, sections 2 to 4. You are a fresh writer for one task, in your own lane, your own clone of
the repository, on the branch `task-<lane>`. Other writers work beside you in theirs. Do not touch the real repositories or another lane.

**Skills.** Before you write a line, read and follow, and name in your hand-in: `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion`, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`. For Hornhoof also `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.

**The task's kind** is in your notes. Known behaviour, nearly every task, since plans give exact tests: test-first, as the plan says. A bug: a failing test that reproduces it, then the fix. An unknown way (a library or protocol not used here yet): one acceptance test from the plan first, then make it work, split into pure functions, cut what is extra, then direct fast tests on the pure functions. Old code with no tests: characterization tests first, then structural commits apart from behaviour commits.

**How to write tests.** Uncle Bob's way, without chasing coverage. Logic in a pure function, tested directly, with no database and no process. One or two integration tests per route or seam, for what only they can show, not one per branch. A test checks what a person of the code would see; if it would pass with the code wrong, throw it out. No test only to cover a line or raise a number. To get a function under CRAP 10, split it first. Tests are deterministic: nothing depends on the date, the time zone, the order of tests, randomness or ids; a flaky test is fixed at its cause, never retried. Old tests are not rewritten. Never a secret in a test's message: compare with booleans.

**While you work,** run a few tests at a time from your lane with `/home/altera/hornhoof-network/network-build/light.sh <command>`, with at most `--maxWorkers=2`. You do not run a repository's whole suite, and you do not run mutator.

**Hand-in, one command, once, on your final commit:**

1. Commit your work on your branch: write the message to a file (English, a subject as the plan's Commit step names it, then why; no trailers; no em dashes), then `/home/altera/hornhoof-network/network-build/lane.sh commit <lane> <file>`.
2. The author check, on that commit. Hornhoof: `REMOTE_HORNHOOF_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof && /home/altera/hornhoof-network/network-build/author-check.sh lanebase'`. Relay: `REMOTE_EDGE_TREE=/home/altera/hornhoof-network/wt/<lane> /home/altera/hornhoof-network/network-build/remote.sh run <lane>-check 'cd /home/altera/hornhoof-network/hornhoof-edge && /home/altera/hornhoof-network/network-build/author-check-relay.sh lanebase "<the unittest modules your change reaches>"'`. It may queue. Start it in the background and wait with `/home/altera/hornhoof-network/network-build/remote-wait.sh <lane>-check` in the foreground, calling it again while it says WAITING. Never end your turn while it is pending.
3. Red: at most two tries to fix your own red, each commit followed by the check. Still red: stop and tell the lead.

**Reply to the lead:** the status (DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT), the commit, and the log path `network-build/runs/remote-<lane>-check-*.log`, in at most five lines. That log on that commit is the evidence, and nobody reruns it. There is no review agent per task; tasks land in batches, and the batch gets one review and one fix round. A deviation from the plan, and every place where the plan proved wrong, goes in your commit message's body and your reply, as a line `Ruling: <what> - why: <why> - cost if wrong: <cost>`. Never push. No subagents.

# Your task: batch 4 fix round: sign-in, TLS, ACME

Lane `/home/altera/hornhoof-network/wt/b4fixs`, from batch-4, branch `task-b4fixs`. Kind: bugs. Security class. Your whole list, with rulings: `/home/altera/hornhoof-network/network-build/runs/batch4-sec-merged.md`, the two reviews of each slice beside it. Commit subject: "Count IPv4 visitors by their address, read a long challenge token, and say nothing false about an account". Never print a key.

# How you work (writer)

The top of your notes says how; a task's "Commit" step is your hand-in's commit. Change only the task's files. No `npm install`/`npm ci` unless the task names a dependency to add. Never run prettier or any formatter. Shell is bash on Debian Linux, x86_64, GNU tools. Python for the relay: standard library only, runnable on Python 3.12 (`/home/altera/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12`; 3.14 at `/home/altera/hornhoof-network/quality/python/cpython-3.14-linux-x86_64-gnu/bin/python3.14`). There is no pytest. Stop and report when a fact the task rests on proves wrong in the code.
### Task 3: Sign-in limits in the database, per address too

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sign-in-limit.test.ts test/auth.test.ts
test/limit.test.ts test/orchestrator-control.test.ts test/migrations.test.ts` passes, and `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/auth/sign-in-limit.ts`, the migration from `npx drizzle-kit generate --name
  sign_in_attempts`
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/modules/auth/routes.ts`, `apps/server/src/db/agent-sql.ts`
  (`HIDDEN` gains `sign_in_attempts`)
- Test: `apps/server/test/sign-in-limit.test.ts` (new), `apps/server/test/orchestrator-control.test.ts` (both lists of
  refused statements gain `SELECT * FROM sign_in_attempts`)

**Interfaces:**
- Consumes: `clientAddress(req, config)`, `hashToken` (`crypto/tokens.ts`).
- Produces:
  ```ts
  // db/schema.ts
  export const signInAttempts = pgTable('sign_in_attempts', {
    id: id(),
    emailHash: text('email_hash').notNull(),
    addressHash: text('address_hash').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  }, t => [index('sign_in_attempts_email').on(t.emailHash, t.at), index('sign_in_attempts_address').on(t.addressHash, t.at), index('sign_in_attempts_at').on(t.at)]);
  // auth/sign-in-limit.ts
  export const SIGN_IN_LIMITS = {
    emailAddress: { max: 10, windowMs: 15 * 60_000 },
    email: { max: 50, windowMs: 60 * 60_000 },
    address: { max: 30, windowMs: 60 * 60_000 },
  } as const;
  export const SIGN_IN_LOCK = 0x68680001;  // the pg_advisory_xact_lock key of sign-in tries, used for nothing else
  export function addressKey(address: string): string;  // IPv4 and ::ffff:IPv4 as the IPv4 text; IPv6 as its /64
  export async function signInTry(db: Db, email: string, address: string): Promise<{ allowed: true; id: string } | { allowed: false; retryAfterS: number; windowMs: number }>;
  export async function signInWorked(db: Db, id: string): Promise<void>;  // the try is deleted
  ```
- `signInTry` first deletes rows older than an hour, then, in one short transaction, runs `SELECT
  pg_advisory_xact_lock(SIGN_IN_LOCK)` as a statement of its own and then one insert that writes the try only while
  all three counts are under their `max`, with `now()` from the database; the commit lets the lock go before the
  password is checked. Under read committed each statement takes a new snapshot, so the insert, run after the lock,
  sees every try committed before it, and the limits hold exactly however many connections the pool has:
  ```sql
  INSERT INTO sign_in_attempts (email_hash, address_hash)
  SELECT $e, $a
  WHERE (SELECT count(*) FROM sign_in_attempts WHERE email_hash = $e AND address_hash = $a AND at > now() - interval '15 minutes') < 10
    AND (SELECT count(*) FROM sign_in_attempts WHERE email_hash = $e AND at > now() - interval '1 hour') < 50
    AND (SELECT count(*) FROM sign_in_attempts WHERE address_hash = $a AND at > now() - interval '1 hour') < 30
  RETURNING id
  ```
  with `$e = hashToken(email)` and `$a = hashToken(addressKey(address))`. With no row back it reads which limits are
  full; for each, the wait is its oldest row in its window plus the window, minus now, rounded up to whole seconds; it
  answers the longest of those waits as `retryAfterS`, with that limit's `windowMs`. The login route calls `signInTry`
  in place of both `guard` calls, answers 429 `too_many_attempts` with `retry-after` and the message `Too many attempts.
  Wait up to <windowMs in minutes> minutes, then try again.` when not allowed, and calls `signInWorked` once the session
  started. `limiter` and `guard` stay for invites.

- [ ] **Step 1: Write failing tests** in `sign-in-limit.test.ts`:
  - `reads an address as the limit counts it`: `addressKey('203.0.113.5')` is `203.0.113.5`;
    `addressKey('::ffff:203.0.113.5')` is `203.0.113.5`; `addressKey('2001:db8:1:2:3:4:5:6')` and
    `addressKey('2001:0db8:0001:0002::ffff')` are both `2001:db8:1:2::/64`; `addressKey('2001:db8::1')` is
    `2001:db8:0:0::/64`; `addressKey('::1')` is `0:0:0:0::/64`.
  - `stops one address after 30 failed sign-ins in an hour across emails`: 30 wrong passwords from `203.0.113.5`, each
    with another email `x<i>@acme.com`, all 401; then the CEO's right password from `203.0.113.5` is 429 with
    `retry-after` above 15 minutes; from `198.51.100.20` it is 200.
  - `counts an IPv6 visitor by its /64`: 30 wrong from `2001:db8:1:2::<i>`; `2001:db8:1:2::ffff` is 429,
    `2001:db8:1:3::1` is 401 for a wrong password.
  - `keeps the counts across a restart`: 10 wrong for `ivan@acme.com` from `203.0.113.5` on one app; a second
    `buildApp` on the same database gives 429 for the right password from that address.
  - `does not count a sign-in that worked`: 9 wrong, then the right one (200), then one wrong (401), then the right one
    is 429.
  - `forgets tries older than an hour`: 30 rows put straight into `sign_in_attempts` for `203.0.113.5` with `at` 61
    minutes ago; a sign-in from there is 200 and the table holds none of those rows.
  - `keeps no email or address in the clear`: after one wrong try, no column of any row contains `ivan@acme.com` or
    `203.0.113.5`.
  - `lets 30 of 100 wrong sign-ins at once from one address reach the password check`: 100 logins with
    `Promise.all`, emails `x<i>@acme.com`, from `203.0.113.7`: exactly 30 answer 401 and 70 answer 429. PGlite has one
    connection, so the test also reads the statements run (the log in `test/helpers.ts:40`): each try's
    `pg_advisory_xact_lock` comes before its insert, in one transaction, which is what holds the limit on a pool.
  - The existing limit tests in `auth.test.ts` stay as they are and pass.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/sign-in-limit.test.ts`. Expected: FAIL
  (`signInTry` does not exist).
- [ ] **Step 3: Implement** the table, then `npx drizzle-kit generate --name sign_in_attempts` from `apps/server`,
  then `sign-in-limit.ts`, the route and `HIDDEN`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Count failed sign-ins in the database, per address too, so a restart does not reset them".

### Task 5: The TLS listener behind the tunnel

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Tasks 3 and 4 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/proxy-header.test.ts test/link-listener.test.ts
test/auth.test.ts` passes, and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tls/proxy-header.ts`, `apps/server/src/modules/tls/listener.ts`
- Modify: `apps/server/src/auth/tunnel.ts` (`overLink`, `cameOverHttps`, `clientAddress`), `apps/server/src/main.ts`
- Test: `apps/server/test/proxy-header.test.ts`, `apps/server/test/link-listener.test.ts` (both new)

**Interfaces:**
- Consumes: `selfSigned` (Task 4); `overLink` (Task 1); the address limit (Task 3).
- Produces:
  ```ts
  // proxy-header.ts
  export type ProxyHeader = { state: 'more' } | { state: 'bad' } | { state: 'done'; length: number; source: string | null };
  export function readProxyV2(buf: Buffer): ProxyHeader;
  // listener.ts
  export const LINK_TLS_PORT = 8443;
  export function linkVisitor(socket: unknown): string | undefined;  // set for every socket the listener handed to Fastify
  export class LinkListener {
    constructor(opts: { app: FastifyInstance; config: Config; log: FastifyBaseLogger });
    listen(port: number, host?: string): Promise<number>;   // host defaults to 0.0.0.0; gives the port it got
    use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void>;  // for new connections; null cert: a stand-in for host, or hornhoof.invalid
    close(graceMs?: number): Promise<void>;  // stops taking connections at once; resolves when its connections end, destroying those left after graceMs (default 5000)
  }
  ```
- `readProxyV2`, by offsets from 0: the 12-byte signature `0d0a0d0a000d0a515549540a` at 0 to 11; at 12, version 2 in
  the high nibble (else `bad`) and command 0 (LOCAL: `source: null`) or 1 (PROXY) in the low one (anything else
  `bad`); the family at 13; the length of what follows at 14 and 15, big endian, at most 512 (else `bad`); `length` is
  16 plus that, TLVs included. Family `0x11` (TCP over IPv4) needs a length of at least 12 and gives the dotted address
  at 16 to 19; `0x21` (TCP over IPv6) needs at least 36 and gives the eight groups at 16 to 31 in lowercase hex
  without leading zeros and without `::`; a shorter length is `bad` (PROXY protocol 2.2); any other family gives
  `source: null`. Fewer bytes than needed give `more`. It never throws, and a `bad` closes only that connection.
- The listener reads into a buffer until `readProxyV2` says `done` (closing on `bad`, or after 5 s without a whole
  header), stops reading, `unshift`s the rest, wraps the socket in `new tls.TLSSocket(raw, { isServer: true,
  secureContext, ALPNProtocols: ['http/1.1'] })` (closing it when the handshake takes over 10 s), records the visitor
  for that TLS socket in a `WeakMap`, and on `secure` hands it to Fastify with `app.server.emit('connection',
  tlsSocket)`. The visitor is the header's `source` when the raw socket's address is the tunnel container's (looked up
  from `config.tunnelHost` as `fromTunnel` does) and the source is not null; otherwise the raw socket's address.
  Node 22 feeds bytes `unshift`ed before the wrap into the TLS socket (checked while planning, with the header and the
  ClientHello in one segment and in two). `listen` makes the `hornhoof.invalid` stand-in before it listens, so no
  connection finds no certificate; `use` resolves once new connections get the new one (`selfSigned` is async).
- In `auth/tunnel.ts`: `cameOverHttps` and `overLink` are true when `linkVisitor(req.socket)` is set;
  `clientAddress` gives `linkVisitor(req.socket)` first.
- `main.ts`, after `app.listen`: a `LinkListener` on `LINK_TLS_PORT`, `await use(<the link's host name or null>,
  null)`, and on SIGINT and SIGTERM `const closing = listener.close()`, then `await app.close()` (whose hooks end the
  event streams and WebSockets), then `await closing`. (Task 8 replaces the `use` call.)

- [ ] **Step 1: Write failing tests.** `proxy-header.test.ts`, `readProxyV2`:
  - IPv4 PROXY from `203.0.113.7:51000` to `127.0.0.1:8443`: `{ state: 'done', length: 28, source: '203.0.113.7' }`;
    with 7 bytes of TLV after the addresses, `length: 35`.
  - IPv6 from `2001:db8::7`: `length: 52`, `source: '2001:db8:0:0:0:0:0:7'`.
  - LOCAL: `source: null`; family `0x00`: `source: null`.
  - the first 10 bytes, or 20 bytes of an IPv4 header: `more`.
  - a wrong signature, version 1, command 2, length 600: `bad`; IPv4 with a length of 0 or 11, and IPv6 with 0 or
    35, given all their bytes: `bad`, without a throw.
  `link-listener.test.ts`, on `testApp({ TUNNEL_HOST: '127.0.0.1' })` with a company set up and a `LinkListener` on
  port 0 bound to `127.0.0.1`, through a helper that connects, writes a PROXY v2 header for a given visitor and opens
  TLS over that socket with `servername: 'acme.hornhoof.org'`, `rejectUnauthorized: false`:
  - `serves a stand-in for the link's host until it is given a certificate`: right after `listen`, the peer
    certificate's SAN is `DNS:hornhoof.invalid`; after `await use('acme.hornhoof.org', null)` it is
    `DNS:acme.hornhoof.org` and its issuer is its subject; after `await use(...)` with `await
    selfSigned('acme.hornhoof.org', { serial: '0a0b' })`, a new connection sees serial `0A0B`.
  - `answers as over the link`: `GET /api/health` gives exactly `{ ok: true }`; a sign-in sets `__Host-hh_session`.
  - `takes the visitor from the PROXY header of the tunnel container only`: 30 wrong sign-ins with emails
    `x<i>@acme.com` from visitor `203.0.113.7`, then a wrong one from `203.0.113.7` is 429 and from `203.0.113.8` is
    401. On a second app with `TUNNEL_HOST: '192.0.2.10'` the same 30 from `203.0.113.7` make `203.0.113.8` 429, since
    both are `127.0.0.1` there.
  - `closes a connection with no header in 5 s, and a bad header at once`: one that sends nothing closes within 6 s;
    one that sends `GET / HTTP/1.1\r\n` closes within 1 s.
  - `carries a WebSocket upgrade`: the same raw upgrade request for `/api/nodes/socket` (headers `Upgrade: websocket`,
    `Connection: Upgrade`, `Sec-WebSocket-Version: 13`, a `Sec-WebSocket-Key`) gets the same status line through the
    listener as through `listen(app)` over plain http.
  - `stops taking connections when closed`: after `close()`, a connect is refused; `close(200)` with a TLS connection
    still open resolves within 1 s, and that connection is closed.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/proxy-header.test.ts
  test/link-listener.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** the interfaces and the `main.ts` lines.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Serve the link over TLS on port 8443, with the visitor's address from the PROXY header".

### Task 6: ACME through acme-client, renewal information on top, tested against Pebble

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/challenges.test.ts test/ari.test.ts
test/acme-fake.test.ts` passes; from the worktree root `npm run test:real` passes with Docker running, and the output
of `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000` names no file under `test/real/`; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tls/challenges.ts`, `apps/server/src/modules/tls/acme.ts`,
  `apps/server/src/modules/tls/ari.ts`, `apps/server/test/real/run.sh`, `apps/server/vitest.real.config.ts`
- Modify: `apps/server/src/app.ts` (`ctx.challenges`, the route), `apps/server/vitest.config.ts` (exclude
  `test/real/**`), `apps/server/package.json` (`"test:real": "sh test/real/run.sh"`), `package.json`
  (`"test:real": "npm run build -w @hornhoof/protocol && npm run test:real -w @hornhoof/server"`),
  `.github/workflows/images.yml` (job `test-real`; `images` needs `[test, test-real]`), `CONTRIBUTING.md` (one line:
  `npm run test:real` needs Docker and runs the tests against Pebble)
- Test: `apps/server/test/challenges.test.ts`, `apps/server/test/ari.test.ts`, `apps/server/test/acme-fake.test.ts`,
  `apps/server/test/real/acme.test.ts`

**Interfaces:**
- Consumes: `selfSigned`, `certInfo` (Task 4); from `acme-client`: `Client`, `crypto.createPrivateEcdsaKey`,
  `crypto.createCsr`, `directory.letsencrypt.production`, `axios`; from `@peculiar/x509`: `X509Certificate`,
  `AuthorityKeyIdentifierExtension`.
- Produces:
  ```ts
  // challenges.ts
  export class Challenges { answer(token: string, keyAuthorization: string): void; forget(token: string): void; get(token: string): string | undefined }
  export function challengeRoutes(app: FastifyInstance, challenges: Challenges): void;
  // GET /.well-known/acme-challenge/:token, token /^[A-Za-z0-9_-]{1,128}$/: 200 text/plain with the key authorization, else 404
  // app.ts: Ctx gains challenges: Challenges
  // acme.ts
  export const LETS_ENCRYPT: string;  // acme.directory.letsencrypt.production
  export type ChallengeHooks = { answer(token: string, keyAuthorization: string): void; forget(token: string): void };
  export type AcmeErrorKind = 'not_ready' | 'refused' | 'invalid' | 'unreachable';
  export class AcmeError extends Error {
    constructor(kind: AcmeErrorKind, opts?: { type?: string | null; retryAfterS?: number | null; detail?: string });
    readonly kind: AcmeErrorKind;
    readonly type: string | null;          // the problem document's type, like urn:ietf:params:acme:error:rateLimited
    readonly retryAfterS: number | null;   // from Retry-After, in seconds
  }
  export function newAccountKey(): Promise<string>;  // a P-256 key, PKCS#8 PEM
  export type Backoff = { attempts: number; min: number; max: number };  // acme-client's backoffAttempts, backoffMin, backoffMax (ms)
  export class AcmeAccount {
    constructor(directoryUrl: string, accountKeyPem: string, accountUrl?: string | null, opts?: { backoff?: Backoff });
    account(): Promise<string>;  // the account URL: made with termsOfServiceAgreed and no contact, or found by its key
    issue(host: string, hooks: ChallengeHooks, opts?: { replaces?: string; selfCheck?: boolean }): Promise<{ certPem: string; keyPem: string }>;
    //   certPem: the chain; keyPem: the certificate's new P-256 key, PKCS#8; selfCheck defaults to true
  }
  // ari.ts
  export type RenewalWindow = { start: Date; end: Date; retryAfterS: number };
  export function certIdFrom(keyIdentifierHex: string, serialHex: string): string;  // RFC 9773 4.1
  export function certId(certPem: string): string | null;  // null when the certificate has no authority key identifier
  export function renewalInfo(directoryUrl: string, certPem: string): Promise<RenewalWindow | null>;  // null: no renewalInfo
  ```
- `acme.ts`, once at module load, on `acme.axios` (with one cast, since acme-client's types know no `acmeSettings`):
  `defaults.acmeSettings.retryMaxAttempts = 0`, `defaults.timeout = 15000`, and one response handler added after
  acme-client's own (Open points 1 and 2). For every answer it keeps `{ status, type, detail, retryAfterS }` when the
  `content-type` starts with `application/problem+json` and the body's `type` is a string, and null for any other
  answer and for a request that got none. Retry-After is seconds or an HTTP date. acme-client's request handler makes
  every ACME answer, 4xx included, reach the fulfilled side; a request with no answer reaches the rejected side.
- One `new acme.Client({ directoryUrl, accountKey, accountUrl, backoffAttempts, backoffMin, backoffMax })` per
  `AcmeAccount`, with `opts.backoff` or `{ attempts: 10, min: 2000, max: 10000 }`, about 74 s for the self-check and
  for each wait for a status.
- `account()`: `createAccount({ termsOfServiceAgreed: true })`, then `getAccountUrl()`.
- `issue`, in this order: `account()` when no URL is held; `createOrder({ identifiers: [{ type: 'dns', value: host }]
  })` with `replaces` added when given (a variable typed `Parameters<acme.Client['createOrder']>[0] & { replaces?:
  string }`, since that type has no such field and the package root does not export it); `getAuthorizations(order)`; for
  each authorization not yet `valid`: its `http-01` challenge (none: `refused`),
  `getChallengeKeyAuthorization(challenge)`, `hooks.answer(token, keyAuthorization)`, when `selfCheck`
  `verifyChallenge(authz, challenge)`, whose throw gives `not_ready` before the challenge is completed, then
  `completeChallenge(challenge)` and `waitForValidStatus(authz)`; `hooks.forget` for every answered token in a
  `finally`; then `createPrivateEcdsaKey('P-256')`, `createCsr({ altNames: [host] }, key)` (no common name), `const
  finalized = await finalizeOrder(order, csr)`, `getCertificate(finalized)`, and `{ certPem, keyPem: key.toString() }`.
  `finalizeOrder` answers a new object and leaves `order` as it was, and an order that was `ready` from the start has no
  certificate URL of its own (`src/client.js:351-365`, `:598-607`), so `getCertificate` takes `finalized`, as
  acme-client's own `src/auto.js:180-181` does.
- Errors: a throw from any step but the self-check becomes an `AcmeError`. A kept problem with a status below 500 gives
  `refused` with its `type` and `retryAfterS`. When `waitForValidStatus(authz)` threw with none kept, the authorizations
  are read again: an `invalid` one gives `invalid` with its `http-01` challenge's `error.type`. Anything else (a 5xx,
  no answer, a timeout, still pending after the backoff) gives `unreachable`, with the kept problem's `type` and
  `retryAfterS` when there was one. The message is `acme <kind>` and the problem's `detail` (else acme-client's
  message) cut to 200 characters; never a key, a CSR or a JWS.
- `ari.ts`: `certIdFrom` is base64url without padding of the key identifier, a `.`, and base64url without padding of
  the serial's DER content octets. `certId` reads the first certificate of the chain with `@peculiar/x509`: the
  `AuthorityKeyIdentifierExtension`'s `keyId`, and `serialNumber` with `00` put back in front when its first byte is
  `80` or more (`@peculiar/x509` 1.14.3 strips that byte, `build/x509.cjs.js:2482`, and so does Node's
  `X509Certificate`; RFC 9773 wants the octets as encoded). `renewalInfo`: a GET of the directory; null when it has no
  `renewalInfo` or `certId` is null; else a GET of `<renewalInfo with no trailing slash>/<certId>` (Pebble's ends in
  `/`, Let's Encrypt's does not). A 200 whose `suggestedWindow` has two dates with `start < end` gives the window, and
  `retryAfterS` from Retry-After (seconds or an HTTP date) or 21600 without one; any other answer gives `refused`, with
  the problem's `type` when there is one; no answer gives `unreachable`. Node's `fetch`, with
  `AbortSignal.timeout(15000)` and `redirect: 'error'`; no signing, no account.
- `test/real/run.sh` (POSIX sh, `set -eu`): fails with `test:real needs Docker` when `docker info` fails; runs
  `ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199` as
  `hornhoof-pebble-$$` with `-e PEBBLE_VA_NOSLEEP=1`, `-p 14000:14000 -p 15000:15000`, `--add-host
  acme.test:host-gateway`, command `-config test/config/pebble-config.json -strict`; removes the container and its
  temp folder on exit (`trap`); waits up to 30 s for `curl -ksf https://localhost:14000/dir`; `docker cp
  <container>:/test/certs/pebble.minica.pem <temp>/ca.pem`; then runs `npx vitest run -c vitest.real.config.ts` with
  `NODE_EXTRA_CA_CERTS=<temp>/ca.pem`, `PEBBLE_DIRECTORY=https://localhost:14000/dir`,
  `PEBBLE_MANAGEMENT=https://localhost:15000`, and exits with its status. Pebble keeps its default 5% of refused
  nonces, which acme-client's own badNonce retry meets in most runs (`acme-fake.test.ts` pins it); its default config
  validates HTTP-01 on port 5002, picks a random profile when none is asked, and reuses an account's valid
  authorization half the time (`PEBBLE_AUTHZREUSE`, `wfe.go:1562-1565`).
- `vitest.real.config.ts`: `include: ['test/real/**/*.test.ts']`, the same `globalSetup` as `vitest.config.ts`,
  `testTimeout: 120000`, `fileParallelism: false` (port 5002 is shared). The tests throw `run with npm run test:real`
  when `PEBBLE_DIRECTORY` is unset.
- CI job `test-real` in `images.yml`, beside `test`: `runs-on: ubuntu-latest`, the same pinned `actions/checkout` and
  `actions/setup-node` (node 22, npm cache), `npm ci`, `npm run test:real`.

- [ ] **Step 1: Write failing tests.**
  `challenges.test.ts`: `answers a token it holds as text, and nothing else` (`/.well-known/acme-challenge/abc_-1`
  gives 200 `text/plain` with the key authorization after `answer`, 404 after `forget`, 404 for an unknown token and
  for `a.b`; it needs no session and works over the link with `viaLink()`).
  `ari.test.ts`:
  - `builds the certificate id as RFC 9773 shows it`: `certIdFrom('69885b6b87464041e1b37b847ba0ae2cde01c8d4',
    '0087654321')` is `aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE`.
  - `keeps the serial's leading zero`: `certId` of `await selfSigned('acme.hornhoof.org', { serial: '0089abcdef' })`
    ends in `.AImrze8`, its first part decodes to the 20 bytes of the certificate's authority key identifier, and it
    holds no `=`.
  - `asks the renewal information of the certificate`, against a directory served by a local `http.createServer` in
    the test with `renewalInfo: 'http://127.0.0.1:<port>/renewal-info/'`: the GET's path is `/renewal-info/<certId>`
    with one slash; a window answer with `Retry-After: 3600` gives that window and `retryAfterS: 3600`, and without
    Retry-After `21600`; a 404 with an `application/problem+json` body of type `urn:ietf:params:acme:error:malformed`
    gives `refused` with that type; a window whose `start` is after its `end` gives `refused`.
  - `has none to give without ARI`: a directory with no `renewalInfo` gives `null` and fetches nothing else.
  - `says unreachable when nothing answers`: a directory URL on a closed port gives `unreachable`.
  `acme-fake.test.ts`, against a fake ACME server on a local `http.createServer` (a directory with `newNonce`,
  `newAccount` and `newOrder`; `newNonce` answers HEAD with a `replay-nonce`, and so does every answer; the fake checks
  no signature):
  - `tells a rate limit and its Retry-After, without waiting it out`: `newAccount` answers 429,
    `application/problem+json` `{ "type": "urn:ietf:params:acme:error:rateLimited", "detail": "too many" }`,
    `Retry-After: 7200`: `account()` rejects within 2 s with an `AcmeError` `refused`, that type and `retryAfterS:
    7200`, and the fake saw one `newAccount`.
  - `says unreachable for a server error, at once`: a 500 with no body gives `unreachable` within 2 s, after one
    `newAccount`.
  - `says unreachable when nothing answers`: a closed port gives `unreachable`.
  - `never puts a key in an error`: no message of the errors above contains `PRIVATE KEY` or the body of the account
    key's PEM.
  - `sends again after a refused nonce`: the first `newAccount` answers 400 `application/problem+json` with type
    `urn:ietf:params:acme:error:badNonce`, the second 201 with a `Location`: `account()` gives that URL, after two
    `newAccount`.
  - `downloads the certificate of an order that was ready from the start`: `newOrder` answers 201 with a `Location`,
    `status: 'ready'`, no authorizations and a `finalize` URL; `finalize` answers `status: 'processing'`; the order's
    URL then answers `status: 'valid'` with a `certificate` URL, which answers the chain of `await
    selfSigned('acme.test')`: `issue('acme.test', hooks, { selfCheck: false })`, on an `AcmeAccount` with `backoff: {
    attempts: 3, min: 50, max: 50 }`, gives that chain and a `keyPem`, and the hooks were never called.
  `test/real/acme.test.ts`, against Pebble, with a `testApp()` listening on `0.0.0.0:5002` and hooks that answer
  through `app.ctx.challenges` and record each token:
  - `makes an account and finds the same one again by its key`: a second `AcmeAccount` with the same key and no URL
    gives the same URL.
  - `orders a certificate over HTTP-01, answered by the app's own route`: `issue('acme.test', hooks, { selfCheck: false
    })` gives a chain whose `certInfo` names are `['acme.test']` and whose `certId` is set, and whose first certificate
    `checkPrivateKey`s the `keyPem`; every recorded token is forgotten after.
  - `asks when to renew, and renews once with replaces`: `renewalInfo(PEBBLE_DIRECTORY, a)` has `start < end`, both
    between `a`'s `notBefore` and `notAfter`; after a POST to `${PEBBLE_MANAGEMENT}/set-renewal-info/` with `{
    Certificate: a, ARIResponse: JSON.stringify({ suggestedWindow: { start: <an hour ago>, end: <a minute ago> } })
    }`, its `end` is in the past; `issue(..., { replaces: certId(a), selfCheck: false })` gives `b` with another
    serial; the same `replaces` again throws `refused` with type `urn:ietf:params:acme:error:alreadyReplaced`.
  - `says invalid when the app does not answer the challenge`: on a new account (so no valid authorization of an
    earlier test is reused), hooks whose `answer` does nothing, `selfCheck: false`: `invalid`, with a `type`.
  - `does not ask the CA to validate while its own check fails`: an `AcmeAccount` on a new account key, with `backoff: {
    attempts: 2, min: 100, max: 100 }`, and hooks whose `answer` does nothing, `selfCheck` left on: `not_ready` (nothing
    answers `http://acme.test/` from the test's side); with `vi.spyOn(app.ctx.challenges, 'get')`, no request reached
    the app's challenge route within one second after it.
  The app listens with `app.listen({ port: 5002, host: '0.0.0.0' })`, the port Pebble's default config validates on.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/challenges.test.ts test/ari.test.ts
  test/acme-fake.test.ts`, then `npm run test:real` from the root. Expected: FAIL (no module). If Pebble cannot
  resolve `acme.test` through `--add-host`, stop and report: the fallback is pebble-challtestsrv as Pebble's
  `-dnsserver`, a decision for the team lead. If acme-client turns out unable to do a step above, stop and report
  which call; do not write that step by hand.
- [ ] **Step 3: Implement** the interfaces, `run.sh`, the configs, the scripts and the CI job.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Get certificates through acme-client with renewal information on top, tested against Pebble
  in CI".

