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

- You read batch 9, slice harness, in `/home/altera/hornhoof-network/hornhoof` on the branch batch-9, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch9-harness.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Where to read

This batch's staging branch does not exist yet, because batch 6 lands first. Read the tree in the lane `/home/altera/hornhoof-network/wt/p3lease` instead, read only: it stands on batch 6's first commits, then Plan 3 Tasks 1 and 2 and the pure lease file. Batch 6's fix round (Plan 2 Task 3's `AppMode`, Plan 1b Task 7's store) is not under it and does not touch these files.

Plan 3 Task 4's rest (`lease-store.ts`, the keeper's renewals, the fence on a step-down) is not written. Nothing writes a lease yet, so agent roles are always fenced and the orchestrator's database writes are refused on a real company until then: the plan does not ship in part, by ruling. Do not report that as a finding. Do report what Task 4's writer will trip over.

Look hardest at: a write path that reaches a table with no journal entry or no fence, a role that can get around the fence (`SET ROLE`, `SECURITY DEFINER`, a default privilege, a function owner), what the journal stores about a person's secret columns (`HIDDEN`, `SECRET` in `apps/server/src/db/`), whether migration 0057 fails on a real company's existing data or locks a live one for long, and whether the real-Postgres tests would pass with the code wrong. The lease's edge cases: clocks that jump, a tick late by exactly the limit.

You are also this batch's reader for interactions, between the journal, the lease and what batches 4 to 6 already landed.

# The tasks

## 2026-11-03-network-phase-1-plan-3-fences-and-journal, Task 1

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=<owner's address, the lead's alone> commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and passwords made at run time.
- One new dependency, in `apps/server` only: `libpg-query` at exactly `17.7.3` (`npm install libpg-query@17.7.3
  --save-exact -w apps/server`), which brings `@pgsql/types`. Nothing else.
- Two new migrations, never an edit of an older one: `0045_sources` by `npx drizzle-kit generate --name sources` and
  `0046_net` by `npx drizzle-kit generate --custom --name net`, both from `apps/server`. In `0046_net.sql` each
  statement is its own chunk, the chunks separated by `--> statement-breakpoint` as in the generated files.
- Fail closed, toward a company that only reads: a fence function that cannot decide refuses; the keeper leads only
  with a lease it renewed and no fence problem; a write that fails at a fence reaches people as `read_only` or
  `not_confirmed` (503), never as "Something went wrong."
- The fence is the app's own for superusers (ruling 1): the app's pools say `hornhoof.fenced = on` when it runs with a
  keeper, the agent roles are fenced whatever they say, and nothing else in `apps/server/src` opens a pool or client.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  the same with its test file; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; the real tests from the worktree root: `npm run test:real`, which needs Docker. Types, always
  from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit` and, for the task that touches the web app,
  `npx tsc -p apps/web/tsconfig.json --noEmit`, both printing nothing. Never run prettier.


### Task 1: Real Postgres for the tests

**Repo:** Hornhoof worktree, branch `fences-and-journal`. **Starts from:** main with plan 2 merged. **Done when:** from
the worktree root `npm run test:real` passes with Docker running, and from `apps/server`
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/compose.test.ts` passes.

**Files:**
- Create: `apps/server/test/real/pg.ts`, `apps/server/test/real/postgres.test.ts`
- Modify: `apps/server/test/real/run.sh`, `CONTRIBUTING.md` (its `test:real` line names Postgres too)
- Test: `apps/server/test/real/postgres.test.ts`, `apps/server/test/compose.test.ts`

**Interfaces:**
- Produces, in `test/real/pg.ts`:
  ```ts
  export function realServer(): string;   // HH_REAL_PG; throws 'run with npm run test:real' when unset
  export async function realDatabase(): Promise<{ url: string; admin: pg.Client; drop(): Promise<void> }>;
  //   CREATE DATABASE hh_<12 random hex> on the container; admin: a connected superuser client on it;
  //   drop(): ends admin, DROP DATABASE ... WITH (FORCE), then DROP ROLE IF EXISTS of agentRole and readerRole of
  //   that database name. Each test file calls it in beforeAll and drop() in afterAll.
  ```
- `run.sh` also starts `postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1` (the
  image of compose's `db`) as `hornhoof-pg-$$`, with `-e POSTGRES_PASSWORD=<32 hex from /dev/urandom>`, `-p
  127.0.0.1::5432`, and after the image the command `-c wal_level=logical -c max_replication_slots=10 -c
  max_wal_senders=10 -c max_prepared_transactions=0`. It waits up to 60 s for `docker exec hornhoof-pg-$$ pg_isready
  -h 127.0.0.1 -U postgres` (over TCP, which the image's first-start server does not open), reads the port with
  `docker port hornhoof-pg-$$ 5432/tcp`, and runs vitest with `HH_REAL_PG=postgres://postgres:<password>@127.0.0.1:
  <port>/postgres` beside Pebble's variables. The `trap` removes this container too. When `HH_REAL_PG` is set
  already, run.sh starts no container and uses it.

- [ ] **Step 1: Write failing tests.**
  - `postgres.test.ts`, `runs Postgres 17.11 with the settings of the company's db`: `SHOW server_version` starts with
    `17.11`; `wal_level` is `logical`; `max_prepared_transactions` is `0`.
  - `postgres.test.ts`, `brings a fresh database up to this build`: `migrateDb(url)` answers the number of entries in
    `drizzle/meta/_journal.json`; a query on `openDb(url, APP_NAME)` works, and `pg_stat_activity` shows its session
    with `application_name` `hornhoof-app`.
  - `compose.test.ts`, `starts the real tests' Postgres as compose starts db`: `test/real/run.sh` contains the `image`
    of compose's `db` service and each `-c` setting of its `command`.
- [ ] **Step 2: Run** Done when. Expected: FAIL (`run with npm run test:real`; run.sh names no Postgres).
- [ ] **Step 3: Implement** `pg.ts` and the run.sh change. `realDatabase` connects with `pg.Client` from the server's
  own dependency.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run the real tests against the company's Postgres 17.11 too".


