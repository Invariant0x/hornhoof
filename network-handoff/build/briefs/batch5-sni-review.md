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

- You read batch 5, slice sni, in `/home/altera/hornhoof-network/hornhoof-edge` on the branch batch-5, read only. The package is `/home/altera/hornhoof-network/network-build/runs/batch5-sni.diff`. Each task's author check and tests already ran; do not rerun them, run a focused test only to settle a doubt.
- Shared contracts to keep in view: `packages/protocol`, `apps/server/src/db/schema.ts`, the relay contract table in plan 1, and `/home/altera/hornhoof-network/network-build/parallel-map.md` section 3, the seams.
- There is one fix round after this, so report what matters: Critical and Important as the how-to defines them, and Minors in at most a line each. A missing test counts only with a named harm to a person.
- Writers' reports, claims to verify and not to trust, are in `/home/altera/hornhoof-network/network-build/runs/`.

# Your slice: frps takes port 443 and routes by TLS name (1 T9). Relay routing, security class, two readers at once

The writer's rulings are in `network-build/progress.md`, "Plan 1 Task 9": judge them: frps's log level at the droplet, the Caddyfile's explicit http site, IPv4 only on 443, the edge's NewProxy rules. Look hardest at: a company's traffic reaching the wrong name; a stranger registering a catch-all or `hornhoof.org`; the edge token; anything the relay could read or log of a company's TLS; today's http-mode tunnels still working unchanged. The lead merged this with the relay write fix: in plugin_decide, touch stays ahead of a NewProxy, and the echo's port is picked before it binds. Nothing here sends traffic beyond loopback.

# The tasks

## 2026-11-03-network-phase-1-plan-1-relay-contract, Task 9

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


### Task 9: Names by their TLS server name (R1.1, R4.1, R7.1, R7.2, R7.3, R7.5)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 8 committed. **Done when:**
`python3 -m unittest discover -s relay/test -v` passes, Task 8's tests unchanged among them.

**Files (relay repo):**
- Modify: `relay/frps.toml` (`vhostHTTPSPort = 443`, `proxyBindAddr = "0.0.0.0"`, the comment: frps takes 443 and routes
  by the TLS server name, 8080 now listens on every address and both firewalls keep it closed); `Caddyfile` (https
  only on `127.0.0.1:8443`, taking a PROXY v2 header from `127.0.0.1/32` only; http on port 80 on every address,
  redirecting to https and answering HTTP-01; `X-Robots-Tag: noindex, nofollow` on every answer of `*.hornhoof.org`,
  none on hornhoof.org; the header comment: names in http mode stay out of CT logs, names in https mode hold their own
  certificates); `relay/relay.py`; `relay/frps.service` (`AmbientCapabilities=CAP_NET_BIND_SERVICE`,
  `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`); `README.md` (`What it sees`); `relay/test/harness.py`
- Create: `relay/edge-frpc.toml`, `relay/edge-frpc.service`, `relay/test/test_sni.py`

**Interfaces:**
- Consumes: the per-name lock, `routes` and `frps_route` (Task 2), the watcher (Task 4), `Stack` with Caddy (Task 8).
- Produces:
  - `relay/edge-frpc.toml`: `serverAddr = "127.0.0.1"`, `serverPort = 7000`, `loginFailExit = false`,
    `transport.protocol = "tcp"`, `transport.heartbeatInterval = -1`, `transport.tcpMuxKeepaliveInterval = 10`,
    `clientID = "edge"`, `metadatas.edge = "{{ .Envs.EDGE_TOKEN }}"`; one proxy: `name = "edge"`, `type = "https"`,
    `customDomains = ["hornhoof.org", "*"]`, `localIP = "127.0.0.1"`, `localPort = 8443`,
    `transport.proxyProtocolVersion = "v2"`.
  - `relay/edge-frpc.service`: `/usr/local/bin/frpc -c /etc/frp/edge-frpc.toml` as user `frps`,
    `EnvironmentFile=/etc/hornhoof-relay/edge.env`, `After=frps.service`, `Restart=always`, `RestartSec=1`.
  - relay.py, env `RELAY_EDGE_TOKEN` and `RELAY_FRPS_HTTPS` (`host:port` of frps's https port).
  - `Login` with `metas.edge`: allowed only when it equals `RELAY_EDGE_TOKEN` (`hmac.compare_digest`) and `client_id
    == 'edge'`, else `edge login refused`; such a session skips the binding checks. A `metas.edge` with no
    `RELAY_EDGE_TOKEN` set is refused.
  - `NewProxy` from the `edge` session: only `proxy_name == 'edge'`, `proxy_type == 'https'`, `custom_domains ==
    ['hornhoof.org', '*']`; no `routes` row. From any other session a non-empty `custom_domains` stays refused, and
    `proxy_type == 'https'` follows Task 2's `http` rules (named after the binding, `subdomain` equal to the name, no
    `group`), under the same lock, with a row of `type = 'https'`. Task 6's rule for a `link` or `legacy` session
    becomes: the `http` or the `https` proxy named after the binding, and nothing else.
  - `GET /api/v1/health` adds `passthrough`: `true` while the watcher's TCP connect to `RELAY_FRPS_HTTPS` succeeds
    within 1 s, `false` when it fails or the variable is unset.
  - `Stack(tmp, caddy=True)` now puts frps's https port on the public https port, starts the edge frpc with
    `relay/edge-frpc.toml` rendered (ports and token), and moves Caddy's https to its own loopback port in place of
    `127.0.0.1:8443`. `Stack.client(..., proxy_type: str = 'http')`: `'https'` gives the proxy `type = "https"`,
    `subdomain = <name>`, `transport.proxyProtocolVersion = "v2"`, and a target that is a TLS echo with its own
    self-signed certificate for `<name>.hornhoof.org`, which reads a PROXY v2 header first (400 without one) and
    answers `{"host", "path", "from": "<address>:<port>"}`.
  - README `What it sees`, plainly: for a company whose link uses https, hornhoof.org sees only encrypted bytes, the
    name being reached and the visitor's address, which it does not keep; a company on an older Hornhoof is served the
    old way until it updates, with its https ending at hornhoof.org.

- [ ] **Step 1: Write failing tests** in `test_sni.py`, on `Stack(tmp, caddy=True)`:
  - `test_r7_1_passthrough`: bind `acme`; a `network` client `acme-aaaaaaaa-link` with `proxy_type='https'`;
    `https('acme.hornhoof.org', '/x')` is 200, `cert_names == ['acme.hornhoof.org']` (the echo's own certificate,
    not the test CA's), body `path == '/x'`; the route reads `held`, generation 1, and its row has `type = 'https'`.
  - `test_r7_3_visitor_address`: the passthrough echo's `from` is `127.0.0.1:<local_port>`; for an http-mode `today`
    client `via='caddy'`, `X-Test-Peer` ends with `:<local_port>` and `xff` is `127.0.0.1` (the PROXY header reached
    Caddy through `edge`).
  - `test_r7_2_no_server_name`: `https('acme.hornhoof.org', sni=None)` never answers from the company: `status` is
    `None` or `cert_names` holds no `acme.hornhoof.org`.
  - `test_tunnels_through_the_edge`: a `today` client `via='caddy'` holds `initech` (wss to frps's 443, `edge`, Caddy,
    frps's bind port) and `https('initech.hornhoof.org')` is 200.
  - `test_r1_1_one_route_across_types`: `acme` held by an `http` client: an `https` client of `acme` with another
    client id never starts its proxy and the generation stays 1; the same the other way round on `globex`.
  - `test_r7_5_edge_only`: a `network` client with `customDomains = ["globex.example.com"]` is refused; a client with
    `metadatas.edge` set to a wrong token is refused at login (`edge login refused`); the right token with `clientID`
    `edge2` is refused; a `NewProxy` posted straight to `/frp/handler` with the edge session's metas and
    `custom_domains: ["*.example.com"]` gets `reject: true`.
  - `test_https_rules`: an `https` proxy named other than the binding, one whose `subdomain` differs from the name, and
    one in a group: refused with Task 2's messages.
  - `test_r4_1_passthrough_in_health`: health has `passthrough: true`; after `stop_frps()` it is 503; a stack started
    without `RELAY_FRPS_HTTPS` says `passthrough: false`.
  - `test_noindex`: `https('nobody.hornhoof.org')` and, after a ban, the 410 page carry `X-Robots-Tag: noindex,
    nofollow`; `https('hornhoof.org')` has no `X-Robots-Tag`.
  - `test_caddy_https_on_loopback_only` (Linux only, `skipUnless(sys.platform == 'linux')`): `ss -ltnH` shows Caddy's
    https port bound on `127.0.0.1` only, and its http port on every address.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_sni.py -v`. Expected: FAIL (frps has no https port, the
  plugin refuses `https` proxies).
- [ ] **Step 3: Implement** the interfaces and the unit files.
- [ ] **Step 4: Run Done when.** Expected: PASS, `test_edge_today.py` included, now through frps and `edge`.
- [ ] **Step 5: Commit** (`commit -s`) "Route each connection by its TLS server name and pass company traffic through
  unread".


