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

- You read batch 10, slice relay, in `/home/altera/hornhoof-network/hornhoof-edge` on the branch batch-10, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch10-relay.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This batch

Batch 10 is the relay's: Plan 1 Task A1 (a link's owner may choose its new key; `hornhoof-relay add` refuses a live name; words about retired keys) and Plan 9c Task 12 (the relay counts the bytes it sends each month). Read in `/home/altera/hornhoof-network/hornhoof-edge` on the branch `batch-10`, read only.

Look hardest at, in A1: who may set a key now and how (`key_answer`, `store_link_key`): can anyone but the holder of the current key set one, can an old key come back and for whom, does a lost answer now leave the owner with their link and nobody else with it, is the new key's strength checked, and does a chosen key reach a log. In `hornhoof-relay add`: the refusal when frps cannot answer, and `runuser` passing the env on (a stub in the tests; only its man page says so): say what an operator gets if it does not. In A2: anything the counter writes under the write queue's lock order, a wrong month at a year's end and at a counter reset, and that it reads only `/proc` and `/sys`.

Plan 1's contract table, the seam to the Hornhoof client: `apps/server/src/modules/link/relay.ts`'s `changeKey` gets its `next` later (Plan 9 Task 3); check that the answers `invalid`, `same_key` and 200 `{ key }` read the same as that task's text. Do not run anything against a live service.

# The tasks

## 2026-11-03-network-phase-1-plan-1-relay-contract, Task A1

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  This plan adds no UI strings.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. In the relay repo every commit is also signed off
  (`commit -s`, the DCO line `Signed-off-by: Ivan Korol <<owner's address, the lead's alone>>`). Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `relay/test/.bin/`, `deploy.env`.
- Nothing private in the relay repo (overview decision 1): no droplet IP, no hostname but hornhoof.org and names under
  it, no key, token, password, ssh config or certificate, no company's link name. Private values stay in
  `~/.hornhoof-edge/`, and the deploy reads them from there; the repo carries only examples. `relay/test/test_public.py`
  (Task 1) checks every tracked file on every test run, so each commit passes it.
- Tests first. Hornhoof, from `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole
  suite from the repo root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`, plus
  `npx tsc -p apps/server/tsconfig.json --noEmit`. Relay, from the relay repo root:
  `python3 -m unittest discover -s relay/test -v`. Never run prettier.
- relay.py: Python standard library only, and it must run on the droplet's Python 3.12 (Ubuntu 24.04): no syntax
  newer than 3.12. frps and frpc exactly 0.71.1, sha256-checked; Caddy in tests at the one 2.11 release
  `relay/test/caddy.sh` pins, checked against Caddy's release checksums.
- Fail closed: any error, timeout, unknown value or missing field in an answer about a route reads as unknown, never
  as empty (R2). The relay answers 503 when it cannot tell whether a route is live.
- frps calls the plugin with no timeout, inside each client's control loop (`pkg/plugin/server/http.go:50`,
  `pkg/msg/handler.go:185-186`): every dashboard read the plugin makes has a 1 s timeout, and a timeout refuses the op.
- Today's tunnels keep working unchanged after the deploy: frpc 0.71.1 with `transport.heartbeatInterval = 30` and
  `heartbeatTimeout = 90` set, one http proxy named after the binding, no client id
  (`apps/server/src/modules/link/client.ts:20-45`).
- The relay never logs or returns a link key, visitor key or stcp secret, except the one answer that hands a key out,
  and never logs or keeps a visitor's address from `NewUserConn`.
- hornhoof-edge's README says what is true at each commit; from Task 9 on it says plainly that the relay sees only
  encrypted bytes and the name being reached, for every company whose link uses `https`.
- Nothing touches the droplet before Task 13. Its restart follows overview decision 4: one restart, starting between
  06:00 and 07:15 UTC (03:00 and 04:15 at UTC-3), only while no connection on port 443 is busy, never on a night the
  droplet waits to reboot.


### Task A1: A chosen key (R6.1)

**Repo:** relay repo, branch `main`. **Starts from:** this plan's Tasks 1 to 13 deployed. **Done when:** `python3 -m
unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py` (`POST /api/v1/links/<name>/key`; the module docstring's line for it)
- Test: `relay/test/test_keys.py`

**Interfaces:**
- Produces: `POST /api/v1/links/<name>/key`, still authenticated by the current key (401 and its count as today),
  takes an optional JSON body `{key}`:
  - without a body, or with `{}`: as Task 7, a new random key;
  - `key` matching `^[A-Za-z0-9_-]{43}$` (32 bytes, base64url without padding) and not the current key: its hash
    replaces the old one, the answer is 200 `{key}` with that key, and from then on the old key is refused by every
    endpoint and at `Login`, as Task 7; live sessions stay;
  - `key` of any other form, or another field: 400 `{error: 'invalid'}`; `key` equal to the current key: 400
    `{error: 'same_key'}`; in both the stored key is unchanged.
- Hornhoof's fake relay answers the same (plan 9's Task 3).

- [ ] **Step 1: Write failing tests** in `test_keys.py`:
  - `test_r6_1_chosen_key`: a `network` client holds `acme`; post `/key` with the current key and `{key: K}`, K 32
    random bytes in base64url: 200 `{key: K}`; the route with K 200 and still `held`, with the old key 401; a new
    client logging in with the old key is refused.
  - `test_r6_1_chosen_key_refused`: with the current key, `{key: <42 characters>}`, `{key: <43 with a '+'>}` and
    `{key: K, extra: 1}` each answer 400 `invalid`; `{key: <the current key>}` answers 400 `same_key`; after each the
    route with the current key is 200. With a wrong key in the header, a well-formed `{key}` answers 401 and changes
    nothing.
  - `test_r6_1_random_key_stays`: a post with no body still answers a new random key, as `test_r6_1_change_key`.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_keys.py -v`. Expected: FAIL (the body is ignored).
- [ ] **Step 3: Implement** the body in `relay.py`.
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** (`commit -s`) "Let a link's owner choose its new key, so a lost answer does not lose the
  link".
- [ ] **Step 6: Deploy** (the team lead's): with the series' other relay work, at night, as Task 13's Steps 7 and 8,
  before the series' rehearsal. Check: with a throwaway name, a post with `{key}` answers that key and the route takes
  it.

## 2026-11-03-network-phase-1-plan-9c-planned-switch, Task 12

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; in Russian a plan is «тариф».
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`, `.superpowers/`,
  `archive/`, `companies/`, `deploy.env`. The relay repo's commits are `commit -s` with the same name and email, as plan
  1's.
- Nothing private in either repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and passwords made at run time. The runbook line goes into the team lead's private
  `~/.hornhoof-edge/droplet/README.txt`, never into a repo.
- No new npm dependency, and no new Python package in the relay. One new migration, `0057_switch`: `npx drizzle-kit
  generate --name switch` from `apps/server` for what `schema.ts` describes, with the hand-written part of Task 1
  appended after a `--> statement-breakpoint`; never an edit of an older one. Its number follows plan 9b's `0056`; the
  series' migrations are numbered again at the merge into main.
- One leader at a time (spec 3.4): the old leader writes nothing after it fenced, and the new one writes nothing, its
  app included, before its promotion ended; after the old leader sent "go", it leads again only on the new one's word.
  Hornhoof moves the server only on the CEO's request (spec 3.3); nothing here starts a switch by itself.
- No confirmed write is lost (spec 3.4, section 9): the new leader promotes only once its slot confirmed the old
  leader's last position W, a copy joins the new leader with `copy_data = false` only when it confirmed W, and the
  update's dump is taken only after every promised copy confirmed W, else the update ends with nothing changed. No
  database is thrown away before it is merged (spec 3.7, plan 9's Global Constraints).
- Messages between keepers and apps change only by additions (spec section 9): a keeper of plan 9b's build that does not
  know a peer path answers 404, which reads as "not ready", and a status or view without the new fields keeps what it
  had.
- Ivan's rules: only a machine's owner opens computer access to it; no step of this plan asks Ivan to type a command.
  The CEO only presses "Move the server here" or Update; everything else happens by itself.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.
- Before a real or lab run on the team lead's Mac: `df -h /` and `docker system df`; clean only build cache and
  `hornhoof-lab/*` images, never a volume.


### Task 12: The relay counts its traffic (addendum A2 to plan 1)

**Repo:** the relay repo, `/home/altera/hornhoof-network/hornhoof-edge`, branch `main`. **Starts from:** plan 1's addendum A1
committed. **Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py` (the tables, the counter, its thread, `admin traffic`), `relay/hornhoof-relay` (its usage
  lines), `README.md` ("What it stores")
- Test: `relay/test/test_traffic.py` (new)

**Interfaces:**
- Produces, in `relay.py`:
  ```python
  TRAFFIC_EVERY_S = 60
  TRAFFIC_WARN_BYTES = 300 * 10**9
  def default_iface(proc: str = '/proc') -> str | None:   # the interface of the first 00000000 destination in <proc>/net/route
  def sent_bytes(iface: str, sys: str = '/sys') -> int | None:   # <sys>/class/net/<iface>/statistics/tx_bytes
  def boot_id(proc: str = '/proc') -> str | None:          # <proc>/sys/kernel/random/boot_id
  def count_traffic(at: int, proc: str = '/proc', sys: str = '/sys') -> int | None:
  #   adds what was sent since the last read to the UTC month of `at`, and answers that month's total; None when
  #   the interface or its counter cannot be read (nothing changes)
  def watch_traffic() -> None:   # every TRAFFIC_EVERY_S, forever, as watch_frps
  ```
- `init_db` makes `traffic (month TEXT PRIMARY KEY, bytes INTEGER NOT NULL)` and `traffic_seen (id INTEGER PRIMARY KEY
  CHECK (id = 1), boot TEXT NOT NULL, iface TEXT NOT NULL, sent INTEGER NOT NULL, at INTEGER NOT NULL)`.
- `count_traffic`: the same boot and interface and a reading at or above `sent`: adds the difference; another boot or
  interface, or a reading below `sent`: adds the whole reading (the counter started from zero); no `traffic_seen` yet:
  adds nothing. Then `traffic_seen` is the new reading. Both writes in one transaction.
- `watch_traffic` logs, at most once per UTC day while the month's total is past `TRAFFIC_WARN_BYTES`: "Sent <n> GB this
  month, past 300 GB: time to resize the server." (`<n>` in 10^9 bytes, one decimal); `main` starts it beside
  `watch_frps`; an exception in one round is one log line, and the next round runs.
- `admin traffic`: the last 12 months, oldest first, one line each: `<YYYY-MM>  <n> GB`; no rows: "No traffic counted
  yet.". `hornhoof-relay`'s comment lines gain `hornhoof-relay traffic  bytes sent per month, the last 12 months`; the
  usage line of `admin` names `traffic`.
- README, "What it stores": "For the server itself, the bytes its public interface sent each month, so its operator
  knows when to resize it." after the paragraph on addresses.
- The runbook line is the team lead's, in `~/.hornhoof-edge/droplet/README.txt`: "Each month: `hornhoof-relay traffic`.
  Past 300 GB of the 500 GB included, resize the droplet (the journal says so once a day)."

- [ ] **Step 1: Write failing tests** in `test_traffic.py`, with fake `proc` and `sys` folders in a temporary folder and
  `RELAY_DB` pointed at a fresh file as the other tests do:
  - `test_default_iface`: a route file with `eth1` on `00000000` after a line of `eth0` on another destination: `eth1`;
    with no default: None.
  - `test_counts_since_last_read`: readings 1000 then 1500 in one month: the month's total 500; then 1400 (went down):
    1900; then another `boot_id` with 300: 2200; another interface with 50: 2250.
  - `test_months_apart`: a reading at 23:59:30 UTC on the last day of a month and one at 00:00:30 on the next: the
    difference goes to the second month.
  - `test_unreadable_counts_nothing`: no route file: None and no row written.
  - `test_admin_traffic`: three months stored: `relay.py admin traffic` prints three lines oldest first with one
    decimal; none: "No traffic counted yet.".
  - `test_warns_once_a_day`: past 300 GB: two rounds on the same UTC day give one log line; a round the next day
    another.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_traffic.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** (`commit -s`) "Count the bytes the relay sends each month".
- [ ] **Step 6: Deploy and the runbook line** (the team lead's): with the series' other relay work, at its end, before
  the rehearsal, as addendum A1. Check: `hornhoof-relay traffic` on the droplet prints the month after two minutes.


