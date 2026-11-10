# Build rulings (they override the plan)

1. One branch for everything. A plan's "Repo" line that names its own worktree or branch (relay-contract, backups, ...)
   means the Hornhoof clone `/home/altera/hornhoof-network/hornhoof` on its local branch `network`. "Starts from: main
   with plan N merged and shipped" and "Handed over" mean "plan N's tasks are complete on this branch". The relay repo
   is `/home/altera/hornhoof-network/hornhoof-edge`, local only: no remote, no push. Mac paths in a plan
   (`/Users/0x/Projects/...`) mean those two folders; `notes/specs/` means `/home/altera/hornhoof-network/specs/`,
   `notes/plans/` means `/home/altera/hornhoof-network/plans/`; `notes/ops/` is not on this machine.
2. Never deploy, ship or rehearse. Skip every step a plan marks as the team lead's or Ivan's: deploying the relay to the
   droplet, hornhoof.org, or any ssh; a rehearsal on a stand; `install.sh` against a real company; an Update; a
   `request.json` on a company; a merge into main; a push; anything on GitHub.
3. Code that a plan says depends on plan 1 being deployed is written and tested against the local relay the tests and
   the lab start. Never against the real one.
4. `~/.hornhoof-edge/` is not on this machine and is not created: no private-words file, no keys, no ssh config. Any
   plan step that writes or reads there is the lead's to rule on; report it, do not do it.
5. Migration numbers: the number is what `drizzle-kit generate` gives: the plan's number plus 11 (`0053_session_handover` to
   `0071_go_on_here`), and a plan's text and tests read so. Main's newest is `0052_dismissed_command_blocks`. One migration lane at a
   time, in the order 1b T1, 1b T3, 1b T7, 3 T2, 4 T1: a lane that was overtaken deletes its own migration, snapshot and journal
   entry and generates again after `lane.sh refresh`.
6. Docker is not used in this build. Do not run, build, pull, exec or inspect anything in Docker, on this machine it
   runs a live company. A plan's step or test that needs Docker is reported to the lead; write the test so that it is
   skipped when Docker is not there only if the plan's own command (`npm run test:real`) already keeps it apart, and go
   on with the rest.

# The machine's rules (from CLAUDE.md, they bind you)

- Files, code, commits, ledger lines, briefs: English. Comments are plain sentences that say why. Never use em dashes,
  in code, docs, commits or messages. In Russian UI strings write "е", never "ё".
- TDD for everything: the failing test first, watch it fail for the right reason, then the code, then watch it pass. A
  bug is fixed only after a test reproduces it.
- Uncle Bob's clean code: small functions, names that say what things are, no duplicated logic.
- Hornhoof's own rules: `hornhoof/AGENTS.md` and `hornhoof/templates/skills/dev-engineering-rules.md`.
- You commit only on your own lane's task branch, through `network-build/lane.sh commit`; the lead lands batches. Never push. No new remote, no branch on GitHub.
  Never rewrite history. Never commit or create `notes/`, `.superpowers/`, `.claude/`, `node_modules/`, `archive/`,
  `companies/`, `deploy.env`, `.metrics/`.
- Never print a secret value: keys, tokens, passwords, generated visitor keys. A generated key lives only in its one
  response; tests compare it with booleans and fixed messages.
- Never put Ivan's email or any personal data into a request to an outside service. Never read or copy credentials: not
  `~/.claude` credentials, not `~/.gemini`, not `~/.ssh`, not any Docker volume.
- Nothing on the relay droplet: no ssh to it, no deploy. GitHub: reading is fine, public release downloads with their
  checksum checked are fine, nothing is sent to GitHub. Tests never reach hornhoof.org or a real company.
- This machine is a-host. It runs Ivan's company Hornhoof in Docker (containers named `hornhoof-*`) and belongs to his
  family. Never touch Docker that is not yours. No sudo. Work only inside `~/hornhoof-network`; other folders in the home
  belong to the machine's owner, do not read or change them. Temporary files go in
  `/home/altera/hornhoof-network/network-build/tmp` or the temporary folders tests make for themselves.
- Keep the load moderate, the company runs here: vitest with `--maxWorkers=2`, at most two heavy runs at once across the
  whole team. About 7 GB of memory is free. Every test or gate run goes through one of two wrappers, which also keep real
  Docker out of reach: `/home/altera/hornhoof-network/network-build/light.sh <command>` for a focused run of a few tests,
  and `/home/altera/hornhoof-network/network-build/heavy.sh <command>` for a full suite or coverage run (it waits for a
  free slot, so it may wait some minutes).
- Skills, in `/home/altera/hornhoof-network/plugins/superpowers/skills/<name>/SKILL.md`; read and follow them:
  `test-driven-development`, `systematic-debugging` for any failure, `verification-before-completion` before you claim
  anything is done.
- An irreversible, destructive or security-sensitive step, or a side effect outside this folder: do not do it, report it.


# You are the reviewer (read-only)

Another agent wrote the task below. You review it; you do not fix it. Two reviewers work at once, independently.

- Do NOT edit, create, move or delete any file in either repository. Do not commit, stage, push, run prettier or any
  formatter. Temporary files only under `/home/altera/hornhoof-network/network-build/tmp/<your own new folder>`.
- Read the change (the review package named below), compare it line by line with the brief: the plan's top part, its
  Review Focus, its Global Constraints, the build rulings and the build lead's rulings, and the task's Files, Interfaces
  and Steps. Spec: `/home/altera/hornhoof-network/specs/2026-11-02-single-network-design.md`. Ledger of earlier rulings,
  all of which stand: `/home/altera/hornhoof-network/network-build/progress.md`.
- Use `git diff`, `git show --format=%s`, or the package; do not print full `git log` output, it carries an author's
  email address, and nothing of the kind goes in your report.
- Tests (Ivan's word): do not ask for a test only to cover a line, pin a condition or raise a number. Report a missing or weak test as Important only when a named harm to a person could reach production unseen, and say which. Do not ask for old tests to be rewritten. A test that passes with the code wrong, on what the task promises, is still a finding.
- Judge every finding by what a person using Hornhoof would get. Critical: a person loses data or access, a company is
  exposed or cut off, or the task's promise is false. Important: a real gap against the brief, or a test that would
  pass with the code wrong. Minor: anything else.
- Look hardest at: behavior that differs from the Interfaces; tests that would pass even if the code were wrong (weak
  asserts, sleeps instead of waits, skipped checks); any secret value that could reach a log, a test message or a
  report; anything private or any em dash in a tracked file; fail-open reads; processes or ports left behind; Python
  syntax newer than 3.12 in relay files; facts in docs that are not true at this commit.
- Check the build's rules as findings too: was each new test seen failing first, is any changed function over CRAP 10, any
  duplicate pair at 0.8; small functions, names that say what things are, comments that say why. Mutator is not part of a task's or a plan's review; it runs once, at the end of phase 1.
- Reproduce before you claim: for a Critical or Important say how you checked it (the command or the reasoning from
  named lines). Run a focused test only when it settles a doubt; the lead already ran the full suite and gives you its
  result. At most `nice -n 10`, one run at a time. You do not dispatch subagents.
- Report, as your final message, a list of findings, each: severity, `file:line`, what is wrong, what a person would
  get, what would make it right. Say so if you find nothing at a severity. Keep it short and concrete. Never print a
  key or token value.

# This review: conveyor v4, one review per batch

- You read batch 4, slice limits, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-4, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch4-limits.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Your slice: sign-in limits and the TLS listener (1b T3, T5). Security class, two readers at once

The plan's test of 30 wrong sign-ins across emails is an `it.todo` in link-listener.test.ts, since T5's writer did not have T3: both are here now. Look at their seam: a visitor's address from the PROXY header reaching the sign-in limit, and what a forged address over the link can do to it. A PROXY v2 parser is network input: anything it must refuse. Writers' rulings are in `network-build/progress.md`.

# The tasks

## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 3

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests make their keys and certificates at run time, and
  `test:real` copies Pebble's test CA out of its container at run time; none is committed.
- Two new runtime dependencies of `@hornhoof/server`, at exact versions: `acme-client` 5.4.0 for the ACME core (JWS,
  account key use, nonces, the order and challenge flow, finalize, the CSR) and `@peculiar/x509` 1.14.3, already in
  acme-client's tree, for the stand-in and for reading certificates. No other new dependency, and no hand-written
  JWS, nonce or order code. ARI is this plan's own code (`ari.ts`), since acme-client has none.
- Migrations only by `npx drizzle-kit generate --name <name>` from `apps/server`; never edit an existing migration.
  Task 1 adds one, Task 3 the next and Task 7 the last, in that order, so those tasks never run side by side.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from the worktree root:
  `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; types: `npx tsc -p apps/server/tsconfig.json
  --noEmit` and, for web tasks, `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. From Task 6 on,
  `npm run test:real` from the worktree root needs Docker and runs Pebble. Never run prettier.
- A private key (the account's or a certificate's) is stored only as `encryptSecret(pem, config.secret)`, and never
  goes into a log line, an API answer, an error message or `tunnel.json`. The tunnel container never holds a
  certificate key.
- Fail toward a working link: anything unknown about the relay keeps the tunnel's current mode; anything unknown or
  missing about the certificate means `http`.
- A one-machine install answers on localhost as today: port 8080, the full `/api/health`, the `hh_session` cookie.
  The updater's health check (`http://app:8080/api/health`) and the node container (`http://app:8080`) see no change.
- Let's Encrypt's limits (overview): after a failed validation the machine waits at least an hour before it orders
  for that name again; the app checks its own challenge answer through the link before it asks the CA to validate;
  renewals carry ARI's `replaces`.


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


## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 5

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests make their keys and certificates at run time, and
  `test:real` copies Pebble's test CA out of its container at run time; none is committed.
- Two new runtime dependencies of `@hornhoof/server`, at exact versions: `acme-client` 5.4.0 for the ACME core (JWS,
  account key use, nonces, the order and challenge flow, finalize, the CSR) and `@peculiar/x509` 1.14.3, already in
  acme-client's tree, for the stand-in and for reading certificates. No other new dependency, and no hand-written
  JWS, nonce or order code. ARI is this plan's own code (`ari.ts`), since acme-client has none.
- Migrations only by `npx drizzle-kit generate --name <name>` from `apps/server`; never edit an existing migration.
  Task 1 adds one, Task 3 the next and Task 7 the last, in that order, so those tasks never run side by side.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from the worktree root:
  `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; types: `npx tsc -p apps/server/tsconfig.json
  --noEmit` and, for web tasks, `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. From Task 6 on,
  `npm run test:real` from the worktree root needs Docker and runs Pebble. Never run prettier.
- A private key (the account's or a certificate's) is stored only as `encryptSecret(pem, config.secret)`, and never
  goes into a log line, an API answer, an error message or `tunnel.json`. The tunnel container never holds a
  certificate key.
- Fail toward a working link: anything unknown about the relay keeps the tunnel's current mode; anything unknown or
  missing about the certificate means `http`.
- A one-machine install answers on localhost as today: port 8080, the full `/api/health`, the `hh_session` cookie.
  The updater's health check (`http://app:8080/api/health`) and the node container (`http://app:8080`) see no change.
- Let's Encrypt's limits (overview): after a failed validation the machine waits at least an hour before it orders
  for that name again; the app checks its own challenge answer through the link before it asks the CA to validate;
  renewals carry ARI's `replaces`.


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


