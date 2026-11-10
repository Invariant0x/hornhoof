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
6. Docker never runs on this machine; it runs Ivan's live company. On the test machine it is allowed only inside your own run: `remote.sh run --dind <label> '<command>'` gives a daemon in your container, and `npm run test:real` belongs there when a task's Done when names it. Do not run, build, pull, exec or inspect anything in Docker any other way.

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

- You read batch 8, slice cert, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-8, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch8-cert.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This batch

Batch 8 holds Plan 1b Tasks 8 and 9, Plan 2 Tasks 5, 6 and 7, and two bug fixes. It ends Plan 1b's code and Plan 2. Read in `/home/altera/hornhoof-network/hornhoof` on the branch `batch-8`, read only. The lead settled conflicts between these tasks and batch 6's fixes while assembling: `modules/link/client.ts` (`configFor`'s own-key check, now on `local`), `modules/link/link.ts` (`writeTunnelSettings(db, config, log?)`, `settingsWith`), and `modules/tls/store.ts` (`passes`, `readLinkMode`, `linkMode`). Read those on the branch and say if the join lost anything.

Writers' rulings and their open items are in the ledger, `network-build/progress.md`: the lines naming Plan 1b Task 8, Plan 1b Task 9, Plan 2 Task 5, Plan 2 Task 6, Plan 2 Task 7, and the carries beside them. Claims to check, not to trust.

Look hardest at, in this slice: a certificate or key text reaching a log, a client or a file with a wide mode; a row or a mode left saying https while the listener cannot serve it; a renewal that races a rename of the link or a step-down of `AppMode`; a failed try that stops future tries; what a person sees when Let's Encrypt refuses.

Nothing tests `LinkTls`'s default `new AcmeAccount` wiring against a CA. `npm run test:real` runs Pebble in this batch's check, with the account code and its own tests. Say whether one real test of the whole path (the manager with its default wiring, against Pebble, up to a certificate saved) would catch a harm that nothing else catches, and name the harm. If you find none, say so and we leave it.

# The tasks

## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 8

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


