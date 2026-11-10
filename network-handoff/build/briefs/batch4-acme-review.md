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

- You read batch 4, slice acme, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-4, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch4-acme.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Your slice: ACME through acme-client (1b T6). Security class, two readers at once

The writer asks a question: `account()` ignores a failed createAccount once a URL is held, because acme-client follows the 200 with an update Pebble refuses, against the alternative of onlyReturnExisting first. Read RFC 8555 7.3.1 and acme-client, and say which is right, and whether a real failure is swallowed. Keys must never reach a log, a result or a test message, and nothing may point at real Let's Encrypt from a test. 5 tests ran against a real Pebble (ledger).

# The tasks

## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 6

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


