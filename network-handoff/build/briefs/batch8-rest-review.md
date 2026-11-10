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

- You read batch 8, slice rest, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-8, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch8-rest.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This batch

Batch 8 holds Plan 1b Tasks 8 and 9, Plan 2 Tasks 5, 6 and 7, and two bug fixes. It ends Plan 1b's code and Plan 2. Read in `/home/altera/hornhoof-network/hornhoof` on the branch `batch-8`, read only. The lead settled conflicts between these tasks and batch 6's fixes while assembling: `modules/link/client.ts` (`configFor`'s own-key check, now on `local`), `modules/link/link.ts` (`writeTunnelSettings(db, config, log?)`, `settingsWith`), and `modules/tls/store.ts` (`passes`, `readLinkMode`, `linkMode`). Read those on the branch and say if the join lost anything.

Writers' rulings and their open items are in the ledger, `network-build/progress.md`: the lines naming Plan 1b Task 8, Plan 1b Task 9, Plan 2 Task 5, Plan 2 Task 6, Plan 2 Task 7, and the carries beside them. Claims to check, not to trust.

This slice is Plan 1b Task 9 (what people see and read about the link's encryption: server shape `TlsView`, `GET /api/link`, `POST /api/setup`, en and ru, guide, `SECURITY.md`, `README.md`) and two bug fixes: `apps/node/src/terminal/host.ts` (a turn's late stop no longer falls on the next turn), and the web tests' wait limit. Look hardest at: a fact in the docs or the UI that is not true at this commit (who can read a visitor's traffic, when), a Russian string with "ё" or an English word left in it, and for `host.ts`: a real turn's stop lost, a hook of a different kind (Kimi's stop hook, an interrupt) with the same gap. The ledger's `Bug, terminal context test` lines hold two open items: say how they stand.

# The tasks

## 2026-11-03-network-phase-1-plan-1b-company-certificate, Task 9

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


