# Network Phase 1, Plan 1b: The Company's Own Certificate, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The https of a company's hornhoof.org link ends at the company's own machine. The app gets and renews a
Let's Encrypt certificate for its link name through the tunnel, serves it on a TLS port that the link's frpc reaches
with the visitor's address in a PROXY v2 header, and moves the tunnel to `https` once the relay passes TLS through.
Every link name now shows in public certificate logs, so nothing before sign-in tells who the company is, search
engines are told to stay away, sign-in limits count per address and outlive a restart, and the session cookie on the
link is `__Host-` prefixed.

**Architecture:** A new module `apps/server/src/modules/tls/` holds: the stand-in certificate and the reading of a
certificate (`x509.ts`, on `@peculiar/x509`); a thin wrapper that drives `acme-client` for the ACME core, the
account, the order, HTTP-01 and finalize (`acme.ts`); renewal information as a small module of its own on top
(`ari.ts`: the certificate id from the authority key identifier and the serial, and one unauthenticated GET); the
HTTP-01 answers (`challenges.ts`); the TLS listener on port 8443 inside the container (`proxy-header.ts`,
`listener.ts`); the database row (`store.ts`); the check it makes through the link after a switch (`checks.ts`); and
`LinkTls` (`manager.ts`), which decides when to order, renew and back off and which mode the tunnel runs in. The
listener hands each decrypted connection to Fastify's own http server, so every route, hook and WebSocket works on
it unchanged. The tunnel container keeps reading `tunnel.json`; only the frpc config it writes for `https` mode is
new. Port 8080 keeps answering localhost, the updater, the node container and every link still in `http` mode, as
today.

**Tech Stack:** TypeScript on Node 22 (`node:tls`, `node:net`, `node:https`, fetch), `acme-client` 5.4.0,
`@peculiar/x509` 1.14.3, Fastify 5, drizzle with PGlite tests, vitest, React for the web; Pebble 2.10.1 (Let's
Encrypt's test CA) in Docker for `npm run test:real`; frpc 0.71.1 with an `https` proxy.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.10 (TLS on the link ends at the company's machine; the
certificate and its key live in the database, the key under `HORNHOOF_SECRET` as the link key is). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`: plan 1b, "Our own TLS on the public link" (HTTP-01 through the
tunnel, Let's Encrypt's limits, "A known consequence: names become public" and its mitigations), decision 2
(`test:real`), discrepancy 23 (`SECURITY.md:53`). Plan 1
`notes/plans/2026-11-03-network-phase-1-plan-1-relay-contract.md` (see "Handed over by plan 1"). RFC 8555 (ACME), RFC
9773 (ARI), RFC 5280 (certificates), the PROXY protocol v2 (haproxy `proxy-protocol.txt`, section 2.2). `acme-client`
5.4.0's source (`github.com/publishlab/node-acme-client`, tag `v5.4.0`), which the paths under "Open points" refer to.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/company-certificate` on a new branch `company-certificate`
from main (`git worktree add`, then `npm ci` there once), after plan 1 is merged into main.

**Handed over by plan 1** (written, and merged before this plan starts):
- `Relay.health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null; passthrough: boolean }>` in
  `apps/server/src/modules/link/relay.ts`, which never throws (plan 1 Task 12).
- `FakeRelay` in `apps/server/test/fake-relay.ts` with `passthrough: boolean`, `frpsDown: boolean` and the old `down`
  (plan 1 Task 11).
- On the relay: port 80 redirects `http://<name>.hornhoof.org/<path>` to https with the path kept (plan 1 Task 8 pins
  `/.well-known/acme-challenge/t`); frps on 443 passes a name's TLS connections unread to its `https` proxy (R7.1),
  whose frpc sends the visitor's address in a PROXY v2 header (R7.3); health says `passthrough: true` (R4.1); a
  session with no client id (`legacy`, today's tunnels) may register the `http` or the `https` proxy named after the
  binding, with `subdomain` equal to the name (plan 1 Task 9). This plan keeps the link's frpc on today's login with
  no client id; plan 2 gives it one.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
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

## Rulings made while planning

- **acme-client does the ACME core; ARI sits on top** (the team lead's ruling). `acme.ts` calls acme-client's own
  steps, not its `auto()`, because `auto()` has no way to pass `replaces`: `createAccount`, `createOrder`,
  `getAuthorizations`, `getChallengeKeyAuthorization`, `verifyChallenge`, `completeChallenge`,
  `waitForValidStatus`, `finalizeOrder`, `getCertificate`, and `crypto.createPrivateEcdsaKey` and
  `crypto.createCsr` for the keys and the CSR. `ari.ts` builds RFC 9773's certificate id from the certificate's
  authority key identifier and serial (read with `@peculiar/x509`; Node's `X509Certificate` gives no authority key
  identifier), reads `renewalInfo` from the directory with a plain GET, and asks it with one unauthenticated GET. A CA
  without `renewalInfo` gets renewal at two thirds of the lifetime. TLS-ALPN-01, the overview's fallback, is not built:
  acme-client's `crypto.createAlpnCertificate` makes it a small change once the redirect path ever fails.
- **The app checks its own answer first**, with acme-client's `verifyChallenge`: it asks
  `http://<host>/.well-known/acme-challenge/<token>` on port 80 and follows the redirect to https without checking the
  certificate, the same path Let's Encrypt takes (`src/verify.js`). Only then is the challenge completed. A failed
  self-check costs nothing at Let's Encrypt and is tried again in 5 minutes; a failed order waits an hour, or longer
  when the CA's Retry-After says so. A new company's tunnel needs a few seconds to come up, and without the self-check
  its first order would burn a failed validation and an hour.
- **The tunnel's mode** is kept in the database (`link_tls.mode`), so a restart writes the same `tunnel.json` and the
  link does not blink. It is `https` only while all hold: the row's certificate is for the link's current name, it has
  more than 24 hours left, and the relay's latest health answer said `up` and `passthrough`. A health answer with `up`
  and not `passthrough` means `http`; no answer, or `up: false`, keeps the mode. Before a switch to `https` the manager
  asks health once more. After it, the manager probes `<link url>/api/health` over https with the certificate checked,
  every 3 s for up to 60 s; unless the answer is 200 from its own certificate, it goes back to `http` and tries `https`
  again no sooner than an hour later. The listener holds the certificate before the tunnel is switched; each probe try
  opens a new connection, and the probe gives up after 60 s in all; an app that starts in `https` probes once more; the
  hour's block is kept in the database, so a restart does not lift it. The overview names only the switch back on
  `passthrough`; the probe covers a relay that says `passthrough` but does not carry the name, which would otherwise
  take the link down.
- **The listener** listens on port 8443 inside the app container, which compose does not publish; the tunnel
  container reaches it as `app:8443` on the default network. Every connection must open with a PROXY v2 header within
  5 s, or it is closed. The header's source address is believed only when the connection comes from the tunnel
  container (the same rule as X-Forwarded-For today); otherwise the visitor is the socket's own address. Every request
  on 8443 counts as over the link. ALPN offers `http/1.1` only. The stand-in is a self-signed certificate for the
  link's host name (or `hornhoof.invalid` while there is none), made in memory and never stored.
- **"Over the link"** means the request came over https through the tunnel container (today's `cameOverHttps`) or
  through the listener. It is worked out once per request into `req.overLink`.
- **Over the link the session is `__Host-hh_session`; an older `hh_session` is moved to it once** (the team lead's
  ruling: nobody signs in again). A `hh_session` cookie there could have been set by a page on another company's
  name, since every name shares the site hornhoof.org, so over the link it is read only for that move, and only for a
  session made before the Update: the migration marks the sessions it finds (`before_host_cookie`), and every newer
  session is made unmarked. The move gives the person a new session with a new id under `__Host-hh_session`, clears
  `hh_session`, and lets the old session live one more minute for requests already on their way. Localhost keeps
  `hh_session` as today.
- **Sign-in counts in the database.** Each try is written before the password is checked, in one statement that
  writes it only while the address and the email are under their limits, so a burst counts; it is deleted when the
  sign-in works. So failures count and successes do not, which is what `SECURITY.md` already promises ("Failed
  sign-ins are capped"); today's in-memory limiter counts every try. Limits: 10 per email and address in 15 minutes,
  50 per email in an hour (both as today), and 30 per address in an hour across all emails (new). An IPv6 address
  counts by its /64. The table keeps SHA-256 hashes of the email and the address, never the text, and loses rows older
  than an hour at every try. The invite limit stays in memory: invite tokens cannot be guessed.
- **One Let's Encrypt account per company, with no contact email.** Its first order accepts Let's Encrypt's
  Subscriber Agreement for the company (`termsOfServiceAgreed: true`). The team lead ruled to show it: one line, with a
  link to the agreement, in setup next to the new link and in Settings beside where the link's encryption ends;
  `SECURITY.md` says it; and the Update that ships this plan says it in its title, since every existing company
  accepts on its first order after that Update.
- **Renewal.** The renewal time is a uniform random moment inside ARI's suggested window, drawn again only when the
  window moves away from it, and now when the window has passed. ARI is asked again after its Retry-After, held
  between 1 hour and 24 hours. Without ARI in the directory, renewal comes at two thirds of the lifetime. Every
  certificate gets a new key. No ACME profile is asked for.
- **`ACME_DIRECTORY`** picks the CA: unset or empty is Let's Encrypt's production directory, `off` turns certificates
  off and puts the tunnel on `http` whatever the stored mode says, anything else must be an https directory URL.
  Compose passes it to the app, so an operator can turn it off in `.env` and restart the app, which is the way back if
  the switch ever takes a link down; `SECURITY.md` and the README's Questions say so. Tests run with `off` unless
  they set it. Only `main.ts` starts the manager's timers.
- **The expiry warning lives in the Machines tab**, as the overview says, for people who see the whole company (the
  only ones `/api/link` answers); Settings shows where the link's encryption ends.
- **Setup waits for the certificate up to 90 s** before it shows the new link, then shows it anyway with a line that
  the connection is encrypted to hornhoof.org for now.
- **Challenge answers live in memory**, served on every port and transport. One app holds one company's link until
  plan 2.
- **Names are public from the first certificate** (overview, accepted by Ivan on 2026-11-02). The setup hint that a
  random name is "hard to guess" and the guide's lines that rest on it change: a random name no longer hides that a
  link exists, but it does not say whose company it is.
- **A random link name is the default**, as the overview's mitigation says ("Random names stay the default"). Today
  setup makes the link's name from the company's name as it is typed, and Share access suggests it too
  (`Setup.tsx:66-69`, `Settings.tsx:23`), so the first certificate would publish the company's name. Both start with a
  long random name instead; the person may still type any name.

## Open points: what acme-client does not do

Checked against acme-client 5.4.0's source. None needs a hand-written ACME client; each is for the team lead to
confirm or overrule.

1. **No problem type and no Retry-After in its errors.** A refused request becomes `new Error(<the problem's detail
   text>)` (`src/api.js:53`, `src/util.js:195-208`), so a rate limit cannot be told from a bad request, nor its
   Retry-After read. The plan reads both with one response handler on `acme.axios`, the axios instance acme-client
   exports for its settings (`src/index.js`, `src/axios.js`): it keeps the last ACME problem document it saw (its
   `type` and the `retry-after` header) in `acme.ts`, which turns each failed step into an `AcmeError`. Only one ACME
   flow runs at a time in the app (Task 8 runs one pass at a time), so the last problem is the failed step's. Without
   this, every failure waits one hour, as the overview's floor, and a rate limit is retried hourly.
2. **Its own 429 and 5xx retry sleeps the whole Retry-After inside the call** (`src/axios.js`, `retryMaxAttempts: 5`).
   A rate limit's Retry-After can be days, and the manager's one pass would hang that long. `acme.ts` sets
   `acme.axios.defaults.acmeSettings.retryMaxAttempts = 0` and `acme.axios.defaults.timeout = 15000` once, for the
   process, and leaves the waiting to the manager's backoff. badNonce answers are still retried by acme-client itself,
   up to 5 times (`src/http.js:27`, `:302`).
3. **No ARI.** acme-client 5.4.0 has no `renewalInfo` call. Its `createOrder(data)` sends `data` as it is
   (`src/api.js:147-148`), so `replaces` goes through untouched; `ari.ts` covers the rest.
4. **No release since 2024-07** (5.4.0), and it brings axios, node-forge, asn1js and debug. Task 10 runs `npm audit
   --omit=dev` and the team lead decides on anything it reports.

## Review Focus

1. A switch to `https` that the relay does not carry (the registration refused, or `passthrough` said while the name
   is not routed): the link is back in `http` mode within about two minutes and does not flap. Test in Task 8
   (`goes back to http when the switch does not serve the certificate`).
2. Renewal failing for days (Let's Encrypt down, the tunnel down): one try an hour at most, the old certificate served
   until a day before it ends, then `http`; the Machines tab warns from 14 days before. Tests in Tasks 8 and 9.
3. A rename or a removal while a certificate exists: the new name never runs `https` on the old name's certificate,
   and the old certificate leaves the listener. Tests in Task 8.
4. An app restart (every Update) in `https` mode: `tunnel.json` is written `https` from the database at once, before
   any health answer, so the link does not drop to `http` and back. Test in Task 8 (`keeps https across a restart`).
5. A burst of wrong sign-ins from one address (100 at once, each with another email): exactly 30 of them reach the
   password check, and the rest get 429. Test in Task 3.

---

### Task 1: The `__Host-` session cookie over the link

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** main with plan 1 merged. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/auth.test.ts test/people.test.ts
test/origin.test.ts test/migrations.test.ts` passes, and `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: the migration from `npx drizzle-kit generate --name session_handover`
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/auth/tunnel.ts`, `apps/server/src/auth/session.ts`,
  `apps/server/src/app.ts`, `apps/server/test/helpers.ts`
- Test: `apps/server/test/auth.test.ts`, `apps/server/test/migrations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // auth/tunnel.ts
  export async function overLink(req: FastifyRequest, config: Config): Promise<boolean>;  // cameOverHttps(req, config) for now; Task 5 adds the listener's sockets
  // app.ts: declare module 'fastify' { interface FastifyRequest { overLink: boolean } }, set by the first onRequest hook
  // auth/session.ts
  export const SESSION_COOKIE = 'hh_session';
  export const LINK_SESSION_COOKIE = '__Host-hh_session';
  export const sessionCookieOf = (req: FastifyRequest): string => (req.overLink ? LINK_SESSION_COOKIE : SESSION_COOKIE);
  export async function handOverSession(req: FastifyRequest, reply: FastifyReply, db: Db, config: Config): Promise<void>;
  // db/schema.ts: sessions gains
  //   beforeHostCookie: boolean('before_host_cookie').notNull().default(true)  (true only on rows made before this migration)
  // test/helpers.ts
  export const TUNNEL = '192.0.2.10';   // the tunnel container's address in tests: testApp({ TUNNEL_HOST: TUNNEL })
  export const viaLink = (token?: string) => ({ remoteAddress: TUNNEL, headers: { 'x-forwarded-proto': 'https' }, cookies: token ? { [LINK_SESSION_COOKIE]: token } : {} });
  // sessionFrom(res) takes the cookie of either name
  ```
- `startSession` sets `sessionCookieOf(reply.request)`: over the link with `secure: true`, `path: '/'`, no domain;
  elsewhere as today. It writes `beforeHostCookie: false` on every row it makes. `requirePerson` and `endSession` read
  and clear only `sessionCookieOf(req)`; over the link the clearing carries `secure: true`, `path: '/'` and no domain,
  since a browser takes a `__Host-` cookie, an expired one too, only with those.
- `handOverSession` runs in an `onRequest` hook right after the `overLink` one, for a request over the link that carries
  `hh_session`, no `__Host-hh_session` and no `Upgrade` header. In one transaction it locks (`FOR UPDATE`) the session
  row of that token with `before_host_cookie` true and `expires_at` in the future whose person is `active`. With one, it
  sets that row's `expires_at` to `least(expires_at, now() + interval '60 seconds')`, so requests the browser sent
  before it had the new cookie still get through, and inserts a new session for the person with a new token,
  `before_host_cookie: false` and the usual 30 days; the reply sets `__Host-hh_session` as `startSession` does over the
  link and clears `hh_session` (path `/`), and the request goes on with `req.cookies['__Host-hh_session']` set to the
  new token, so it is answered signed in. With none, the reply clears `hh_session` and the request goes on signed out.
  Clearing `hh_session` here carries `secure: true` and `path: '/'`. Nothing else reads `hh_session` over the link.

- [ ] **Step 1: Write failing tests** in `auth.test.ts`:
  - `names the session cookie __Host-hh_session over the link, https only, path / and no domain`: with
    `testApp({ TUNNEL_HOST: TUNNEL })`, a sign-in with `viaLink()` sets exactly one cookie, `__Host-hh_session`, with
    `secure: true`, `path: '/'`, `httpOnly: true`, `sameSite: 'Lax'` and no `domain`.
  - `reads only __Host-hh_session over the link and only hh_session elsewhere`: with a token from a sign-in,
    `GET /api/me` is 200 with `viaLink(token)`, 401 over the link with `cookies: { hh_session: token }`, 200 from
    `127.0.0.1` with `as(token)` and 401 from `127.0.0.1` with `{ cookies: { '__Host-hh_session': token } }`.
  - `signs out over the link`: `POST /api/auth/logout` with `viaLink(token)` clears `__Host-hh_session` (a
    `set-cookie` with that name, `Secure`, `Path=/`, no `Domain` and an expiry in the past), and the next `GET
    /api/me` with `viaLink(token)` is 401.
  - `sets the link's cookie when an invite is accepted over the link`: the accept answer over the link sets
    `__Host-hh_session`.
  - `moves a session from before the switch to __Host-hh_session, once`: a sign-in from `127.0.0.1`, then that
    session's `before_host_cookie` set to true in the database (as the migration leaves older rows); `GET /api/me`
    from `TUNNEL` with `x-forwarded-proto: https` and `cookies: { hh_session: token }` is 200, sets
    `__Host-hh_session` to another token (secure, path `/`, no domain) and clears `hh_session`; the new token with
    `viaLink(newToken)` is 200; the old row's `expires_at` is at most 60 s away and the new row's `before_host_cookie`
    is false; once the old row's `expires_at` is set to the past, the old token over the link is 401.
  - `lets a burst with the old cookie through`: three such requests at once are all 200.
  - `moves no session made after the switch, expired or of a disabled person`: a fresh sign-in's token as
    `hh_session` over the link is 401 and sets no `__Host-hh_session`; so is a marked row whose `expires_at` is past,
    and a marked row whose person's `status` is set to `disabled`.
  - `leaves hh_session alone on localhost`: a marked session with `as(token)` from `127.0.0.1` is 200 and sets no
    cookie.
  - In `migrations.test.ts`, `marks the sessions of an older install as made before the __Host- cookie`: migrated up
    to the tag before `session_handover` with `migrationsUpTo`, a company, a person and a session row; after all
    migrations the row's `before_host_cookie` is true.
  - Change the existing `send an https-only cookie to whoever came over https through the tunnel, and believe that
    only from the tunnel`: its `signIn` helper reads the cookie of either name and returns `{ name, secure }`; the two
    tunnel-and-https cases give `{ name: '__Host-hh_session', secure: true }`, every other case
    `{ name: 'hh_session', secure: false }`.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/auth.test.ts`. Expected: FAIL (the cookie is
  `hh_session` over the link).
- [ ] **Step 3: Implement** the column, then `npx drizzle-kit generate --name session_handover` from `apps/server`,
  then `overLink`, the request decoration (`app.decorateRequest('overLink', false)` and an `onRequest` hook
  registered before every other hook in `buildApp`), `sessionCookieOf`, `handOverSession` and its hook, and the
  changes to `startSession`, `endSession`, `requirePerson`, `sessionFrom` and the helpers.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Name the session cookie __Host- on the link, and move older sessions to it once".

### Task 2: Nothing before sign-in names the company

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/before-sign-in.test.ts test/health.test.ts
test/version.test.ts test/static.test.ts` passes, and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/app.ts` (`Deps.onRoute`, `/api/health`, `/api/version`, `/robots.txt`),
  `apps/server/src/web.ts` (`SECURITY_HEADERS`)
- Test: `apps/server/test/before-sign-in.test.ts` (new), `apps/server/test/static.test.ts`

**Interfaces:**
- Consumes: `req.overLink`, `viaLink`, `TUNNEL` (Task 1).
- Produces:
  ```ts
  export type Deps = { db: Db; config: Config; logger?: FastifyServerOptions['logger']; agentSql?: AgentSql | null;
    onRoute?: (route: { method: string | string[]; url: string }) => void };  // called for every route, before any is added
  ```
  `GET /api/health`: `{ ok: true }` over the link, `{ ok: true, version, commit }` elsewhere. `GET /api/version`:
  over the link only with a session (`requirePerson`), else 401 `signed_out`; elsewhere as today. `GET /robots.txt`:
  200, `content-type: text/plain; charset=utf-8`, body `User-agent: *\nDisallow: /\n`. `SECURITY_HEADERS` gains
  `'x-robots-tag': 'noindex, nofollow'`, so every answer carries it.

- [ ] **Step 1: Write failing tests** in `before-sign-in.test.ts`, on an app built with `buildApp({ db, config,
  onRoute })` from `createTestDb()` and `loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', TUNNEL_HOST:
  TUNNEL })`, with a company set up from `SETUP` plus `template: 'startup'`, one more `departments` row inserted
  straight into the database with the name `Zebra Payments` (its other columns copied from a row the template made),
  and an invited and accepted person `Maria`, `maria@acme.com`:
  - `answers nothing that names the company before sign-in, locally and over the link`: for every route and every
    method of it that `onRoute` saw, `inject` with no cookie once from `127.0.0.1` and once with `viaLink()`, with a
    JSON body `{}` for methods other than `GET` and `HEAD`. Parameters are filled by name, with real values: `:id` once
    with each id in `ids` (the `id` of the first row of every table that has an `id` column and a row, found through
    `information_schema.columns`), `:name` with `acme`, `:token` with `x`, `:number` with `1`, `*` with `x`; any other
    parameter name fails the test until it is added to this map. No answer's body or header value contains `Acme`,
    `Ivan`, `ivan@acme.com`, `Maria`, `maria@acme.com` or `Zebra Payments`, and no route outside `PUBLIC` answers 2xx.
    `PUBLIC` is a list in the test of the method, URL and origin (local, link or both) of every route that answers
    2xx without a session today, such as `/api/health`, `GET /api/setup`, `/robots.txt`, the static files and
    `/api/version` from `127.0.0.1`; the agent fills it from one run and the team lead reads it in review, and a new
    public route fails the test until it is listed. The test also checks it saw at least 30 routes, so a broken
    `onRoute` cannot pass it.
  - `gives only ok on /api/health over the link`: `viaLink()` gives exactly `{ ok: true }`; from `127.0.0.1`, `version`
    and `commit` are there.
  - `asks for a session on /api/version over the link`: `viaLink()` is 401 with reason `signed_out`; `viaLink(token)`
    of the CEO is 200 with `version`, `commit`, `migrations`; from `127.0.0.1` with no cookie it is 200 as today.
  - `asks search engines to stay away`: `/robots.txt` answers the body above as `text/plain`; it, `/api/health` and an
    unknown `/api/nope` (404) all carry `x-robots-tag: noindex, nofollow`.
  - In `static.test.ts`, the existing `tells browsers not to show Hornhoof inside another page or guess what a file is`
    also expects `x-robots-tag: noindex, nofollow` on the index page.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/before-sign-in.test.ts test/static.test.ts`.
  Expected: FAIL (`/api/health` gives the version over the link; no `x-robots-tag`).
- [ ] **Step 3: Implement** the interfaces. `onRoute` is wired with `app.addHook('onRoute', ...)` before any route.
- [ ] **Step 4: Run Done when.** Expected: PASS. If the first test finds a route that names the company, stop and
  report it: the fix is a decision for the team lead.
- [ ] **Step 5: Commit** "Tell nothing about the company before sign-in on the link, and ask search engines to stay
  away".

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

### Task 4: The two libraries, the stand-in and reading a certificate

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/x509.test.ts` passes; from the worktree root, `npm
ls acme-client @peculiar/x509 -w @hornhoof/server` shows `acme-client@5.4.0` and `@peculiar/x509@1.14.3` and no other
version of either; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/package.json` and `package-lock.json`, only through `npm install --save-exact -w
  @hornhoof/server acme-client@5.4.0 @peculiar/x509@1.14.3` from the worktree root
- Create: `apps/server/src/modules/tls/x509.ts`
- Test: `apps/server/test/x509.test.ts`

**Interfaces:**
- Produces, in `x509.ts`:
  ```ts
  export async function selfSigned(host: string, opts?: { days?: number; serial?: string; now?: Date }): Promise<{ certPem: string; keyPem: string }>;
  export type CertInfo = { names: string[]; notBefore: Date; notAfter: Date; fingerprint256: string };
  export function certInfo(pem: string): CertInfo;  // the first certificate of a chain; names: its SAN dNSNames
  ```
- `selfSigned` uses `@peculiar/x509`'s `X509CertificateGenerator.createSelfSigned` with an ECDSA P-256 key from
  Node's `webcrypto` (`x509.cryptoProvider.set(webcrypto)` once in the module): subject and issuer `CN=Hornhoof
  stand-in`, a SAN with the one `dNSName` host, a subject key identifier and an authority key identifier made from the
  key (`SubjectKeyIdentifierExtension.create`, `AuthorityKeyIdentifierExtension.create`), ECDSA with SHA-256, the
  serial `opts.serial` (hex) or else the library's random one, valid from `opts.now` (default now) for `opts.days`
  (default 30) days; `keyPem` is PKCS#8. The library keeps a serial a positive DER INTEGER, so `0089abcdef` and
  `89abcdef` both give the content octets `0089abcdef` (Task 6's certificate id test rests on this). `certInfo` reads
  the first `CERTIFICATE` block with `@peculiar/x509` for the names and Node's `X509Certificate` for the dates and
  `fingerprint256`.

- [ ] **Step 1: Write failing tests** in `x509.test.ts`:
  - `makes a stand-in certificate Node reads`: `new X509Certificate(certPem)` has `subjectAltName`
    `DNS:acme.hornhoof.org`, `checkPrivateKey(createPrivateKey(keyPem))` and `verify(x509.publicKey)` true, and
    `validTo` 30 days after `validFrom` (`days: 2` gives 2).
  - `serves as a TLS certificate`: a `tls.createServer({ cert: certPem, key: keyPem })` on port 0 completes a
    handshake with a client given `servername: 'acme.hornhoof.org'` and `rejectUnauthorized: false`, whose peer
    certificate's `subjectaltname` is `DNS:acme.hornhoof.org`.
  - `reads names, dates and the fingerprint`: `certInfo(certPem)` gives `names: ['acme.hornhoof.org']`, and
    `notBefore`, `notAfter` and `fingerprint256` equal to what `X509Certificate` says.
  - `reads the first certificate of a chain`: `certInfo(a + b)` describes `a`.
  - `makes a new key each time`: two stand-ins have different `keyPem`s and fingerprints.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/x509.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Install** the two libraries with the command above, then **implement** `x509.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add acme-client and @peculiar/x509, make stand-in certificates and read certificates".

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

### Task 7: The certificate's row and the tunnel's https mode

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Tasks 5 and 6 committed (Task 3's
migration comes first, and `LINK_TLS_PORT` is Task 5's). **Done when:** from `apps/server`, `VITEST_MAX_WORKERS=2 nice
-n 10 npx vitest run test/client.test.ts test/tunnel.test.ts test/link.test.ts test/orchestrator-control.test.ts
test/migrations.test.ts test/compose.test.ts test/config.test.ts` passes, and `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tls/store.ts`, the migration from `npx drizzle-kit generate --name link_tls`
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/agent-sql.ts` (`HIDDEN` gains `link_tls`),
  `apps/server/src/modules/link/tunnel.ts` (`Settings` gains `mode`), `apps/server/src/modules/link/client.ts`,
  `apps/server/src/modules/link/link.ts` (`writeTunnelSettings` writes `mode`), `apps/server/src/config.ts`
  (`acmeDirectory`), `compose.yaml` (the app gets `ACME_DIRECTORY: ${ACME_DIRECTORY:-}` under the comment `# Where the
  link's certificate comes from: Let's Encrypt when empty, off for none.`), `apps/server/test/helpers.ts` (`testApp`
  defaults to `ACME_DIRECTORY: 'off'`)
- Test: `apps/server/test/client.test.ts`, `apps/server/test/link.test.ts` (its `tunnel.json` equality, line 67,
  gains `mode: 'http'`), `apps/server/test/orchestrator-control.test.ts` (both lists gain `SELECT * FROM link_tls`),
  `apps/server/test/compose.test.ts`, `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `LINK_TLS_PORT` (Task 5), `LETS_ENCRYPT` (Task 6), `certInfo` (Task 4), `decryptSecret`.
- Produces:
  ```ts
  // config.ts: acmeDirectory: string | null  (ACME_DIRECTORY unset or empty: LETS_ENCRYPT; 'off': null; else an https
  //   URL, or loadConfig throws 'ACME_DIRECTORY must be off or an https:// ACME directory address.')
  // db/schema.ts
  export const linkTls = pgTable('link_tls', {
    companyId: uuid('company_id').primaryKey().references(() => companies.id),
    directory: text('directory').notNull(),          // the CA the account is at
    accountKeyEnc: text('account_key_enc').notNull(),
    accountUrl: text('account_url'),
    name: text('name'),                              // the link name the certificate is for
    certPem: text('cert_pem'),                       // the chain
    certDirectory: text('cert_directory'),           // the CA the certificate came from
    certKeyEnc: text('cert_key_enc'),
    notAfter: timestamp('not_after', { withTimezone: true }),
    renewAt: timestamp('renew_at', { withTimezone: true }),
    askAt: timestamp('ask_at', { withTimezone: true }),          // when to ask ARI again
    nextTryAt: timestamp('next_try_at', { withTimezone: true }), // no order before this, after a failure
    failure: text('failure'),                        // the last failure's AcmeError type, else its kind; null after a success
    failedAt: timestamp('failed_at', { withTimezone: true }),
    mode: text('mode', { enum: ['http', 'https'] }).notNull().default('http'),
    httpsBlockedUntil: timestamp('https_blocked_until', { withTimezone: true }),  // no switch to https before this
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });
  // modules/tls/store.ts
  export type TlsRow = typeof linkTls.$inferSelect;
  export async function tlsOf(db: Db, companyId: string): Promise<TlsRow | null>;
  export async function saveTls(db: Db, companyId: string, set: Partial<Omit<TlsRow, 'companyId'>> & Pick<TlsRow, 'directory' | 'accountKeyEnc'>): Promise<void>;  // insert or update, updatedAt = now
  export async function updateTls(db: Db, companyId: string, set: Partial<Omit<TlsRow, 'companyId'>>): Promise<void>;  // the row must exist
  export async function linkMode(db: Db, config: Config): Promise<'http' | 'https'>;
  //   https only when config.acmeDirectory is not null and the row of the link's company has mode https, name equal
  //   to the link's name, a certPem that certInfo reads with the link's host among its names and more than 24 h left,
  //   and a certKeyEnc that decrypts to that certificate's key (X509Certificate.checkPrivateKey); anything else, a
  //   throw too, gives http. So ACME_DIRECTORY=off in .env and an app restart put the link back on http
  // modules/link/tunnel.ts: Settings = z.object({ url, name, key, tunnel, mode: z.enum(['http', 'https']).default('http') })
  ```
- `configFor` in `https` mode writes, in place of today's proxy block:
  ```toml
  [[proxies]]
  name = "<name>"
  type = "https"
  subdomain = "<name>"
  localIP = "app"
  localPort = 8443
  transport.proxyProtocolVersion = "v2"
  ```
  and everything above the proxy block as today, with `localPort` from `LINK_TLS_PORT`. `http` mode is today's config,
  byte for byte.

- [ ] **Step 1: Write failing tests.**
  - `client.test.ts`: `runs an https proxy to the app's TLS port in https mode, with the visitor's address in a PROXY
    v2 header` (the proxy block above exactly, no `requestHeaders`, the lines above it equal to http mode's);
    `reads settings with no mode as http` (today's `tunnel.json` gives today's config).
  - `link.test.ts`, on `testApp({ ACME_DIRECTORY: 'https://acme.invalid/directory', ... })`: `writes the tunnel's
    mode: https only for a certificate of the link's own name`: with a link `acme`, no `link_tls` row gives `mode:
    'http'` in `tunnel.json`; a row with `mode: 'https'`, `name: 'acme'`, a `certPem` and `certKeyEnc` from `await
    selfSigned('acme.hornhoof.test')` (the fake relay's links end in `hornhoof.test`) gives `https`; the same row with
    `name: 'old'`, with no `certPem`, with a certificate that has 23 h left, with another certificate's key, with a
    `certKeyEnc` that does not decrypt, or with a `certPem` that is no certificate, gives `http`; the same row under an
    app with `ACME_DIRECTORY: 'off'` gives `http`; the file never contains `certKeyEnc`, `PRIVATE KEY` or the account
    key.
  - `compose.test.ts`: the app's `ACME_DIRECTORY` is `${ACME_DIRECTORY:-}`. `config.test.ts`: unset and empty give
    `LETS_ENCRYPT`, `off` gives null, `http://x` throws the message above.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/client.test.ts test/link.test.ts
  test/compose.test.ts test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, then `npx drizzle-kit generate --name link_tls` from `apps/server`, then
  `store.ts`, `HIDDEN`, the settings, the frpc config, `acmeDirectory` and the compose line.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the link's certificate in the database and run the tunnel in https mode when it may".

### Task 8: LinkTls: ordering, renewal, backoff and the tunnel's mode

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Tasks 1 to 7 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/link-tls.test.ts test/tls-checks.test.ts
test/link.test.ts test/setup.test.ts` passes, `npm run test:real` from the root passes, and `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/tls/checks.ts`, `apps/server/src/modules/tls/manager.ts`
- Modify: `apps/server/src/app.ts` (`ctx.tls`, made after `ctx.links`; `onClose` stops it), `apps/server/src/main.ts`
  (`await ctx.tls.serveOn(listener)` in place of Task 5's `use`, then `ctx.tls.start()`),
  `apps/server/src/modules/link/link.ts` (the `PublicLinks` constructor's ctx type gains `tls?: { kick(): void }`; `set`
  and `remove` call `this.ctx.tls?.kick()` after their `sync`; `sync()` answers `Promise<boolean>`, true once
  `tunnel.json` is written, false when the write failed and was logged as today),
  `apps/server/src/modules/setup/routes.ts` (`ctx.tls.kick()` after the link's `sync`),
  `apps/server/src/modules/link/routes.ts` (`GET /api/link` adds `tls`)
- Test: `apps/server/test/link-tls.test.ts`, `apps/server/test/tls-checks.test.ts` (both new),
  `apps/server/test/link.test.ts` (its `GET /api/link` equalities, lines 53 and 75, gain `tls: null` and `tls: {
  mode: 'http', certificate: false, expiresAt: null, failedAt: null }`)

**Interfaces:**
- Consumes: `AcmeAccount`, `AcmeError`, `ChallengeHooks`, `newAccountKey`, `ctx.challenges`, `renewalInfo`, `certId`
  (Task 6); `certInfo`, `selfSigned` (Task 4); `LinkListener.use` (Task 5); `tlsOf`, `saveTls`, `updateTls`,
  `linkMode`, `config.acmeDirectory` (Task 7); `ctx.links.relay.health()`, `ctx.links.sync()`, `linkOf`;
  `encryptSecret`, `decryptSecret`.
- Produces:
  ```ts
  // checks.ts
  export async function probe(url: string, certPem: string, opts?: { tries?: number; everyMs?: number; timeoutMs?: number; deadlineMs?: number; ca?: string }): Promise<boolean>;
  //   GET <url>/api/health with the certificate checked (ca: extra trust, for tests); true once it answers 200 and the
  //   peer certificate's fingerprint256 equals certInfo(certPem).fingerprint256; every try on a new connection
  //   (agent: false), destroyed after timeoutMs; false after tries or deadlineMs, whichever comes first;
  //   defaults 20 tries, 3000 ms apart, 5000 ms a try, 60000 ms in all
  // manager.ts
  export type Acme = Pick<AcmeAccount, 'account' | 'issue'>;
  export type Served = { use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void> };
  export type TlsView = { mode: 'http' | 'https'; certificate: boolean; expiresAt: string | null; failedAt: string | null };
  export class LinkTls {
    constructor(ctx: Ctx, opts?: {
      acme?: (directory: string, accountKeyPem: string, accountUrl: string | null) => Acme;  // default: new AcmeAccount(...)
      renewalInfo?: typeof renewalInfo; probe?: typeof probe;
      now?: () => number; random?: () => number;
    });
    start(): void;          // a tick now and every 60 s; nothing when config.acmeDirectory is null
    stop(): void;
    tick(): Promise<void>;  // one pass; a tick while one runs gives the running one; nothing when config.acmeDirectory is null
    kick(): void;           // a tick now; nothing before start()
    serveOn(listener: Served): Promise<void>;  // gives it the current certificate now (resolved once in) and after every change
    view(): Promise<TlsView | null>;  // null while there is no link; certificate: a certificate for the link's name is in
    //   (with certificates off: { mode: 'http', certificate: false, expiresAt: null, failedAt: null })
  }
  // GET /api/link: { link, domain, tls: TlsView | null }
  ```
- One pass of `tick`, with `now` from `opts.now`, the link from `public_links` and the row from `tlsOf`:
  1. No link: a row with a certificate loses it (`name`, `certPem`, `certDirectory`, `certKeyEnc`, `notAfter`,
     `renewAt`, `askAt` to null, `mode: 'http'`) and the account stays. Go to step 7.
  2. No row, or a row whose `directory` is not `config.acmeDirectory`: a new account key from `newAccountKey()` and
     `accountUrl: null` (a certificate it holds stays and is renewed through the new account, without `replaces`).
  3. Due to order: there is no certificate for the link's name, or `renewAt <= now`; and `nextTryAt` is null or
     `<= now`. An `Acme` is made for the order from the row's directory, decrypted account key and `accountUrl`; with
     no `accountUrl`, `account()` gives one and it is saved. `issue(<link host>, hooks, { replaces })`, where `<link
     host>` is the host of the link's `url`, with `replaces = certId(certPem)` only when renewing a certificate of the
     same name whose `certDirectory` is the row's `directory`, and `certId` is not null; `hooks` answer and forget
     through `ctx.challenges`; the self-check is acme-client's, left on. A `refused` of an order sent with `replaces`,
     unless its type ends in `rateLimited`, is ordered once more without `replaces` (this covers `alreadyReplaced`
     and a CA that will not take the old certificate's id); one whose type ends in `accountDoesNotExist` drops
     `accountUrl` and is ordered once more. A chain whose `certInfo.names` lacks the host
     counts as `invalid`. Success saves `name`, `certPem`, `certDirectory: directory`, `certKeyEnc`
     (`encryptSecret(keyPem, config.secret)`), `notAfter`, `renewAt: null`, `askAt: now`, and `nextTryAt`, `failure`
     and `failedAt` null; a certificate for another name than the row held before also saves `mode: 'http'`, so its
     first `https` goes through step 8 and its probe.
  4. Failure: `not_ready` sets `nextTryAt = now + 5 min`; any other sets `now + max(1 h, retryAfterS)`; both save
     `failure` and `failedAt`. One warning line in the log, with the kind and type only.
  5. ARI, for a certificate of the link's name with `askAt <= now`: `renewalInfo(row.directory, certPem)`. A window:
     `renewAt` stays if it lies inside it, else becomes `start + random() * (end - start)`, or `now` when `end <=
     now`; `askAt = now + clamp(retryAfterS, 1 h, 24 h)`. `null`: `renewAt` stays, else `notBefore + 2/3 * (notAfter -
     notBefore)`; `askAt = now + 6 h`. An error: as `null` for `renewAt`, `askAt = now + 1 h`.
  6. Relay health: `ctx.links.relay.health()` when there is no answer yet or the latest is 10 minutes old; the answer
     and its time are kept in memory.
  7. The listener: `use(<link host>, { certPem, keyPem })` for a certificate of the link's name, `use(<link host>,
     null)` without one, `use(null, null)` without a link, given whenever it differs from what it was last given (and
     at once on `serveOn`), and awaited; a throw is one warning line, the next pass gives it again, and until it is in
     the wanted mode below is `http`.
  8. The mode, by the ruling "The tunnel's mode": wanted `http` when there is no certificate for the link's name,
     `notAfter - now <= 24 h`, or the listener does not hold that certificate (step 7); else `https` if the latest
     health was `up` and `passthrough` and `httpsBlockedUntil` is null or past, `http` if it was `up` and not
     `passthrough`, and the row's mode while there is none or it was not `up`. A change to `https` asks health once
     more first and stops unless that says `up` and `passthrough`. A change saves `mode` and calls `ctx.links.sync()`.
     After a change to `https`, and on the first pass after `start` when the row is in `https`, `probe(<link url>,
     certPem)` runs; a false probe saves `http` and `httpsBlockedUntil: now + 1 h` and syncs again. Whenever `sync()`
     answers false, every later pass calls it again until it answers true.
- `probe` uses `node:https` with the certificate checked.

- [ ] **Step 1: Write failing tests.** `tls-checks.test.ts`, on a local `https.createServer` with a `selfSigned` pair:
  - `probe is true for its own certificate and false for another or a closed port` (`ca` set to the server's PEM).
  - `gives up on a server that never finishes TLS, or never answers`: a `net.createServer` that accepts and sends
    nothing, and a TLS server that never answers the request: `probe(..., { tries: 3, everyMs: 10, timeoutMs: 200,
    deadlineMs: 500 })` is false within 1.5 s for each.
  - `asks over a new connection each time`: a TLS server that gives its first connection another `selfSigned`
    certificate and later ones the right one (counted in its `secureConnection` handler, through `SNICallback`):
    `probe(..., { tries: 3, everyMs: 10 })` is true.
  `link-tls.test.ts`, on `testApp({ ACME_DIRECTORY: 'https://acme.invalid/directory', RELAY_URL: <fake relay>,
  TUNNEL_HOST: TUNNEL })` with a company and a link `acme` taken through `ctx.links.set`, a `LinkTls` made in the test
  with a fake `acme` (it records its calls, calls `hooks.answer('tok', 'tok.ka')` and records
  `ctx.challenges.get('tok')`, calls `hooks.forget('tok')`, and answers `await selfSigned(host, { days: 90, now: <the
  clock> })`, or throws what the test sets), a fake `renewalInfo` (null unless the test sets a window) and a fake
  `probe`, `now` on a clock the test moves, and `random: () => 0.5`; `tick()` called by the test:
  - `orders the link's first certificate and keeps its key encrypted`: one `issue` for `acme.hornhoof.test` with no
    `replaces`; the recorded `get('tok')` is `'tok.ka'`, and after the tick `ctx.challenges.get('tok')` is undefined;
    the row's `certPem` names the host, `certKeyEnc` decrypts to a PEM that `X509Certificate.checkPrivateKey`
    takes, `certKeyEnc` does not contain `PRIVATE KEY`, and `accountUrl` is saved.
  - `does nothing without a link, or when certificates are off`.
  - `waits an hour after a failed order, and longer when the CA says so`: `refused` with type `...:rateLimited` and
    `retryAfterS: 7200`: no `issue` at +1 h, one at +2 h 1 s; `invalid`: one again at +1 h 1 s, none before.
  - `waits five minutes when its own check of the challenge fails`: `new AcmeError('not_ready')`: none at +4 min, one
    at +5 min 1 s.
  - `renews inside the window the CA suggests, replacing the old certificate`: window +10 days to +12 days: `renewAt`
    is +11 days; no `issue` at +10 days, one at +11 days with `replaces` equal to `certId(<the old certPem>)`.
  - `renews at two thirds of the lifetime without renewal information`: `renewalInfo` gives null for a 90-day
    certificate: `renewAt` is `notBefore` + 60 days.
  - `asks the CA again after its Retry-After, between an hour and a day`: Retry-After 60 s gives `askAt` +1 h; 7 days
    gives +24 h.
  - `orders anew for a renamed link, without replaces, on http until it is in`: in `https`, `ctx.links.set(companyId,
    'globex')`: `tunnel.json` says `http` at once; the next tick issues for `globex.hornhoof.test` without `replaces`.
  - `moves the tunnel to https once the relay passes TLS through and the certificate is in`: fake relay
    `passthrough: true`: after the tick, `tunnel.json` says `https`, the row says `https`, and `probe` was called with
    the link's URL and the row's `certPem`.
  - `stays on http while the relay does not pass TLS through, and goes back when it stops`: `passthrough: false` keeps
    `http`; `true` gives `https`; `false` again and the clock past 10 minutes gives `http`.
  - `keeps the mode while the relay does not answer`: in `https`, the fake relay `down` and the clock past 10 minutes:
    still `https`.
  - `goes back to http when the switch does not serve the certificate, and tries again an hour later`: `probe` false:
    `http`; at +30 min no `probe`; at +61 min `https` and `probe` again.
  - `gives the listener the certificate before it switches`: with a fake `Served` that records its calls, the last
    `use` before `probe` was called holds the row's `certPem`; with a `use` that throws, the mode stays `http` and
    `probe` is not called.
  - `probes https again after a restart, and keeps the hour's block`: a row in `https`; a new `LinkTls` on the same
    database with `probe` false: its first tick gives `http` and saves `httpsBlockedUntil`; another new `LinkTls` at
    +30 min with `passthrough: true` stays `http`; at +61 min it gives `https` and probes.
  - `writes the tunnel's mode again after a failed write`: a switch whose `probe` is false, with `ctx.links.sync`
    answering false once (`vi.spyOn(...).mockResolvedValueOnce(false)`): the row says `http`, and after the next tick
    `tunnel.json` says `http` too.
  - `goes back to http a day before the certificate ends`: renewal failing, at `notAfter` - 23 h the mode is `http`.
  - `keeps https across a restart`: a new app (with the same `ACME_DIRECTORY`) on the same database and control
    folder writes `https` into `tunnel.json` on ready, before any `LinkTls` tick or health answer.
  - `serves the stored certificate, and a stand-in without one`: `await serveOn(fake)` gives `use('acme.hornhoof.test',
    { certPem, keyPem })`; after a rename to `globex` with `issue` failing, the next tick gives
    `use('globex.hornhoof.test', null)`; after `ctx.links.remove`, the next tick gives `use(null, null)` and the row has
    no certificate but its account.
  - `switches a new name's certificate to https only through the probe`: in `https` on `acme`, a rename to `globex`,
    a successful order for it and `probe` false: `probe` was called with `globex`'s `certPem`, and the row and
    `tunnel.json` say `http`.
  - `makes a new account when the CA changes`: the same row under a `LinkTls` whose ctx says another directory: a new
    account key, `account()` called; the certificate is renewed when due, after more ticks and a restart in between,
    with no `replaces`.
  - `runs one pass at a time`: two `tick()` at once make one `issue`.
  - `tells the link's encryption`: `GET /api/link` gives `tls: { mode, certificate, expiresAt, failedAt }`
    (`expiresAt` the ISO `notAfter`), and `tls: null` with no link; no field holds a key.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/link-tls.test.ts test/tls-checks.test.ts`.
  Expected: FAIL (no module).
- [ ] **Step 3: Implement** the interfaces and the wiring.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Get and renew the link's certificate on its own, and switch the tunnel to https when the
  relay passes it through".

### Task 9: What people see and read

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Task 8 committed. **Done when:** from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Settings.test.tsx test/Machines.test.tsx
test/Setup.test.tsx test/i18n.test.tsx` passes, the whole suite passes from the worktree root, and `npx tsc -p
apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/screens/Settings.tsx`, `apps/web/src/screens/Machines.tsx`, `apps/web/src/screens/Setup.tsx`,
  `apps/web/src/ui/LinkName.tsx`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`, `SECURITY.md`,
  `guide/public-link.md`, `README.md`
- Test: `apps/web/test/Settings.test.tsx`, `apps/web/test/Machines.test.tsx`, `apps/web/test/Setup.test.tsx`

**Interfaces:**
- Consumes: `GET /api/link` with `tls: TlsView | null` (Task 8); `POST /api/setup` answering `link: { name, url }`
  when it made one.
- Texts (EN, RU):
  - `settings.encryptedHere`: `Encrypted to this machine` / `Зашифровано до этой машины`
  - `settings.encryptedRelay`: `Encrypted to hornhoof.org for now. Hornhoof moves the encryption to this machine on
    its own.` / `Пока зашифровано до hornhoof.org. Hornhoof сам перенесет шифрование на эту машину.`
  - `machines.certEnds(date)`: `` `The link's certificate ends on ${date} and has not renewed yet. Hornhoof tries again
    every hour. If it ends, the link keeps working, encrypted to hornhoof.org.` `` / `` `Сертификат ссылки заканчивается
    ${date} и еще не обновился. Hornhoof пробует снова каждый час. Если он закончится, ссылка продолжит работать, с
    шифрованием до hornhoof.org.` ``
  - `setup.linkWait`: `Getting the certificate for your link. This takes under a minute.` / `Получаем сертификат для
    вашей ссылки. Это занимает меньше минуты.`
  - `setup.linkReady`: `People open your company from anywhere at this link:` / `Компания открывается откуда угодно по
    этой ссылке:`
  - `setup.linkLater`: `The link works now. Its own certificate comes on its own; until then the connection is
    encrypted to hornhoof.org.` / `Ссылка уже работает. Свой сертификат придет сам, а до тех пор соединение
    зашифровано до hornhoof.org.`
  - `link.letsEncrypt`: `{ before, agreement, after }`, shown as `before`, then `agreement` as a link to
    `https://letsencrypt.org/repository/` (Let's Encrypt's page of its current Subscriber Agreement; `target="_blank"`,
    `rel="noreferrer"`), then `after`: EN `The link's certificate comes from Let's Encrypt. Getting it accepts the ` /
    `Let's Encrypt Subscriber Agreement` / ` for your company.`; RU `Сертификат ссылки выдает Let's Encrypt. Получая
    его, вы принимаете за компанию ` / `Соглашение подписчика Let's Encrypt` / `.`
  - `link.guessable` becomes: `A name you pick shows in public certificate logs and may tell whose company this is.
    Only the company's sign-in protects what is inside.` / `Выбранное имя видно в публичных журналах сертификатов и
    может подсказать, чья это компания. То, что внутри, защищает только вход в вашу компанию.`
  - `link.hardToGuess` becomes: `A random name does not say whose company it is. The company's sign-in still protects
    what is inside.` / `Случайное имя не говорит, чья это компания. То, что внутри, все равно защищает вход в вашу
    компанию.`
- A random name by default (the ruling): `LinkName` gains `startRandom?: boolean`; when it is set and `name` is empty
  as it mounts, it calls `onName(randomLinkName())` once and keeps that name as its `random`, so the safety line says
  `hardToGuess`. Setup's link name no longer follows the company name (`nameCompany` sets only the company name, and
  `linkOwn` goes), and its `LinkName` has `startRandom`. Settings drops `suggested`; with no link, its `LinkName` has
  `startRandom`, and a removed link starts a new random name.
- Settings: under the link's URL, `encryptedHere` when `tls.mode === 'https'`, else `encryptedRelay`, and under it
  `link.letsEncrypt`, whenever `tls` is not null. Machines: for
  people who see the whole company, one `GET /api/link` when the tab opens; when `tls.expiresAt` is less than 14 days
  away, `certEnds` above the list, the date as the screen shows dates elsewhere (else `toLocaleDateString` in the
  chosen language), in a `<p className="alert" role="status">`. Setup: after a setup that made a link, a card with
  `linkWait` that asks `GET /api/link` every 2 s; once `tls.certificate` is true, or after 90 s, it shows
  `linkReady` (or `linkLater` after 90 s without it) with the link and a `CopyButton`, with `link.letsEncrypt` in the
  card from the start, and `t.common.next` goes on to the command card or the map as today.
- `SECURITY.md`:
  - Line 36 becomes: `- Failed sign-ins are capped, and the counts survive a restart: 10 in 15 minutes for one email
    from one address, 50 in an hour for one email, and 30 in an hour from one address across all emails (an IPv6
    address counts with its /64).`
  - Line 37 gains: `On the hornhoof.org link the cookie's name starts with __Host-, so no page under another link can
    set or replace it. A session from before that change moves to the new name once, on its next visit.` (with
    `__Host-` in backticks)
  - Line 53 becomes: `- The browser's https connection ends at your own machine. hornhoof.org reads only the name
    being reached from the start of each connection, passes the encrypted bytes on through that company's tunnel, and
    keeps no copy. Your machine gets the link's certificate from Let's Encrypt itself, accepting Let's Encrypt's
    Subscriber Agreement for the company, and renews it on its own. If hornhoof.org stops passing connections through
    unread, or the certificate cannot be renewed in time, the link keeps working with its https ending at hornhoof.org,
    and Share access says so. A company on an older Hornhoof is served that way until it updates. If you want no one in
    between at all, use your own domain with your own TLS, as [the install guide](guide/install.md#how-do-people-open-it-from-other-computers) shows.`
  - A new line after it: `- A link's name is public: every certificate goes into public Certificate Transparency
    logs. Before sign-in, the link tells nothing about the company (not its name, its people or its version), and it
    asks search engines not to list it.`
  - And one after that: `- To stop your machine getting its own certificate, put ACME_DIRECTORY=off in the .env file
    next to compose.yaml and run docker compose up -d app there. The link then runs with its https ending at
    hornhoof.org, as before.` (with `ACME_DIRECTORY=off` and `docker compose up -d app` in backticks)
- `README.md`, a new question at the end of "Questions": `**What if the hornhoof.org link stops opening after an
  update?**` and `Put ACME_DIRECTORY=off in the .env file in the ~/hornhoof folder and run docker compose up -d app
  there. The link opens again within a minute, with its https ending at hornhoof.org as before. Then tell us in an
  issue.` (with `ACME_DIRECTORY=off`, `.env`, `~/hornhoof` and `docker compose up -d app` in backticks)
- `guide/public-link.md`: the "In short" line and "Who can reach it?" say that link names are public (each certificate
  is listed in public logs), that Hornhoof starts with a long random name, which the person may change, that a random
  name does not say whose company it is, and that the company's sign-ins protect what is inside; "What does hornhoof.org
  see?" says the connection is encrypted to the company's own machine, which gets its link's certificate from Let's
  Encrypt, so hornhoof.org passes it on unread and sees only the name being reached, and that the link falls back to
  https ending at hornhoof.org while that is not possible, as Share access shows.

- [ ] **Step 1: Write failing tests.**
  - `Settings.test.tsx`: `says the link is encrypted to this machine in https mode, and to hornhoof.org otherwise`;
    `names the Let's Encrypt Subscriber Agreement with a link to it` (a link with the `agreement` text and `href`
    `https://letsencrypt.org/repository/`; none without a link).
  - `Machines.test.tsx`: `warns 14 days before the link's certificate ends` (13 days: the text is there; 15 days: it is
    not); `asks nothing about the link for people who do not see the whole company` (no `GET /api/link`).
  - `Setup.test.tsx`, with `randomLinkName` mocked (`vi.mock('@hornhoof/protocol/link', ...)`, the rest kept) to
    `r4nd0mr4nd0mr4nd0m` and its name check mocked: the existing `opens Hornhoof on the internet at a link made from
    the company name as it is typed` (line 219) becomes `starts the link with a long random name and keeps it while
    the company name is typed` (the Link field holds `r4nd0mr4nd0mr4nd0m` before and after typing `Рога и копыта`,
    and the safety line is the new `hardToGuess`); every other existing test that took its link name from the company
    name clears the Link field and types the name there instead.
  - `Settings.test.tsx`: `starts a company with no link on a long random name` (the same mock; no name made from the
    company's).
  - `Setup.test.tsx`: `shows the new link once its certificate is in` (the mock answers `certificate: false`, then
    `true`: `linkWait`, then `linkReady` with the URL, and the agreement's link in the card throughout); `shows the
    link after 90 seconds anyway` (fake timers, always `false`: `linkLater` with the URL); `goes on as today without
    a link` (no agreement line either).
  - The existing `i18n.test.tsx` checks hold for the new texts (no em dash, no "ё", no "компьютер" or "узел").
- [ ] **Step 2: Run** the Done when's vitest command. Expected: FAIL.
- [ ] **Step 3: Implement** the screens, the texts and the three documents.
- [ ] **Step 4: Run Done when.** Expected: PASS. `grep -n "ends at hornhoof.org" SECURITY.md` prints nothing, and
  `grep -rn "$(printf '\342\200\224')" SECURITY.md guide/public-link.md README.md apps/web/src/i18n` (an em dash)
  prints nothing.
- [ ] **Step 5: Commit** "Show where the link's encryption ends and whose agreement it rests on, warn before its
  certificate ends, and say that link names are public".

### Task 10: Run everything, review, ship by Update, merge

**Repo:** Hornhoof worktree, branch `company-certificate`. **Starts from:** Tasks 1 to 9 committed and reviewed, plan 1
deployed (`curl -s https://hornhoof.org/api/v1/health` says `"passthrough": true`). **Done when:** Steps 1 and 2 pass
for the agent; Steps 3 to 7 are the team lead's, never an agent's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` → pass; `npx tsc -p
  apps/server/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` → no output.
- [ ] **Step 2: Check the public-repo rule.** `git diff main --stat` lists no certificate, key or `.pem` file; `git grep
  -nE "BEGIN (EC )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` and `git grep -n "5y32"` each print nothing and exit with
  status 1 (no match); any other status is a failed scan, not a pass. Then `npm audit --omit=dev > <ws>/audit.log 2>&1`
  from the worktree root, and `<ws>/audit.log` goes to the team lead as it is, whatever it lists; the team lead decides
  on each finding (Open points, 4). The agent changes no dependency for it.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.10, the overview's plan 1b scope and TLS
  section, and this plan's rulings; the CLI agent that did not write a task reviews it too (Gemini for Codex's tasks,
  Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Before shipping** (team lead): `dig +short CAA hornhoof.org` is empty or names `letsencrypt.org`
  (overview: a step the team lead runs). Optional rehearsal against Let's Encrypt's staging CA: a throwaway install
  built from the branch with `ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory` in its `.env` and a
  link `relay-check-<8 random hex>`. Its app must trust the staging roots, since the switch's probe checks the
  certificate: Let's Encrypt's two staging root certificates
  (`https://letsencrypt.org/docs/staging-environment/#root-cas`) in one file `staging-roots.pem` next to its
  `compose.yaml`, and a `compose.override.yaml` there that gives the `app` service `NODE_EXTRA_CA_CERTS:
  /run/staging-roots.pem` and mounts that file there read-only; within a minute of setup `openssl s_client -connect
  <name>.hornhoof.org:443 -servername <name>.hornhoof.org </dev/null 2>/dev/null | openssl x509 -noout -issuer -ext
  subjectAltName` shows a `(STAGING)` issuer and the name; then the install and its link are removed.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from
  (`.github/workflows/images.yml:62`, label `io.hornhoof.title`), and every existing company accepts Let's Encrypt's
  Subscriber Agreement on its first order after this Update, so the team lead writes the merge commit into main with
  exactly this subject (103 characters, no double quote, which the workflow drops):
  ```text
  Serve the company link over https from your own machine, accepting Let's Encrypt's Subscriber Agreement
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images; the Update banner
  shows that title.
- [ ] **Step 6: Update Ivan's install and check** (team lead), after the Update button: within a few minutes
  - `openssl s_client` as in Step 4 against Ivan's link shows a Let's Encrypt issuer (not `(STAGING)`) and only the
    link's own name, not `*.hornhoof.org`;
  - Share access says "Encrypted to this machine" with the agreement line; a browser signed in on the link before the
    Update is still signed in, now with `__Host-hh_session` and no `hh_session`;
  - `curl -s https://<link>/api/health` gives `{"ok":true}`; `curl -s -o /dev/null -w '%{http_code}'
    https://<link>/api/version` gives `401`; `curl -sI https://<link>/` carries `x-robots-tag: noindex, nofollow`;
    `curl -s https://<link>/robots.txt` disallows all;
  - every machine connected through the link is online again in the Machines tab;
  - on localhost, `/api/health` still gives the version and commit, and the updater's next check works.
  If the link does not answer within 5 minutes: put `ACME_DIRECTORY=off` in the install's `.env` and run `docker
  compose up -d app` next to its `compose.yaml`; the app writes the tunnel back to `http` (Task 7's `linkMode`) and
  the link is served through hornhoof.org as before. Then stop and report.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/company-certificate` once
  main has the branch.
