You are the writer for Plan 1 Task 1 of Hornhoof's network build. Read everything below before you start.

# Build rulings (they override the plan)

1. One branch for everything. A plan's "Repo" line that names its own worktree or branch (relay-contract, backups, ...)
   means the Hornhoof worktree `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network` on branch `network`.
   "Starts from: main with plan N merged and shipped" and "Handed over" mean "plan N's tasks are complete on this branch".
   The relay repo is `/Users/0x/Projects/hornhoof-edge`, local only: no remote, no push.
2. Never deploy, ship or rehearse. Skip every step a plan marks as the team lead's or Ivan's: deploying the relay to the
   droplet, hornhoof.org, or any ssh; a rehearsal on a stand; `install.sh` against a real company; an Update; a
   `request.json` on a company; a merge into main; a push; anything on GitHub.
3. Code that a plan says depends on plan 1 being deployed is written and tested against the local relay the tests and
   the lab start. Never against the real one.
4. Private files the plan puts in `~/.hornhoof-edge/` stay there and never enter a repo. Never print a key, token,
   password or the content of `~/.hornhoof-edge/ssh_config`. Do not read `ssh_config`, any key file, or print the file
   `~/.hornhoof-edge/private-words` (tests may read it; never echo its lines).
5. Migration numbers: take the plan's numbers as written.

# How you work (writer)

- You write the code and tests for the ONE task below, test first: write the failing tests, run them and see them
  fail, then the code, then run the task's **Done when** and read its output.
- NEVER commit, never push, never run prettier, never run a formatter over files you did not change. `git add` to let
  `git ls-files` see new files is fine. The build lead commits after review. Where the task says "Commit", stop at that
  point's tests passing and go on with the next step instead.
- Change only the task's files. Never touch the droplet, GitHub, ssh, Docker containers you did not start, or another
  task's work. No `npm install`/`npm ci` unless the task names a dependency to add.
- No em dashes (U+2014) anywhere you write. In Russian write "е", never "ё".
- Shell is zsh with BSD tools on macOS (arm64); there is no `timeout` command. Wrap heavy runs in `nice -n 10`.
- Python for the relay: standard library only, runnable on Python 3.12 (the droplet's). Run the relay tests with both
  `python3` (3.14 here) and `/opt/homebrew/bin/python3.12`.
- Stop and report (do not guess) when a fact the task rests on proves wrong in the code, or a test of an earlier task
  fails and you cannot find why.
- At the end, print a short report: files changed, test commands run and their results, anything you could not do,
  and every place you deviated from the plan, with why.

# Notes for this task from the build lead

- The relay repo already exists: `/Users/0x/Projects/hornhoof-edge` was made with `git init -b main` (Step 1's mkdir and
  init are done). Do the rest of Step 1 (copy the files with `cp -p` from `~/.hornhoof-edge/droplet`, `.gitignore`, the
  grep check), then Steps 2 to 5 and 7 to 11. Steps 6 and 11's commits are the build lead's: do not commit.
- `~/.hornhoof-edge/private-words` already exists (the build lead wrote it; mode 600). Do NOT write, cat or print it.
  `test_private_words` reads it; when a line matches, its failure message names the tracked file and the line NUMBER
  of private-words that matched, never the value itself. If it fails, find the value by line number with a script
  that prints only the file and position in the tracked file, and take the value out of the tracked file.
- Step 12 is the build lead's: do not move, write or delete anything under `~/.hornhoof-edge/`. You only read
  `~/.hornhoof-edge/droplet/` (the files Step 1 copies). Never read `~/.hornhoof-edge/ssh_config` or any key file.
- Hornhoof's own files (LICENSE, README.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, `.github/`, 
  `apps/server/src/modules/link/client.ts`, `node_modules/@fontsource/onest/LICENSE`,
  `node_modules/@fontsource/tektur/LICENSE`) are read from `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network`
  (main as of 07928d7). `notes/ops/hornhoof-org.md` is at `/Users/0x/Projects/Hornhoof-archive/notes/ops/hornhoof-org.md`.
  Read only; change nothing in the Hornhoof repo.
- shellcheck is not installed here; skip it (CI runs it). Write the scripts so they would pass it.
- frp.sh downloads from GitHub releases; network is allowed for that and for reading the release's
  `frp_sha256_checksums.txt`.
- Leave every frps/frpc/echo process your tests start stopped when the tests end; do not leave background processes.

# The plan, from its top to the end of Review Focus

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


# The task

### Task 1: The public relay repository, and a real frps under test

**Repo:** relay repo, which this task creates at `/Users/0x/Projects/hornhoof-edge`, branch `main`. **Starts from:**
nothing: the folder does not exist yet. **Done when:** `sh relay/test/frp.sh && python3 -m unittest discover -s
relay/test -v` passes, and Step 12's `ls` shows what it says.

**Files (relay repo, `/Users/0x/Projects/hornhoof-edge`):**
- Copy from `~/.hornhoof-edge/droplet`, unchanged: `relay/` (`relay.py`, `frps.toml`, `frps.service`, `hornhoof-relay`,
  `hornhoof-relay.service`, `setup-relay.sh`, `404.html`, `410.html`), `Caddyfile`, `pages/` (`build.py`,
  `page.html`, `start.html`, `fonts/`), `www/index.html`. Nothing else from that folder: `setup.sh`,
  `cloud-init.yaml`, the `*.pub` keys, `sshd-*.conf`, `hornhoof-cert-install`, `company.caddy.example` and
  `unattended.conf` stay private (overview decision 1).
- Create: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `pages/fonts/OFL.txt`,
  `deploy.env.example`, `.gitignore` (`relay/test/.bin/`, `__pycache__/`, `*.pyc`, `deploy.env`),
  `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `.github/ISSUE_TEMPLATE/config.yml`, `.github/workflows/tests.yml`, `.github/workflows/sign-off.yml`
- Test: `relay/test/frp.sh`, `relay/test/harness.py`, `relay/test/test_public.py`, `relay/test/test_today.py`,
  `relay/test/test_frp_facts.py`
- Outside the repo: `~/.hornhoof-edge/private-words`, `~/.hornhoof-edge/deploy.env`,
  `~/.hornhoof-edge/droplet/README.txt`; the copied files leave `~/.hornhoof-edge/droplet` for
  `~/.hornhoof-edge/retired/droplet-2026-11-03/`.

What the new files say:
- `LICENSE`: Hornhoof's, byte for byte (MIT, "Copyright (c) 2026 Ivan Korol").
- `README.md`, for someone who has never run a server, in the plain voice of Hornhoof's README, under the headings
  `What it does`, `What it sees`, `What it never does`, `What it stores`, `Run the tests`, `What is where`, `License`.
  It does: give
  each Hornhoof company a link like `https://acme.hornhoof.org`, and carry the link's visitors through a tunnel that
  the company's own machine opens to it, so nothing opens on the company's router; hand out names; check each
  tunnel's key; pass each request to its company's tunnel. It never: runs a company's code; holds its data, files or
  passwords; keeps accounts; reaches through a tunnel to anything but the Hornhoof app; keeps a copy of what passes.
  What it sees, as it stands at this commit: a link's https ends at hornhoof.org, which reads each request to find its
  company, as Hornhoof's `SECURITY.md:53` says (Task 9 changes this). It stores, per link: the name, a hash of its
  key, when and from which address it was made, when its tunnel was last seen, whether it is blocked and why; per
  address, the times of its new links in the last hour (the rate limit). It logs each link made or freed with the address it came from, and frps logs each
  tunnel's login, both in the droplet's system journal. Tasks 2, 5 and 6 add what they store to this list. License:
  MIT; the two fonts OFL-1.1 (`pages/fonts/OFL.txt`). It agrees with Hornhoof's `SECURITY.md:45-55`.
- `CONTRIBUTING.md`: Hornhoof's, cut to this repository: fork, branch, a failing test first
  (`python3 -m unittest discover -s relay/test -v`), every commit signed off (`git commit -s`,
  https://developercertificate.org/), a maintainer reviews, squash merge; a change carries no private value (what
  `test_public.py` checks); a change to what the relay stores changes the README's list in the same pull request.
- `SECURITY.md`: in scope: `relay.py`, the frps and Caddy configs, the setup script, the pages; report privately
  through the repository's Security tab, "Report a vulnerability", as Hornhoof's does; what a good report holds, as
  Hornhoof's lists it; what the relay holds is the README's list.
- `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/`:
  Hornhoof's, with this project's name and `github.com/Invariant0x/hornhoof-edge` in its links; no idea form, no
  discussions link.
- `.github/workflows/tests.yml`: on `push` (every branch) and `pull_request`; `permissions: contents: read`;
  `runs-on: ubuntu-24.04` (Python 3.12, as the droplet); the checkout action pinned to the commit Hornhoof's
  `images.yml` pins; steps `sh relay/test/frp.sh`, `python3 -m unittest discover -s relay/test -v`,
  `shellcheck relay/setup-relay.sh relay/hornhoof-relay relay/test/frp.sh`.
- `.github/workflows/sign-off.yml`: Hornhoof's, unchanged.
- `pages/fonts/OFL.txt`: the OFL-1.1 text with both copyright lines, from `node_modules/@fontsource/onest/LICENSE`
  and `node_modules/@fontsource/tektur/LICENSE` in the Hornhoof checkout.
- `deploy.env.example`: `EDGE_SSH="ssh -F /path/to/ssh_config your-host-alias"` and `EDGE_DIR=/root/hornhoof-edge`,
  each under a comment; Task 13 reads the real values from `~/.hornhoof-edge/deploy.env`.
- `~/.hornhoof-edge/deploy.env` (private): `EDGE_SSH="ssh -F $HOME/.hornhoof-edge/ssh_config edge-admin"`,
  `EDGE_DIR=/root/hornhoof-edge`.
- `~/.hornhoof-edge/private-words` (private): one value per line that must never reach the repo: the droplet's IPv4
  and IPv6 addresses and its DigitalOcean name (from `notes/ops/hornhoof-org.md`), every `Host` and `HostName` value of
  `~/.hornhoof-edge/ssh_config`, Ivan's link name, the Mac's host name (`scutil --get LocalHostName`).
- `~/.hornhoof-edge/droplet/README.txt` (private): the relay, the Caddyfile and the pages now live in
  `/Users/0x/Projects/hornhoof-edge`; to set up a new droplet, copy this folder to `/root/hornhoof-edge`, then the
  repo's files over it (`git -C /Users/0x/Projects/hornhoof-edge archive HEAD relay Caddyfile pages www` piped into
  `tar -x -C /root/hornhoof-edge` over ssh), then run `setup.sh`, which finds every file where it did.

**Interfaces:**
- Produces, in `relay/test/test_public.py`, over the files `git ls-files` names (`.woff2` skipped):
  - `test_project_files`: `LICENSE` holds `Copyright (c) 2026 Ivan Korol`; `README.md` has the seven headings above;
    `CONTRIBUTING.md` holds `Signed-off-by`; `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/workflows/tests.yml` and
    `.github/workflows/sign-off.yml` exist.
  - `test_no_ip_address`: no IPv4 literal but `127.0.0.1`, `0.0.0.0` and the documentation ranges `192.0.2.0/24`,
    `198.51.100.0/24`, `203.0.113.0/24`.
  - `test_no_secret`: none of `PRIVATE KEY-----`, `BEGIN CERTIFICATE`, `ssh-ed25519 `, `ssh-rsa `, `ecdsa-sha2-`,
    `IdentityFile`, `HostName `.
  - `test_only_known_hosts`: every match of `\b(?:[a-z0-9-]+\.)+(?:org|com|net|io|dev|local|lan|internal|ru|br)\b`
    (no `sh`: `frp.sh` is a file) is `hornhoof.org`, ends in `.hornhoof.org`, or is in `ALLOWED_HOSTS = {'github.com',
    'www.github.com', 'developercertificate.org', 'scripts.sil.org', 'openfontlicense.org',
    'www.contributor-covenant.org', 'example.com'}`. A new host fails until a reviewer adds it there.
  - `test_private_words`: when `$EDGE_PRIVATE_WORDS` or `~/.hornhoof-edge/private-words` exists, none of its lines
    appears in any tracked file, ignoring case; without the file it prints `private-words: none here, skipped` (CI
    runs the other checks).
  - `test_english_no_em_dash`: no U+2014 and no Cyrillic letter in any tracked file.
- Produces, in `relay/test/harness.py`:
  - `class Stack` (context manager), `Stack(tmp: str, dashboard: bool = True)`: starts an HTTP echo server (every
    request answered `200 {"host": <Host>, "path": <path>}`), then relay.py and frps on free loopback ports. Env for
    relay.py: `RELAY_DB=<tmp>/relay.db`, `RELAY_PORT`, `RELAY_CADDYFILE=<tmp>/Caddyfile` (one line
    `@reserved host www.hornhoof.org`), `RELAY_TRACE=1`, and the ones later tasks read: `RELAY_FRPS_API`
    (`http://127.0.0.1:<dash>`, or a closed port when `dashboard=False`), `RELAY_FRPS_USER=admin`,
    `RELAY_FRPS_PASSWORD=<random>`, `RELAY_FRPS_BIND=127.0.0.1:<bind>`, `RELAY_FRPS_STARTED=<tmp>/frps-started`. frps
    runs a config rendered from `relay/frps.toml`: every key kept, `bindPort`, `vhostHTTPPort`, `webServer.port` and
    the plugin's `addr` replaced by test ports, `@WEB_PASSWORD@` by the password, `custom404Page` dropped. Each start of
    frps writes `int(time.time())` into `RELAY_FRPS_STARTED`, as systemd will (Task 4).
  - `Stack.bind(name: str | None = None) -> dict`: POST `/api/v1/bindings`, the answer.
  - `Stack.client(name: str, key: str | None, *, settings: str = 'today', client: str | None = None,
    proxies: str | None = None, visitor_key: str | None = None) -> Client`: writes an frpc config and starts frpc.
    `settings='today'` is Hornhoof's config (`client.ts:24-44`) with `transport.protocol = "websocket"` to the frps
    bind port and without the TLS line; `'network'` is the same with `transport.heartbeatInterval = -1`,
    `transport.tcpMuxKeepaliveInterval = 10` and no `heartbeatTimeout`. `client` writes `clientID` and
    `metadatas.client` with that value. `proxies` replaces the `[[proxies]]` block (and may hold `[[visitors]]`).
    `visitor_key` writes `metadatas.visitor`; `key=None` leaves out `metadatas.key`. An http proxy's local target is the
    echo server.
  - `Client.stop()`, `.kill()`, `.pause()` (SIGSTOP), `.resume()` (SIGCONT), `.log() -> str`,
    `.started(proxy: str, within: float = 15) -> bool` (waits for `start proxy success` naming it).
  - `Stack.get(host: str, path: str = '/') -> int`: status of a request to the vhost port with that Host.
  - `Stack.api(method: str, path: str, body: dict | None = None, key: str | None = None) -> tuple[int, dict | None]`.
  - `Stack.dash(path: str) -> tuple[int, object]`: a basic-auth GET on frps's dashboard.
  - `Stack.restart_relay()`, `.restart_frps()`, `.stop_frps()`, `.start_frps()`, `.plugin_calls() -> list[dict]`
    (the trace lines of Task 2, parsed).
- Produces, `relay/test/frp.sh`: downloads `frp_0.71.1_<os>_<arch>.tar.gz` for the host (`darwin` or `linux`, `amd64`
  or `arm64`) from `https://github.com/fatedier/frp/releases/download/v0.71.1/`, checks the sha256 written in the
  script, puts `frps` and `frpc` into `relay/test/.bin/`, and does nothing when both are there. Linux values from
  `notes/ops/hornhoof-org.md`: amd64 `1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803`, arm64
  `8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019`; the darwin values copied once from the release's
  `frp_sha256_checksums.txt`, with a comment naming that file. `harness.py` runs it once per test run.

- [ ] **Step 1: Start the repository.** `mkdir /Users/0x/Projects/hornhoof-edge && git -C /Users/0x/Projects/hornhoof-edge
  init -b main`; copy the listed files with `cp -p`, keeping their paths; write `.gitignore`. Then
  `grep -rIlE "PRIVATE KEY|ssh-ed25519|BEGIN CERTIFICATE" /Users/0x/Projects/hornhoof-edge; echo done` prints only
  `done`.
- [ ] **Step 2: Write `test_public.py`** and the private `~/.hornhoof-edge/private-words`.
- [ ] **Step 3: Run** `python3 -m unittest relay/test/test_public.py -v` (after `git add -A`, so `git ls-files` sees the
  files). Expected: FAIL in `test_project_files` only; `test_private_words` does not print `skipped`.
- [ ] **Step 4: Write the open-source files** listed above.
- [ ] **Step 5: Run** the same after `git add -A`. Expected: PASS. A failure in another check names a file and a
  value: take the value out (it belongs in `~/.hornhoof-edge/`) or, for a public site, add its host to
  `ALLOWED_HOSTS`.
- [ ] **Step 6: Commit** (`commit -s`) "Start hornhoof-edge: the relay, its pages, and what an open project needs".
- [ ] **Step 7: Write `test_today.py`, today's relay as it stands:** `test_binding_serves_its_name` (bind `acme`, a
  `today` client with the answer's key, `started('acme')`, then `get('acme.hornhoof.org') == 200`);
  `test_wrong_key_refused` (key `x`: never starts, log says `no binding acme with this key`);
  `test_second_copy_refused` (a second `today` client of `acme`: its proxy never starts while the first runs);
  `test_tcp_proxy_refused` (`type = "tcp"`: log says `only http proxies are allowed`).
- [ ] **Step 8: Run** `sh relay/test/frp.sh && python3 -m unittest relay/test/test_today.py -v`. Expected: PASS (it
  describes today's relay; a failure means the harness is wrong, not the relay).
- [ ] **Step 9: Write `test_frp_facts.py`, the frp 0.71.1 behavior this plan builds on:**
  - `test_fact_proxy_name_is_unique`: two `today` clients of `acme`: the second's log says `proxy [acme] already
    exists` while the first runs, and its proxy starts within 40 s after the first stops (frpc resends a refused
    `NewProxy` every 30 s, `client/proxy/proxy_wrapper.go:50`, `:209`); print the delay.
  - `test_fact_dashboard_shows_the_route`: `dash('/api/proxy/http/acme')` is 404 before any client; 200 with
    `status == 'online'` and `clientID == 'acme-3f2a9c1b-link'` while a client with that client id runs; `'offline'`
    with the same `clientID` after it stopped; for a client with no client id, `clientID` is a run id (16 hex
    characters or more). `GET <dash>/healthz` answers 200 with no password.
  - `test_fact_client_id_is_unique`: a `network` client `acme-3f2a9c1b-peer` with no proxies runs, then is paused; a
    second frpc with that client id logs `is already online` and gets in within 60 s after the first was dropped.
- [ ] **Step 10: Run** `python3 -m unittest relay/test/test_frp_facts.py -v`. Expected: PASS. If one fails, stop and
  write down a ruling before Task 2: the route design rests on these three.
- [ ] **Step 11: Run** `python3 -m unittest discover -s relay/test -v`, and `shellcheck` on the three scripts if it is
  installed (CI runs it in any case; fix what it flags in the copied scripts without changing what they do).
  Expected: PASS. Commit (`commit -s`) "Test the relay against a real frps 0.71.1".
- [ ] **Step 12: Leave one copy of each file.** Move the copied files out of `~/.hornhoof-edge/droplet` into
  `~/.hornhoof-edge/retired/droplet-2026-11-03/` (nothing is deleted), write `~/.hornhoof-edge/droplet/README.txt`
  and `~/.hornhoof-edge/deploy.env`. Check: `ls ~/.hornhoof-edge/droplet` lists `README.txt`, `setup.sh`,
  `cloud-init.yaml`, the two `.pub` keys, the two `sshd-*.conf`, `hornhoof-cert-install`, `company.caddy.example` and
  `unattended.conf`, and nothing else. The team lead pushes the repository to GitHub; the executor does not.
