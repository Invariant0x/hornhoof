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

- You read batch 6, slice cert, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-6, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch6-cert.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This slice

Plan 1b Task 7: the certificate's row and the tunnel's https mode. Security class: two readers at once, each alone. Nothing orders a certificate until Task 8, which is being written on top of this.

The batch's other slices are Plan 2 Task 3 (the app's mode, `ctx.mode`) and the sql-check part of Plan 3 Task 3. The Claude reader of this slice is also the reader named for the interactions between slices: `apps/server/src/config.ts`, `apps/server/src/app.ts` and `apps/server/src/db/agent-sql.ts`, read on the branch as they now stand. The two config splits were merged by the lead.

Read for: where the private key can be seen or leave from (agent SQL, reader role, logs, API answers, backups named in the plan); what the tunnel does when the row, the key or the certificate is missing, wrong or expired; what an old `tunnel.json` with no mode means.

# The tasks

## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 7

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


