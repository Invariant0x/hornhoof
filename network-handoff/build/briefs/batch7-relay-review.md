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

- You read batch 7, slice relay, in `/home/altera/hornhoof-network/hornhoof-edge` on the branch batch-7, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch7-relay.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# This review has two parts

Security class: two readers at once, each alone.

**Part 1. Batch 7:** Plan 1 Task 10, the last relay task. The package holds it. Read Review Focus 5 yourself, and check the writer's rulings, the lines starting `Plan 1 Task 10: Ruling` in `/home/altera/hornhoof-network/network-build/progress.md`; a ruling is a claim to check. One of them allows 10 of 200 trace lines over 50 ms where the plan says none; say whether the reasoning holds.

**Part 2. Plan 1's end:** this is also the plan-end read. The plan's tasks landed in separate batches, and each was reviewed alone. Read only how they meet, not each task again: the relay as it stands on the branch `batch-7` (`relay/`, `README.md`) and the Hornhoof side, Tasks 11 and 12 (`apps/server/src/modules/link/relay.ts` and its fake in `/home/altera/hornhoof-network/hornhoof`), against the plan's relay contract table. Questions worth asking: does a name's life hold across register, renew, block, free and the edge's routing; does each answer Hornhoof reads match what the relay sends; does what the droplet logs match what the README promises; is the edge's routing consistent with what frps is told.

Report the two parts in one file, each finding marked with its part. Everything runs on loopback with local binaries. Nothing here goes to the real droplet, hornhoof.org or a real company.

# The tasks

## 2026-11-03-network-phase-1-plan-1-relay-contract, Task 10

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


### Task 10: Blocking by name, per connection (R7.4)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 9 committed. **Done when:**
`python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/frps.toml` (plugin ops add `"NewUserConn"`); `relay/relay.py` (the `NewUserConn` op; `admin ban <name>
  [reason] [--cut]`); `relay/hornhoof-relay` (`ban ... --cut` runs `systemctl restart frps` when relay.py's last line
  is `restart frps`; the help text says a ban refuses new connections at once and `--cut` also drops open ones, with
  every link)
- Test: `relay/test/test_block_by_name.py`

**Interfaces:**
- Consumes: bindings and bans (today's relay.py, Task 7), `CLIENT` (Task 6), `Stack` with passthrough (Task 9).
- Produces:
  - `NewUserConn`, content `{user: {user, metas, run_id}, proxy_name, proxy_type, remote_addr}` (frp
    `pkg/plugin/server/types.go:66-71`; `user` is the proxy owner's). Allowed when `proxy_name == 'edge'` and
    `user.metas.edge` matches `RELAY_EDGE_TOKEN`. Otherwise the link is `proxy_name` for `https`, the `link` group of
    `CLIENT` applied to the name without its last `-data` or `-app` for `stcp`; allowed only when that link's binding
    exists and is not banned, else rejected with `blocked` or `freed`; anything else rejected. One indexed `SELECT` on
    `bindings`, no dashboard call. The trace line carries `op`, `proxy_name`, `ms` and `reject`, never `remote_addr`.
  - `admin ban <name> [reason] [--cut]`: Task 7's ban; with `--cut`, `restart frps` as its last line.
  - `Stack.stop_relay()`, `Stack.start_relay()`.

- [ ] **Step 1: Write failing tests** in `test_block_by_name.py`, on `Stack(tmp, caddy=True)`:
  - `test_r7_4_blocked_https_name`: an `https` client holds `acme`; `https('acme.hornhoof.org', keep=True)` is 200;
    `admin ban acme`; a new `https('acme.hornhoof.org')` has `status None` within 1 s; the kept connection's
    `.again('/y')` is still 200; `RELAY_FRPS_STARTED` is unchanged.
  - `test_r7_4_freed_https_name`: `DELETE /bindings/acme` with the key: a new connection fails at once.
  - `test_r7_4_blocked_peers`: Task 6's peer setup on `acme` and on `globex`; after `admin ban acme` a new visitor
    connection to `acme-3f2a9c1b-app` closes with no answer, and `globex`'s service still answers.
  - `test_edge_never_refused`: after banning `acme`, `https('hornhoof.org')` is 200 and `https('nobody.hornhoof.org')`
    is 404.
  - `test_new_user_conn_burst`: 200 connections to `acme` within 2 s, one request each: all 200; every `NewUserConn`
    trace line under 50 ms; no trace line has a `remote_addr` key or the string `127.0.0.1`.
  - `test_new_user_conn_relay_down`: `stop_relay()`: a new connection to `acme` fails; `start_relay()`: it answers
    again within 3 s (the cost this design takes, pinned).
  - `test_ban_cut_prints_restart`: `admin ban acme --cut` ends with the line `restart frps`; `admin ban globex` does
    not.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_block_by_name.py -v`. Expected: FAIL (the new connection
  after the ban is served).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** (`commit -s`) "Refuse new connections to a blocked or freed name at once, without a restart".


