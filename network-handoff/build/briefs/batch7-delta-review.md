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

- You read batch 7, slice delta, in `/home/altera/hornhoof-network/hornhoof-edge` on the branch batch-7, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch7-delta.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# A delta read

You raised the findings in `network-build/runs/batch7-relay-r2-agy.md`, given below as your report. The package is only the fix's commit. For the Part 2 Critical and each Minor the fix claims: say ADDRESSED or NOT ADDRESSED, and whether its test fails without the fix. Then read the fix itself for new breakage: lock order, a new deadlock, what one new connection now reads (Review Focus 5 wants no write and no scan), and a live tunnel across a key change (R6.1).

Then rule on the writer's open item, the line `Batch 7's fix: Ruling, left open` in the ledger: frps calls NewUserConn for neither http-mode nor its vhost, so an http route under a new binding is stopped only by R1.5. Say concretely who can reach this and what they would get, and whether it is still Critical. Say if a small change closes it. Nothing here runs against the real droplet or a live service.

# Your report

I have read [brief.md] in full. Next, I will inspect the workspace layout and read all skills in `../skills/` before reading the spec, ledger, diff, and repository files.
I have read the skills in `../skills/`, [spec.md], [ledger.md], [package.diff], [README.md], and [Caddyfile]. Next, I will read the full [relay.py] and remaining relay configuration and test files to examine callers, unchanged lines, and cross-repo seams.
I have read `CONTRIBUTING.md`, `relay/test/test_block_by_name.py`, `relay/setup-relay.sh`, `relay/hornhoof-relay`, and the seam lines in `relay/relay.py` and `../package.diff`. Next, I will run focused read-only checks one at a time (shell checks, non-Caddy unit tests in `test_block_by_name.py`, and an in-process reproduction of the candidate seam findings) without modifying any files.
### Summary

Second-pass read-only review of Batch 7 (`slice relay`) with the populated `hornhoof-edge` repository in `repo/`, Plan 1's top section in [brief.md], and Hornhoof's `relay.ts` and `fake-relay.ts` appended to [package.diff]:

- **Part 1 (Batch 7, Plan 1 Task 10):** **0 Critical, 0 Important, 3 Minor.** All three Part 1 Minors from the first report hold against the full repository; all eight Task 10 writer rulings in [ledger.md] hold.
- **Part 2 (Plan 1's End, cross-task and cross-repo seams):** **1 Critical, 2 Important, 1 Minor.** The first report's Part 2 missing-workspace finding is closed; reading the real seams uncovered a rebind/pending-route hijack across Tasks 2, 7, and 10 (`Critical`), a missing `sync` delete on unbind in `fake-relay.ts` (`Important`), and an incomplete `setup-relay.sh` that clobbers `edge` settings (`Important`).

**Skills and checks run:** Read [systematic-debugging.md], [test-driven-development.md], and [verification-before-completion.md]; checked Python 3.12 AST, `sh -n` on all 5 shell scripts, publication/privacy rules across all 48 repo files, cyclomatic complexity on [relay.py] (worst changed function CC is 9 in [`plugin_decide`]), the 19 non-Caddy unit tests in [test_block_by_name.py] (`OK`), and an in-process reproduction of both `relay.py` findings. Zero files were created or modified.

---

### Part 1: Batch 7 (Plan 1 Task 10, R7.4)

#### Critical
- None.

#### Important
- None.

#### Minor
- **[Part 1] Minor** `relay/relay.py:1825` ([`admin`], [`admin_ban`]): *Holds from first read (reproduced).* `admin` consumes `args[1]` as `name` before `admin_ban` strips `--cut`, so `hornhoof-relay ban --cut acme` exits `0`, bans `--cut` with reason `acme`, writes `@blocked host --cut.hornhoof.org` without printing `restart frps`, and leaves `acme` unbanned; strip `--cut` and validate `name` with `LABEL` before `store_ban`.
- **[Part 1] Minor** `relay/relay.py:1453-1456, 94-113` ([`RelayServer`], [`db`]): *Holds from first read.* Each short-lived `ThreadingHTTPServer` thread opened by a `NewUserConn` crowd stores a SQLite connection in `_local.conn` without closing it on thread exit (unlike `ClosingHandler` in [test_keys.py]); close `_local.conn` when a worker thread finishes.
- **[Part 1] Minor** `relay/hornhoof-relay:5` ([hornhoof-relay]): *Holds from first read.* Usage text says `ban` makes the relay `answer 410 at once`, whereas a live `https` or `stcp` proxy without `--cut` drops new connections in `frps` (`NewUserConn`) and reaches Caddy's `410` only for `http`-mode links or once the `https` tunnel disconnects; align wording with [README.md].

#### Task 10 Writer Rulings Check ([ledger.md])
- **Ruling 1 (`10 of 200` trace lines over `50 ms` allowed in [`test_new_user_conn_burst`] where the plan says `none`): Holds.** `test_new_user_conn_burst` runs four OS processes over loopback on shared cores where a single scheduler preemption stalls the 1-2 calls in flight, while [`NoWaitTests`] and [`WaitsNoTraceLineShowsTests`] pin every relay-side wait without a clock: one primary-key `SELECT` verified via `EXPLAIN QUERY PLAN`, zero dashboard reads, zero wait on a stalled `BEGIN IMMEDIATE` + `writer.taken` + `route_lock`, `TCP_NODELAY` on kept connections, `request_queue_size = 1024` holding 200 unaccepted sockets, and [`test_a_crowd_at_once_is_refused_nowhere`].
- **Rulings 2 through 8: Hold.** Confirmed against the full repo, including `edge` fail-closed handling ([`new_user_conn_reason`]), `<link>-<m8>-<service>` parsing via `CLIENT` ([`peer_service_link`]), visitor-free `TRACE` fields ([`trace_plugin`]), `admin` split, and [test_restart.py] calling `self.stack._start_relay()`.

---

### Part 2: Plan 1's End (Cross-Task & Cross-Repo Seams)

*First-report status:* The first report's `[Part 2] Important` (empty `repo/` and missing Plan 1 top / Hornhoof files) is closed by this workspace.

#### Critical

1. **[Part 2] Critical** `relay/relay.py:444-454, 868-884, 1408-1425, 1707-1725` ([`name_live`], [`requested_name_reason`], [`upsert_route`], [`link_refusal`], [`create_binding`])
   - **What is wrong (and how checked):** Across Tasks 2, 7, and 10, `name_live(name)` checks only `frps_route(name)[0] == 'online'` without taking `route_lock(name)` or checking `locked_route_of(name)['state'] == 'held'` (ignoring the 10 s `pending` window between `NewProxy` returning `reject: False` and `frps` exposing the proxy as `online` on its dashboard), `create_binding` checks and inserts under `create_lock` without `route_lock(name)`, and `upsert_route` (unlike `store_sync`, `release_binding`, `store_visitor_key`, and `store_link_key`) writes `pending` without verifying `EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ? AND banned_at IS NULL)`. Reproduced in-process against `load_relay_module()` + `RelayServer`: Company A binds `acme`, passes `plugin('NewProxy', ...)` for `https` (`{'reject': False, 'unchange': True}`), and calls `DELETE /api/v1/bindings/acme` (`204`) before `frps` flips `acme` to `online`; Company B gets `GET /api/v1/names/acme` -> `200 {'name': 'acme', 'free': True}` and `POST /api/v1/bindings` -> `201`; once `frps` marks Company A's `https` route `online`, `plugin('NewUserConn', ...)` returns `{'reject': False, 'unchange': True}` because `link_refusal` checks only whether `acme` has an unbanned `bindings` row (Company B's). Likewise, a `NewProxy` that passed [`authenticate_call`] just before `DELETE /bindings/acme` or `admin ban acme` still writes `pending` and returns `reject: False`.
   - **What a person would get:** Company B is handed `acme.hornhoof.org` (`201`), yet visitors opening `https://acme.hornhoof.org` are routed end-to-end (TLS passthrough) to Company A's machine, `GET /api/v1/links/acme/route` with Company B's key answers `200 {'state': 'held', 'client': 'acme-11111111-link'}` (Company A's machine), and Company B's own `frpc` is refused (`router config conflict: acme is held`), breaking R1.5 and R7.4.
   - **What would make it right:** Check `locked_route_of(name)['state'] == 'held'` under `with route_lock(name):` in `name_live` (and hold `route_lock(name)` across `requested_name_reason` + `store_new_binding` for a requested name in `create_binding`), and guard `upsert_route`'s `INSERT INTO routes` with `WHERE EXISTS (SELECT 1 FROM bindings WHERE name = ? AND key_hash = ? AND banned_at IS NULL)` (refusing `NewProxy` if `write(...) == 0`).

#### Important

1. **[Part 2] Important** `apps/server/test/fake-relay.ts:179-183` ([package.diff]) vs. `relay/relay.py:1183, 1199-1211` ([`BINDING_LIFETIME_TABLES`], [`release_binding`])
   - **What is wrong (and how checked):** Traced across `fake-relay.ts`, `relay.py`, [README.md], and [test_keys.py]. `DELETE /api/v1/bindings/:name` in `fake-relay.ts` deletes `relay.bindings` and `relay.visitorKeys` while keeping `relay.routes` (`generation`), but omits `relay.syncs.delete(req.params.name)` (Task 11 landed before Task 7 added `'sync'` to `BINDING_LIFETIME_TABLES`).
   - **What a person would get:** When a freed link name is rebound in Hornhoof tests, `fakeRelay` serves the prior owner's `sync` record (`state`, `copy`, `epoch`, `generation`, `at`) on `GET /api/v1/links/:name/route` instead of `NO_SYNC` and rejects the new owner's `POST /api/v1/links/:name/sync` with `409 stale_epoch` for epochs at or below the prior owner's, diverging from real `relay.py` in downstream keeper/rename tests.
   - **What would make it right:** Add `relay.syncs.delete(req.params.name);` in `app.delete('/api/v1/bindings/:name', ...)` at `apps/server/test/fake-relay.ts:180` ([package.diff]) and add a free-and-rebind assertion to the fake relay's R2.4 test.

2. **[Part 2] Important** `relay/setup-relay.sh:13-63` ([setup-relay.sh]) vs. [frps.toml], [edge-frpc.service], [edge-frpc.toml], and [relay.py]
   - **What is wrong (and how checked):** Traced across the setup and unit files on `batch-7` (noting Task 13 is held per [ledger.md]). `setup-relay.sh` installs the Task 9/10 `frps.toml` (`vhostHTTPSPort = 443`, `NewUserConn` enabled) without installing `/usr/local/bin/frpc`, `/etc/frp/edge-frpc.toml`, `/etc/hornhoof-relay/edge.env`, or `edge-frpc.service`, and lines 44-52 unconditionally overwrite `/etc/hornhoof-relay.env` without `RELAY_EDGE_TOKEN` or `RELAY_FRPS_HTTPS` (breaking line 3's `Safe to run again`).
   - **What a person would get:** Running or re-running `setup-relay.sh` restarts `hornhoof-relay` with empty `EDGE_TOKEN` and `RELAY_FRPS_HTTPS`: `relay.py` refuses `edge` on `Login`, `NewProxy`, and `NewUserConn` (cutting off `hornhoof.org`, `/api/v1/*`, `/~!frp`, and all `http`-mode companies on port 443) and reports `passthrough: false` on `GET /api/v1/health` (R4.1, R7.2, R7.5).
   - **What would make it right:** Have `setup-relay.sh` install `frpc`, `edge-frpc.toml`, `edge-frpc.service`, and `/etc/hornhoof-relay/edge.env` (preserving any existing `EDGE_TOKEN` as line 32 preserves `webServer.password`), and include `RELAY_EDGE_TOKEN` and `RELAY_FRPS_HTTPS=127.0.0.1:443` in `/etc/hornhoof-relay.env` (either now on `batch-7` or before running it in Task 13).

#### Minor
- **[Part 2] Minor** `apps/server/test/fake-relay.ts:51-54` ([package.diff]): Comment says `a copy only when the sync is on`, whereas `.refine(record => record.copy !== null || record.state === 'off')` (matching [`sync_copy`]) allows a non-null `copy` when `state === 'off'`; clarify the comment.

#### Seam Questions ([brief.md])
1. **Does a name's life hold across register, renew, block, free and the edge's routing?** Holds for steady-state routes, key rotation (`R6.1` retains `ping_keys` for live legacy `Ping` while `NewUserConn` checks `bindings` by name), visitor keys (`R6.2`), and `ban`/`unban`, **except** for the two seam gaps above: a `pending` or in-flight `NewProxy` across release/rebind (`[Part 2] Critical`) and `fake-relay.ts` retaining `sync` on unbind (`[Part 2] Important 1`).
2. **Does each answer Hornhoof reads match what the relay sends?** Yes. Every endpoint, status code (`200`, `201`, `204`, `400`, `401`, `403`, `404`, `409`, `429`, `503`), and JSON payload in `apps/server/src/modules/link/relay.ts` ([package.diff]) matches [relay.py] and fails closed (`known: false` on `route`, `stored: false, why: 'unknown'` on unverified `setSync`, `DOWN` on `health`, `ApiError` on `check`/`bind`/`unbind`/`changeKey`/`visitorKey`).
3. **Does what the droplet logs match what the README promises?** Yes. [relay.py] silences HTTP request logs, ignores `remote_addr` in `NewUserConn` and `TRACE`, and logs no keys; [frps.toml] sets `log.level = "error"`; [Caddyfile] configures no access logs and logs visitor addresses only on upstream `502` errors as [README.md] states.
4. **Is the edge's routing consistent with what frps is told?** Yes in [frps.toml], [edge-frpc.toml], and [Caddyfile] (`frps` routes live `https` company SNI directly on `:443` and forwards `hornhoof.org` and `*` via `edge` with PROXY v2 to Caddy on `127.0.0.1:8443`, where Caddy trusts `127.0.0.1/32`, forces `h1` and `strict_sni_host`, and closes `404`/`410` sockets), modulo `setup-relay.sh` not yet wiring `edge` (`[Part 2] Important 2`).

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



# Plan 1's top: the relay contract table, Review Focus

# Network Phase 1, Plan 1: The Relay Contract, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hornhoof.org keeps the promises the network's leader rule rests on (one route per name, who holds a name
and since which registration, a sync record only the holder sets, eviction within a measured bound, a health answer
tied to frps, stcp services per name, a key change), and stops being able to read company traffic: it routes each
connection by its TLS server name and passes the encrypted bytes to the company's machine. All of it is proven against
a real frps 0.71.1 and Caddy and mirrored by the fake relay Hornhoof's tests use; Hornhoof gains a relay client that
reads every answer fail-closed.

**Architecture:** relay.py stays one Python file on the standard library, the frps plugin and the link API in one
process. Whether a route is live comes only from frps's dashboard API (`/api/proxy/<type>/<name>`: `status` and
`clientID`), read on every route answer and sync post. The generation, the holder and `since` come from the relay's own
table, written when the plugin lets a registration through (`NewProxy`), under a lock per name, after it checked frps
holds no route for the name. The plugin does not use `CloseProxy`: frps sends it asynchronously, unordered against the
next `NewProxy` of the same run id, and not at all when frps dies (frp `server/control.go:678-679`). frps drops a
silent client through tcpMux keepalive instead of heartbeats. frps takes port 443 and routes by the TLS server name: a
company's `https` proxy gets the encrypted stream as it came, and everything else goes through the droplet's own frpc
(client `edge`) to Caddy, now on loopback, as today. The plugin answers frps's `NewUserConn` for every new connection
to an `https` or `stcp` proxy, which blocks a name at once without a restart. Hornhoof's `Relay` class gets `route`,
`setSync`, `health`, `changeKey` and `visitorKey`, which never take a bad answer for a good one; nothing in Hornhoof
calls them until plan 1b.

**Tech Stack:** Python 3.12 standard library (`http.server`, `sqlite3`, `ssl`, `unittest`), frps and frpc 0.71.1 and
Caddy 2.11 as real binaries under test, systemd units on the droplet; TypeScript, Fastify (fake relay), zod, vitest on
Hornhoof's side.

**Spec:** `notes/specs/2026-11-02-single-network-design.md`, 3.4 "The relay contract" (R1 to R5), 3.2 path 2, 3.4
"Without a public link", 3.10 (TLS ends at the company's machine), section 10 "A stolen machine" (the change-key
call), section 12 second bullet. Overview: `notes/plans/2026-11-03-network-phase-1-overview.md` (plan 1,
discrepancies 10 to 14 and 19 to 25, decisions 1, 3 and 4, "Our own TLS on the public link"). Relay today:
`~/.hornhoof-edge/droplet/relay/` and `notes/ops/hornhoof-org.md` (main checkout). Open-source model:
`notes/ops/going-public.md` and Hornhoof's own `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and
`.github/`. frp facts: tag v0.71.1 of `github.com/fatedier/frp`, paths below are in that tree.

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches the droplet, GitHub or another task, and stops and reports when a test of an earlier
task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**Two repositories.** "Relay repo" is `hornhoof-edge`, a new git repository at `/Users/0x/Projects/hornhoof-edge`
that Task 1 builds from the public part of `~/.hornhoof-edge/droplet` (overview decision 1). It goes public later, so
it is an open-source project from its first commit and holds nothing private. The team lead pushes it to GitHub; the
executor never does. `~/.hornhoof-edge/droplet` keeps the droplet's base setup and gives up the files the repo now
owns. "Hornhoof" is `/Users/0x/Projects/Hornhoof-archive`, worked on in a new worktree on branch `relay-contract`
from main.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  This plan adds no UI strings.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. In the relay repo every commit is also signed off
  (`commit -s`, the DCO line `Signed-off-by: Ivan Korol <invariant0x@icloud.com>`). Never commit `notes/`, `.claude/`,
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

## Rulings made while planning

- **Health stays at `/api/v1/health`** on hornhoof.org (overview discrepancy 10): `/api/health` on a company's host
  is the app's own route.
- **Client ids are frp's own `clientID`.** frps refuses a second login with a `clientID` that is online
  (`server/registry/registry.go:207-215`, `server/control.go:213`), which is R1's "second live login refused". The same
  value goes into `metadatas.client`, because `NewProxy` carries the login's metas but not its `client_id`
  (`pkg/plugin/server/types.go:40-44`). Ids: `<link>-<machine8>-link`, `<link>-<machine8>-peer`, and
  `<link>-<machine8>-visit` for a visitor-only client. A tunnel with no client id is a today's tunnel, client `legacy`.
- **A login with a live run id replaces that session in frps** (`server/service.go:819`, `server/control.go:167`),
  which the spec does not expect. That is how an frpc gets its own session back after a network blip, so the plugin
  keeps it, but only when the live session with that run id has the same client id (read from
  `/api/clients?runId=`).
- **Visitors need no link key.** Section 10 gives workers no link key, but every frpc logs in to frps and today's
  `Login` check wants the key. So each link gets a visitor key (R6.2): a login with it may only run stcp visitors and
  register nothing. The stcp secret opens a service; the visitor key keeps strangers off frps.
- **A registration the plugin let through and frps has not shown yet is `pending` and reads as held for 10 s**, so a
  second registration in that gap is refused by the plugin and the generation names the one frps took.
- **One route per name rests on the proxy name.** frps keys http routes by domain, location and `routeByHTTPUser`
  (`pkg/util/vhost/router.go:170-185`) and lets groups share one (`server/group/http.go:82-108`), but proxy names are
  unique across clients (`server/control.go:871-873`), and the plugin lets in only the proxy named after the binding.
  The plugin also refuses `locations`, `route_by_http_user` and `group`, as it refuses custom domains today.
- **relayStarted** is the latest of: relay.py's start, the time the relay's watcher saw frps answer again after a
  failure, and frps's last start, which systemd writes to `/run/frps/started` (`ExecStartPost`).
- **Blocking a name restarts nothing** (overview decision 3). frp 0.71.1 has no call that closes one proxy or one
  client, and the plugin's `Ping` check reaches only clients that send heartbeats (`client/control.go:243`). None is
  needed. For a name in http mode, Caddy answers 410 before frps (`import blocked.caddy` comes ahead of the frps
  handler in the Caddyfile), so its public traffic stops at once. For a name in https mode and for stcp services,
  frps asks the plugin about every new connection (`NewUserConn`, `server/proxy/proxy.go:268-285`) and the plugin
  refuses those of a blocked or freed name (Task 10). In both, the plugin refuses the name's next login and
  registration; a today's tunnel still goes at its next refused `Ping`; a tunnel on the network's settings lingers,
  carrying nothing new, until it reconnects and is refused. Connections already open stay until they close;
  `ban --cut` restarts frps when they must go too.
- **frps takes port 443; Caddy moves behind it** (overview, "Our own TLS on the public link", with the reasons against
  an SNI router in front). `vhostHTTPSPort = 443`, `proxyBindAddr = "0.0.0.0"`. The droplet's own frpc, client
  `edge`, registers one `https` proxy named `edge` with `customDomains = ["hornhoof.org", "*"]` that points at Caddy on
  `127.0.0.1:8443` and sends a PROXY v2 header; frps refuses `*.hornhoof.org` as a custom domain under its
  `subDomainHost` (`pkg/config/v1/validation/proxy.go:81-90`), and `*` is its catch-all
  (`pkg/util/vhost/router.go:153-154`). Tunnels keep coming in as wss through Caddy to frps's loopback bind port, so
  today's frpc settings stay valid. The plugin lets `edge` in only with the 32-byte token in
  `/etc/hornhoof-relay/edge.env`: every tunnel reaches frps from Caddy on loopback, so an address proves nothing.
- **A company's `https` proxy looks like its `http` one**: named after the binding, `subdomain` equal to the name, no
  custom domain, no group, no locations. The `routes` row keeps its type (Task 2), and a name holds one route of
  either type, since proxy names are unique across types (`server/control.go:871-873`).
- **A freed name waits for its old tunnel** (overview decision 3). Releasing changes nothing live: Hornhoof stops its
  own tunnel when it renames (`apps/server/src/modules/link/link.ts:74-89`). Until frps shows the old route gone,
  `GET /names/<name>` says `taken` and `POST /bindings` with that name answers 409 `taken`, so no new company is
  handed a name another machine still serves; while frps cannot tell, both answer 503 `unknown`, which Hornhoof's
  `check` and `bind` already read as `relay_unreachable`. A random name skips the check: a fresh 24-character name has
  no old route, and `check_name` runs in the loop that picks one.
- **Quiet means the kernel's bytes, not frps's.** frps adds a connection's bytes to its counters only when the
  connection closes (`server/proxy/http.go:151-157`, `server/proxy/proxy.go:318-323`), so a live event stream or copy
  shows nothing there. `ss -tin` gives `bytes_sent` and `bytes_received` for every open TCP connection; the deploy waits
  for a minute in which none on port 443 moved more than 64 KiB.
- **No separate contract document.** The contract is the table below; both test suites name each test by its row id.

## The contract

Base `https://hornhoof.org/api/v1`. "Key" is the link's key, `Authorization: Bearer <key>`. Times are Unix seconds.

| Row | Promise | Relay test | Fake test |
|---|---|---|---|
| R1.1 | A registration of a name with a live or pending route, of either type (`http`, `https`), is refused, from any client, and moves no generation. | Tasks 2, 9 | Task 11 |
| R1.2 | A registration in a load-balancer group, or with `locations` or `route_by_http_user`, is refused. | Task 2 | none (the fake has no groups) |
| R1.3 | A second live login with one client id is refused; a live session is taken over only with its own run id and client id. | Task 6 | Task 11 |
| R1.4 | Two companies on one machine (same machine8, two link names) log in side by side. | Task 6 | Task 11 |
| R1.5 | A name with no binding whose old route is still live is not bound again: `GET /names/<name>` says `taken`, `POST /bindings` answers 409 `taken`; both 503 while the relay cannot tell. | Task 7 | Task 11 |
| R2.1 | `GET /links/<name>/route` with the key answers `{state: "held" \| "empty", client, since, generation, relayStarted, evictionBound, sync}`; `client` names the maker of registration `generation`. | Task 2 | Task 11 |
| R2.2 | The generation grows by one with every registration let through and survives relay.py and frps restarts. | Task 4 | Task 11 |
| R2.3 | 401 wrong key, 404 unknown name, 503 while the relay cannot tell; never an "empty" it is not sure of. | Tasks 2, 4 | Task 11 |
| R2.4 | `POST /links/<name>/sync {client, generation, state: "on" \| "off", copy, epoch}` with the key is taken only from the client holding the route in that generation, only with a higher epoch, on disk before the answer, kept across restarts; a missing record reads `{state: "off", copy: null, epoch: 0, generation: 0, at: null}`. | Task 5 | Task 11 |
| R3.1 | A silent client's route goes within `evictionBound` (30 s); the measured time is printed. | Task 3 | Task 11 (`drop`) |
| R3.2 | A live but idle client keeps its route, on today's settings and on the network's. | Task 3 | none |
| R4.1 | `GET /health` answers 200 `{ok: true, frps: true, relayStarted, passthrough}` only while frps accepts logins, else 503 `{ok: false, frps: false}`; `passthrough` is `true` while frps's https port accepts connections (Task 9; `false` before). | Tasks 4, 9 | Task 11 |
| R5.1 | A `-peer` client may offer stcp services `<link>-<machine8>-data` and `<link>-<machine8>-app` and nothing else; a visitor with the link's visitor key reaches them with the right secret only, and registers nothing. | Task 6 | Task 11 |
| R6.1 | `POST /links/<name>/key` with the key answers `{key}`, a new one; the old key is refused at once by the API and at login; live tunnels stay. | Task 7 | Task 11 |
| R6.2 | `POST /links/<name>/visitor-key` with the key answers `{visitorKey}`, replacing the one before. | Task 6 | Task 11 |
| R7.1 | A TLS connection for `<name>.hornhoof.org` reaches the name's `https` proxy with its bytes as they came: the client sees the company's own certificate, and the relay never holds a key for it. | Task 9 | none (the fake has no TLS) |
| R7.2 | Every other connection on 443 (hornhoof.org, www, reserved, blocked, unknown and http-mode names, no server name) reaches Caddy through `edge`, as today: the stub, the API, the tunnels' wss, 404, 410, http-mode companies. | Tasks 8, 9 | none |
| R7.3 | The visitor's address reaches the company (a PROXY v2 header from its frpc) and Caddy (`X-Forwarded-For` to http-mode companies and relay.py). | Task 9 | none |
| R7.4 | A new connection to a blocked or freed `https` name, or to a blocked name's stcp services, is refused at once, with no restart; one already open stays. | Task 10 | none |
| R7.5 | Only `edge`, with its token, may register `hornhoof.org` or `*`; any other custom domain is refused. | Task 9 | none |

## Review Focus

1. relay.py restarts (a deploy) while tunnels are live: during the restart readers get no answer (unknown); after it
   the route is held with the same generation, and no tunnel dropped. Test in Task 4.
2. Two machines of one company register the name within the same second: exactly one holds it, `client` names it,
   the generation moved once, and a sync post from the other is refused. Tests in Tasks 2 and 5.
3. A burst of plugin calls (frps restarts with many tunnels): no SQLite "database is locked" becomes a refused login
   or a lost generation, and no plugin call takes over 1 s. Test in Task 4 (40 clients at once).
4. A today's tunnel after the deploy: still served, idle for minutes without being dropped, still cut when its
   binding is blocked. Tests in Tasks 3 and 7.
5. A crowd opens a passthrough company at once (a page with 50 files, 20 visitors): frps asks the plugin about every
   new connection, so none may be refused and none may wait over 50 ms on relay.py. Test in Task 10 (200 connections
   in 2 s).

---

