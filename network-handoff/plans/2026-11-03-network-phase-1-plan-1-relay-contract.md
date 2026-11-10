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

### Task 2: Who holds a name (R1.1, R1.2, R2.1, R2.3)

**Repo:** relay repo, branch `main`. **Starts from:** Task 1 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py`; `README.md` (What it stores: which client holds each link's route, with its run id, since
  when and in which registration)
- Test: `relay/test/test_route.py`

**Interfaces:**
- Produces, in `relay.py`:
  - Table `routes(name TEXT PRIMARY KEY, generation INTEGER NOT NULL, client TEXT NOT NULL, run_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('http', 'https')), state TEXT NOT NULL CHECK (state IN ('pending', 'held',
    'empty')), since INTEGER NOT NULL)`, made by `init_db`. Task 9 starts letting `https` rows in.
  - `class FrpsUnknown(Exception)`.
  - `frps_route(name: str) -> tuple[str, str | None, str | None]`: `('online' | 'offline' | 'absent', clientID, type)`
    from `GET {RELAY_FRPS_API}/api/proxy/http/<name>` and then `/api/proxy/https/<name>`, basic auth, 0.5 s timeout
    each: the one that is not 404 gives status, `clientID` and its type; both 404 is `('absent', None, None)`; both
    found, any other status, error, timeout or body without a `status` of `online` or `offline` raises
    `FrpsUnknown`.
  - `route_of(name: str) -> dict`, the R2.1 body (`sync` from Task 5 on): from the row and `frps_route`. `online`
    turns a `pending` row `held`; `offline` or `absent` turns a `held` row `empty` with `since = now`, and a `pending`
    row older than `PENDING_S = 10` too; a younger `pending` row reads `held`. An `online` route whose frps `clientID`
    is not the row's (the row's `client`, or for `legacy` its `run_id`), or an `online` route with no row, raises
    `FrpsUnknown` and logs the name. A name with no row reads `{state: 'empty', client: None, since: <binding's
    created_at>, generation: 0}`. `relayStarted` is the process start until Task 4; `evictionBound` is
    `EVICTION_BOUND_S = 30`.
  - `NewProxy` for `proxy_type == 'http'`, after today's checks, refuses `locations`, `route_by_http_user` and `group`
    when non-empty (`<field> is not allowed`); then, under a `threading.Lock` per name: refuses `router config
    conflict: <name> is held` when `route_of(name)['state'] == 'held'`, refuses `relay error: frps does not answer` on
    `FrpsUnknown`, else upserts the row (`generation + 1`, `client = user.metas.client or 'legacy'`, `run_id =
    user.run_id`, `type = proxy_type`, `state = 'pending'`, `since = now`), commits, and only then lets it through.
  - `GET /api/v1/links/<name>/route`: 404 `not_found` for no binding; 401 `unauthorized` for a wrong key, counted in
    `bad_keys` as `DELETE` does (429 after 30); 503 `{error: 'unknown'}` on `FrpsUnknown`; else 200 `route_of(name)`.
  - With `RELAY_TRACE=1`, each plugin call prints one JSON line `{"op", "proxy_name", "run_id", "client", "ms",
    "reject"}`, with no key or metas besides `client`.

- [ ] **Step 1: Write failing tests** in `test_route.py`:
  - `test_r2_1_held_then_empty`: bind `acme`; before any client the route is `state 'empty'`, `generation 0`; a
    `today` client starts: `held`, `client 'legacy'`, `generation 1`; after `stop()`, `empty` within 5 s, `generation
    1`, `since` at or after the stop.
  - `test_r1_1_second_registration_refused`: a `network` client `acme-aaaaaaaa-link` holds `acme`; a second one,
    `acme-bbbbbbbb-link`, is refused with `router config conflict` in its log; the route still names the first;
    `generation 1`; the trace shows the second `NewProxy` rejected.
  - `test_r1_1_racing_registrations`: 10 clients of `acme` with 10 client ids started at once: one runs, the route
    names that one, and `generation` equals the number of `NewProxy` calls the trace shows let through.
  - `test_r1_2_shared_routes_refused`: `loadBalancer.group = "g"` (with `groupKey`), `locations = ["/x"]`, and
    `routeByHTTPUser = "u"` are each refused with `<field> is not allowed`.
  - `test_r2_3_errors_are_not_empty`: wrong key 401; unknown name 404; with `dashboard=False` the route answers 503
    and a new client is refused with `relay error: frps does not answer`.
  - `test_plugin_calls_stay_short`: every `NewProxy` in the trace of the tests above took under 1000 ms.
  - `test_r2_1_route_body_has_no_key`: the route body as text holds neither the key nor the word `key`.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_route.py -v`. Expected: FAIL (404 on the route path).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS, today's tests included.
- [ ] **Step 5: Commit** "Tell a link's holder who holds its name and since which registration".

### Task 3: A silent client goes, an idle one stays (R3.1, R3.2)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 and 2 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/frps.toml`: `transport.tcpMuxKeepaliveInterval = 10` and `transport.heartbeatTimeout = -1`, the
  comment rewritten: a client that goes silent is dropped by the tcpMux keepalive within 30 s; heartbeats, where a
  client still sends them, are checked by the plugin as before.
- Test: `relay/test/test_eviction.py`

**Interfaces:**
- Consumes: `route_of` (Task 2), `Client.pause()` (Task 1).
- Produces: `EVICTION_BOUND_S = 30`, now measured. frps drops a control whose yamux ping got no answer: 10 s to send
  and 10 s to reply after each keepalive interval (yamux v0.2.0 `session.go:351`, `:396`).

- [ ] **Step 1: Write failing tests** in `test_eviction.py`:
  - `test_r3_1_silent_network_client_goes`: a `network` client holds `acme`; `pause()`; route polled each 0.5 s:
    `empty` within `EVICTION_BOUND_S`; print `eviction took <s> s`.
  - `test_r3_1_silent_today_client_goes`: the same with a `today` client.
  - `test_r3_2_idle_clients_stay`: one `today` and one `network` client, each on its own binding, idle 150 s: both
    `held`, same generation, and `get` answers 200 for both at the end.
  - `test_r3_1_back_after_eviction`: after the paused client was dropped, `resume()`: it holds the route again within
    60 s and the generation grew by one.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_eviction.py -v`. Expected: FAIL: with `heartbeatTimeout =
  90` frps drops the idle `network` client at about 90 s, since only a `Ping` refreshes that timer
  (`server/control.go:640`, `:791`), and with keepalive 30 a paused client can last up to 50 s.
- [ ] **Step 3: Implement** the frps.toml change.
- [ ] **Step 4: Run** the same. Expected: PASS with the times printed; put them in a comment beside
  `EVICTION_BOUND_S`. If a measured time is over 25 s, raise the bound to the next multiple of 5 above it plus 5, and
  note it for plan 10 (3.10's 60 s total grows by the same).
- [ ] **Step 5: Commit** "Drop a silent tunnel within 30 s and keep an idle one".

### Task 4: Health, restarts and generations that last (R2.2, R2.3, R4.1)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 3 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py` (frps watcher, `relayStarted`, health, the write helper);
  `relay/frps.service` (`RuntimeDirectory=frps`, `RuntimeDirectoryMode=0755`,
  `ExecStartPost=/bin/sh -c 'date +%%s > /run/frps/started'`); `relay/hornhoof-relay.service`
  (`EnvironmentFile=/etc/hornhoof-relay.env`); `relay/setup-relay.sh` (writes `/etc/hornhoof-relay.env`, mode 0640
  `root:hornhoof-relay`, with `RELAY_FRPS_API=http://127.0.0.1:7500`, `RELAY_FRPS_USER=admin`,
  `RELAY_FRPS_PASSWORD=<the password it reads or makes today>`, `RELAY_FRPS_BIND=127.0.0.1:7000`,
  `RELAY_FRPS_STARTED=/run/frps/started`)
- Test: `relay/test/test_restart.py`

**Interfaces:**
- Produces, in `relay.py`:
  - A daemon thread `watch_frps()`: every 0.5 s, a TCP connect to `RELAY_FRPS_BIND` and `GET <api>/healthz`, 1 s
    timeout each; keeps `frps_ok_at` (last success) and `frps_back_at` (first success after a failure, or after start).
  - `relay_started() -> int`: the largest of the process start, `frps_back_at`, and the integer in
    `RELAY_FRPS_STARTED` (0 when unreadable). Route answers carry it as `relayStarted`.
  - `GET /api/v1/health`: 200 `{ok: true, frps: true, relayStarted}` while `frps_ok_at` is under 2 s old, else 503
    `{ok: false, frps: false}`.
  - `write(sql: str, args: tuple) -> None`: every SQLite write of the plugin and the API goes through it; it retries
    `database is locked` for up to 0.8 s, then the plugin refuses with `relay error: busy` (inside the 1 s rule).

- [ ] **Step 1: Write failing tests** in `test_restart.py`:
  - `test_r4_1_health_follows_frps`: 200 with `frps: true`; `stop_frps()`: 503 within 2 s; `start_frps()`: 200
    within 3 s with `relayStarted` at or after the start.
  - `test_r2_2_generation_survives_relay_restart`: a client holds `acme` at generation 1; `restart_relay()`; while it
    is down the route call fails to connect; after it, `held`, generation 1, same client; `get` answered 200 at every
    sample (each 0.2 s) throughout.
  - `test_r2_2_generation_survives_frps_restart`: `restart_frps()`: the client holds `acme` again at generation 2 (it
    logs in with its run id and registers again, `client/service.go:344`, `client/control.go:114`), and
    `relayStarted` moved to the restart; sampled each 0.2 s, the route never reads `held` at generation 1 after the
    restart.
  - `test_restart_burst`: 40 `network` clients on 40 bindings; `restart_frps()`: all 40 `held` again within 60 s at
    generation 2; no trace line with `relay error: busy`; every plugin call under 1000 ms.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_restart.py -v`. Expected: FAIL (health has no `frps`, and
  `relayStarted` never moves).
- [ ] **Step 3: Implement** the interfaces and the unit files.
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** "Say the relay is healthy only while frps takes logins, and keep generations across
  restarts".

### Task 5: The sync record (R2.4)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 4 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py`; `README.md` (What it stores: each link's sync record, on or off, the copy's machine, its
  epoch, the registration it came in and when)
- Test: `relay/test/test_sync.py`

**Interfaces:**
- Consumes: `route_of` (Task 2), `write` (Task 4).
- Produces:
  - Table `sync(name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('on', 'off')), copy TEXT, epoch INTEGER
    NOT NULL, generation INTEGER NOT NULL, at INTEGER NOT NULL)`; the connection runs `PRAGMA synchronous=FULL`.
  - `sync_of(name: str) -> dict`: `{state, copy, epoch, generation, at}`, or `{state: 'off', copy: None, epoch: 0,
    generation: 0, at: None}` with no row. `route_of` adds it as `sync`.
  - `POST /api/v1/links/<name>/sync`, `application/json`, body exactly `{client: str (1 to 100), generation: int >= 1,
    state: 'on' | 'off', copy: str (1 to 100) | null, epoch: int >= 1}`, `copy` non-null when `state` is `on`, no
    other field: else 400 `invalid`. 404 and 401 as the route; 503 `unknown` on `FrpsUnknown`; 409 `{error:
    'not_holder'}` unless the route reads `held` from frps's `online` (not from a `pending` row) and the row's `client`
    and `generation` equal the body's; 409 `{error: 'stale_epoch'}` unless `epoch` is above the stored one; else the
    row is written and committed, and only then 200 `{sync: sync_of(name)}`.

- [ ] **Step 1: Write failing tests** in `test_sync.py`:
  - `test_r2_4_missing_reads_off`: a fresh binding's route has `sync == {state: 'off', copy: None, epoch: 0,
    generation: 0, at: None}`.
  - `test_r2_4_holder_sets_it`: `acme-aaaaaaaa-link` holds `acme` at generation 1; post `{client:
    'acme-aaaaaaaa-link', generation: 1, state: 'on', copy: 'bbbbbbbb', epoch: 1}`: 200, and the route's `sync` says
    the same with `at` set.
  - `test_r2_4_others_refused`: another client (`not_holder`), generation 2 (`not_holder`), epoch 1 again
    (`stale_epoch`), and the route `empty` after the holder stopped (`not_holder`) each give 409; the record stays.
  - `test_r2_4_pending_is_not_held`: on a binding with no client, the test writes a `routes` row `('globex', 1,
    'globex-aaaaaaaa-link', 'r1', 'http', 'pending', <now>)` into `relay.db`; the route reads `held`, and a sync post as that
    client at generation 1 gets 409 `not_holder`.
  - `test_r2_4_on_disk_before_answer`: right after the 200, a read-only `sqlite3` connection to `relay.db` finds the
    row; after `restart_relay()` the route's `sync` is unchanged.
  - `test_r2_4_bad_bodies`: `state: 'maybe'`, a missing `epoch`, `copy: null` with `on`, an extra field: 400 each.
  - `test_r2_4_unknown_frps`: `dashboard=False`: 503 and no row.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_sync.py -v`. Expected: FAIL (404 on the path).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** "Keep a sync record per link that only its holder sets".

### Task 6: Client ids, two companies on one machine, and peer services (R1.3, R1.4, R5.1, R6.2)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 5 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py`; `README.md` (What it stores: a hash of each link's visitor key; What it does: lets a
  company's machines reach each other's services through it and passes those bytes on as they come; Hornhoof's
  `SECURITY.md:54` says how the machines encrypt them)
- Test: `relay/test/test_peers.py`

**Interfaces:**
- Produces:
  - `CLIENT = re.compile(r'^(?P<link>[a-z0-9-]{1,63})-(?P<m8>[0-9a-f]{8})-(?P<kind>link|peer|visit)$')`.
  - Table `visitor_keys(name TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    `POST /api/v1/links/<name>/visitor-key` with the link key: 200 `{visitorKey}` (32 random bytes, base64url), its
    hash stored in place of the one before; 401 and 404 as the route.
  - `Login` rules, in order: the binding as today; then either `metas.key` matches (as today), or there is no
    `metas.key` and `metas.visitor` matches `visitor_keys`. `client_id` empty is allowed only with `metas.key` and no
    `metas.client` (a today's tunnel). Otherwise `client_id` must match `CLIENT` with `link == metas.name`, equal
    `metas.client`, and be of kind `link` or `peer` with the link key, `visit` with the visitor key; else
    `this client id is not for <name>`. With a non-empty `run_id` and a client id, `GET
    <api>/api/clients?runId=<run_id>` (1 s): an `online` entry whose `clientID` differs refuses `this run id belongs
    to another client`; a dashboard error refuses `relay error: frps does not answer`.
  - `NewProxy` rules by `user.metas`: a visitor-key session registers nothing (`visitors may not offer services`); a
    `link` or `legacy` session only the http proxy of today (Task 2); a `peer` session only `proxy_type == 'stcp'`
    named `<name>-<m8>-data` or `<name>-<m8>-app` with its own `m8`, `sk` of at least 32 characters, and
    `allow_users` empty or `["*"]`; anything else `this client may not offer <proxy_name>`. stcp services get no row
    in `routes` and no generation.

- [ ] **Step 1: Write failing tests** in `test_peers.py`:
  - `test_r1_4_two_companies_one_machine`: bindings `acme` and `globex`; clients `acme-3f2a9c1b-link` and
    `globex-3f2a9c1b-link` both start; each route names its own client.
  - `test_r1_3_second_login_same_id_refused`: `acme-3f2a9c1b-peer` runs with one stcp service, then is paused; a
    second frpc with that client id is refused (`is already online`) and gets in within `EVICTION_BOUND_S + 30` s
    after the first was dropped.
  - `test_r1_3_run_id_of_another_client`: with `acme-3f2a9c1b-link` online, a `Login` posted straight to
    `/frp/handler` with its run id (read from `dash('/api/clients')`) and `client_id 'acme-0000aaaa-link'` gets
    `reject: true`, `this run id belongs to another client`; the same post with the right client id gets `reject:
    false`.
  - `test_r1_3_foreign_client_id_refused`: `globex-3f2a9c1b-link` with `acme`'s key, and `acme-3f2a9c1b-link` with
    `metadatas.client` set to another value: refused.
  - `test_r5_1_peer_services`: the `-peer` client offers `acme-3f2a9c1b-data` and `acme-3f2a9c1b-app` (stcp, 40
    character secrets, two echo servers as targets); a visitor client `acme-77aa0011-visit` with the visitor key and
    the `-app` secret reaches the app echo through its local bind port; with a wrong secret its connection closes
    with no answer.
  - `test_r5_1_peer_limits`: refused for the `-peer` client: an stcp name with another `m8`, an `http` proxy, an `sk`
    of 8 characters; for a `-link` client: any stcp proxy; for a visitor-key session: any proxy; after a second
    `POST visitor-key`, a login with the first visitor key (R6.2).
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_peers.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** "Let each machine of a link log in once, offer its peer services, and visit them".

### Task 7: A new key, blocking without a restart, and freed names (R6.1, R1.5)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 6 committed.
**Done when:** `python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Modify: `relay/relay.py` (`POST /api/v1/links/<name>/key`; the live-route check for a requested name; the module
  docstring listing the whole API as it now is), `relay/hornhoof-relay` (its help text: a ban answers 410 at once and
  the blocked tunnel can never log in or register again; a release frees the name once its old tunnel is gone; no
  "within 90 s")
- Test: `relay/test/test_keys.py`

**Interfaces:**
- Produces:
  - `POST /api/v1/links/<name>/key` with the key: 200 `{key}`, a new 32-byte base64url key whose hash replaces the
    old; from then on the old key is refused by every endpoint and at `Login`. Live sessions stay. 401 counting as
    `DELETE`.
  - `name_live(name: str) -> bool`: `frps_route(name)[0] == 'online'`, raising `FrpsUnknown` as `frps_route` does.
    `GET /api/v1/names/<name>` and `POST /api/v1/bindings` with a `name` call it once `check_name` finds nothing
    against the name: `True` gives `{name, free: false, reason: 'taken'}` and 409 `taken`; `FrpsUnknown` gives 503
    `{error: 'unknown'}`. The random-name loop never calls it.
  - `admin ban` and `hornhoof-relay ban` work as today (the binding banned, `blocked.caddy` rewritten, Caddy
    reloaded). Nothing restarts frps.

- [ ] **Step 1: Write failing tests** in `test_keys.py`:
  - `test_r6_1_change_key`: a `network` client holds `acme`; post `/key` with the old key: 200 and a new key; the
    route with the old key 401, with the new 200 and still `held`; `get` 200 (the tunnel stayed); a new client with
    the old key is refused at login; one with the new key and another client id is refused with `router config
    conflict` until the first stops, then holds it.
  - `test_ban_without_a_restart`: a `network` client `acme-aaaaaaaa-link` holds `acme`; `admin ban acme` (relay.py
    with the stack's env); `admin banned-caddy` names `acme.hornhoof.org`; `kill()` it and start the same client again:
    its log says `acme.hornhoof.org is blocked` and its proxy never starts; `RELAY_FRPS_STARTED` is unchanged (frps
    never restarted).
  - `test_caddy_blocks_before_frps`: in the repo's `Caddyfile`, inside the `*.hornhoof.org` block, `import
    blocked.caddy` comes before `reverse_proxy 127.0.0.1:8080` (the ruling rests on that order).
  - `test_ban_today_client_cut_by_ping`: a `today` client: after `admin ban`, with no frps restart, its route goes
    within 40 s (its `Ping` is refused, as today).
  - `test_r1_5_freed_name_waits_for_its_tunnel`: a `network` client holds `acme`; `DELETE /bindings/acme` with the
    key: 204; `get('acme.hornhoof.org')` still 200; `GET /names/acme` gives `free: false, reason: 'taken'`; `POST
    /bindings {name: 'acme'}` gives 409 `taken`; after `stop()` and the route offline, the same post gives 201.
  - `test_r1_5_cannot_tell`: with `dashboard=False`, `GET /names/globex` and `POST /bindings {name: 'globex'}` give
    503 `unknown`, while `POST /bindings {}` gives 201 with a random name.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_keys.py -v`. Expected: FAIL (404 on `/key`, and the freed
  name is bound again at once).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v`. Expected: PASS.
- [ ] **Step 5: Commit** (`commit -s`) "Change a link's key, block a name without a restart, and keep a freed name
  until its old tunnel is gone".

### Task 8: Caddy under test, today's edge pinned (R7.2 as it stands)

**Repo:** relay repo, branch `main`. **Starts from:** Tasks 1 to 7 committed. **Done when:**
`sh relay/test/caddy.sh && python3 -m unittest discover -s relay/test -v` passes.

**Files (relay repo):**
- Create: `relay/test/caddy.sh`, `relay/test/test_edge_today.py`
- Modify: `relay/test/harness.py`

**Interfaces:**
- Consumes: `Stack`, `Client` (Task 1); `admin ban` and `admin banned-caddy` (Task 7).
- Produces:
  - `relay/test/caddy.sh`, as `frp.sh`: downloads `caddy_<v>_<os>_<arch>.tar.gz` of the newest 2.11 release from
    `https://github.com/caddyserver/caddy/releases/download/v<v>/`, checks its SHA-512 against the value written in the
    script (copied once from that release's `caddy_<v>_checksums.txt`, with a comment naming the file), puts `caddy`
    into `relay/test/.bin/`. `harness.py` runs it once per test run. Task 13 compares `<v>` with the droplet's
    `caddy version` before the deploy.
  - `Stack(tmp, dashboard=True, caddy=False)`. With `caddy=True` the harness makes a test CA and one certificate signed
    by it for `hornhoof.org`, `www.hornhoof.org` and `*.hornhoof.org` (`openssl`), and starts Caddy on the repo's
    `Caddyfile` rendered by a list of exact replacements: global `admin off`, `http_port` and `https_port` set to test
    ports, every `tls` line and hornhoof.org's automatic certificate replaced by `tls <test cert> <test key>`,
    `/var/www/hornhoof` by a copy of `www/`, `/var/www/hornhoof-pages` by a folder holding `relay/404.html` and
    `relay/410.html`, `blocked.caddy` and `companies/*.caddy` by files in `tmp`, `127.0.0.1:7600`, `:7000` and `:8080`
    by the test ports, and one test-only line in the `*.hornhoof.org` block, `header X-Test-Peer
    {remote_host}:{remote_port}`. A replacement that finds nothing raises, so a Caddyfile change cannot slip past the
    tests unseen. Until Task 9 the public https port is Caddy's.
  - `Answer(status: int | None, headers: dict[str, str], body: bytes, cert_names: list[str], local_port: int, error:
    str | None)`.
  - `Stack.https(host: str, path: str = '/', *, sni: str | None = <host>, method: str = 'GET', body: bytes = b'',
    keep: bool = False) -> Answer`: one request over TLS to the public https port with that server name, no
    verification, the peer certificate's DNS names in `cert_names`, the socket's own port in `local_port`; a failed
    handshake or connection gives `status=None` and `error`. `keep=True` returns `(Answer, KeptConnection)` whose
    `.again(path) -> Answer` sends a second request on the same connection.
  - `Stack.http(host: str, path: str = '/') -> Answer` on the public http port.
  - `Stack.client(..., via: str = 'frps')`: `via='caddy'` connects as Hornhoof's frpc does (`client.ts:24-44`):
    `transport.protocol = "wss"` to the public https port, `transport.tls.serverName = "hornhoof.org"`,
    `transport.tls.trustedCaFile = <test CA>`.
  - `Stack.reload_caddy()`: rewrites the test `blocked.caddy` from `admin banned-caddy` and reloads Caddy.
  - The echo server's answer gains `"xff"`, the request's `X-Forwarded-For`.

- [ ] **Step 1: Write `test_edge_today.py`**, every test on `Stack(tmp, caddy=True)`:
  - `test_stub`: `https('hornhoof.org')` is 200 and its body holds `<title>Hornhoof</title>`; `https('www.hornhoof.org')`
    is 308 to `https://hornhoof.org/`; `http('hornhoof.org', '/x')` is 308 to `https://hornhoof.org/x`;
    `http('acme.hornhoof.org', '/.well-known/acme-challenge/t')` is 308 to
    `https://acme.hornhoof.org/.well-known/acme-challenge/t` (the path HTTP-01 follows in plan 1b).
  - `test_api_through_caddy`: `https('hornhoof.org', '/api/v1/health')` is 200 with a JSON body.
  - `test_reserved_and_unknown`: `https('admin.hornhoof.org')` is 404 with the body of `relay/404.html`;
    `https('nobody.hornhoof.org')` is 404.
  - `test_http_mode_company`: bind `acme`; a `today` client `via='caddy'`, `started('acme')`;
    `https('acme.hornhoof.org')` is 200, `cert_names` holds `*.hornhoof.org`, the echo's `xff` is `127.0.0.1`, and
    `X-Test-Peer` ends with `:<local_port>`.
  - `test_blocked_410`: then `admin ban acme` and `reload_caddy()`: `https('acme.hornhoof.org')` is 410.
- [ ] **Step 2: Run** `sh relay/test/caddy.sh && python3 -m unittest relay/test/test_edge_today.py -v`. Expected: PASS.
  These describe today's edge; a failure means the harness is wrong, not the edge.
- [ ] **Step 3: Run Done when**, then commit (`commit -s`) "Run the edge's Caddy under test, as it is today".

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

### Task 11: The fake relay keeps the same contract (Hornhoof)

**Repo:** Hornhoof, in a new worktree `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/relay-contract` on a new
branch `relay-contract` from main (`git worktree add`, then `npm ci` there once). **Starts from:** Hornhoof main and
this plan's contract table only: Tasks 11 and 12 need none of the relay repo's code and may run beside Tasks 1 to 10.
**Done when:** from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/fake-relay.test.ts
test/link.test.ts test/setup.test.ts test/orchestrator-control.test.ts` passes, and `npx tsc -p
apps/server/tsconfig.json --noEmit` from the worktree root prints nothing.

**Files (Hornhoof):**
- Modify: `apps/server/test/fake-relay.ts`
- Test: `apps/server/test/fake-relay.test.ts` (new)

**Interfaces:**
- Produces, on `FakeRelay` (existing fields unchanged, so `link.test.ts`, `setup.test.ts` and
  `orchestrator-control.test.ts` stay as they are):
  ```ts
  type FakeRoute = { state: 'held' | 'empty'; client: string | null; since: number; generation: number };
  type FakeSync = { state: 'on' | 'off'; copy: string | null; epoch: number; generation: number; at: number | null };
  routes: Map<string, FakeRoute>;
  syncs: Map<string, FakeSync>;
  visitorKeys: Map<string, string>;
  frpsDown: boolean;          // route, sync and health answer 503, and so do a requested name's check and binding
  relayStarted: number;
  passthrough: boolean;       // true: health says the relay routes by TLS server name (R4.1)
  evictionBound: number;      // 30
  routeAnswer: 'contract' | 'garbage' | 'extra' | 'badstate' | 'hang';  // not JSON, one extra field, state "gone", no answer
  register(name: string, client: string): { ok: true; generation: number } | { ok: false; reason: 'router config conflict' | 'already online' };
  drop(name: string): void;   // the holder was evicted or stopped
  restartFrps(): void;        // every route empty, generations and syncs kept, relayStarted = now
  ```
  New routes, with the bodies, statuses and rules of the contract table: `GET /api/v1/links/:name/route`,
  `POST /api/v1/links/:name/sync`, `POST /api/v1/links/:name/key`, `POST /api/v1/links/:name/visitor-key`,
  `GET /api/v1/health`. `register` refuses a held name, and a client id that holds a live route of any link
  (`already online`, R1.3). `DELETE /bindings` and the key it checks follow `changeKey`. `GET /api/v1/names/:name` and
  `POST /api/v1/bindings` with a name answer `taken` (409 for the post) for a name with no binding whose route is
  `held` (R1.5); a random name never waits.

- [ ] **Step 1: Write failing tests** in `fake-relay.test.ts`, one `it` per row the fake covers, named by its row id
  and asserting the table's exact bodies through `fetch` against `relay.url`: `R1.1 refuses a second registration of a
  held name`; `R1.3 refuses a second live login with one client id`; `R1.4 lets two companies of one machine in side
  by side`; `R2.1 tells the holder, since and generation`; `R2.2 grows the generation with every registration and
  keeps it across an frps restart`; `R2.3 answers 401, 404 and 503, never an empty it is not sure of`; `R2.4 takes the
  sync record only from the holder at its generation with a higher epoch, and reads a missing one as off`; `R3.1
  empties the route when the holder is dropped`; `R4.1 answers health only while frps is up, with passthrough`; `R6.1 changes the key
  and refuses the old one`; `R6.2 hands out a visitor key and replaces it`; `R1.5 keeps a freed name until its old
  tunnel is gone`.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/fake-relay.test.ts`. Expected: FAIL (404s).
- [ ] **Step 3: Implement** the fake's state and routes.
- [ ] **Step 4: Run** the same, then `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/link.test.ts
  test/setup.test.ts test/orchestrator-control.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "Fake the relay's whole contract in tests".

### Task 12: Hornhoof reads the relay fail-closed

**Repo:** Hornhoof worktree of Task 11, branch `relay-contract`. **Starts from:** Task 11 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/relay-client.test.ts test/link.test.ts`
passes, the whole suite passes from the worktree root (`VITEST_MAX_WORKERS=2 nice -n 10 npm test --
--testTimeout=90000`), and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files (Hornhoof):**
- Modify: `apps/server/src/modules/link/relay.ts`
- Test: `apps/server/test/relay-client.test.ts` (new)

**Interfaces:**
- Consumes: the fake relay of Task 11.
- Produces, in `relay.ts` (`check`, `bind`, `unbind` unchanged):
  ```ts
  export type SyncRecord = { state: 'on' | 'off'; copy: string | null; epoch: number; generation: number; at: number | null };
  export type Route =
    | { known: true; state: 'held' | 'empty'; client: string | null; since: number; generation: number; relayStarted: number; evictionBound: number; sync: SyncRecord }
    | { known: false; why: 'unreachable' | 'slow' | 'refused' | 'malformed' };
  export type SyncPost = { client: string; generation: number; state: 'on' | 'off'; copy: string | null; epoch: number };
  export type SyncResult = { stored: true; sync: SyncRecord } | { stored: false; why: 'not_holder' | 'stale_epoch' | 'unknown' };
  route(name: string, key: string, timeoutMs?: number): Promise<Route>;                         // default 2000; never throws
  setSync(name: string, key: string, post: SyncPost, timeoutMs?: number): Promise<SyncResult>;  // never throws
  health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null; passthrough: boolean }>;  // never throws
  changeKey(name: string, key: string): Promise<string>;   // throws ApiError as bind does
  visitorKey(name: string, key: string): Promise<string>;  // throws ApiError as bind does
  ```
  zod: the route body is a `z.object` that allows extra fields (R2 may grow), `state` exactly `z.enum(['held',
  'empty'])`, integers `z.number().int().nonnegative()`, `sync` required with `state` exactly `z.enum(['on',
  'off'])`. A non-200 is `refused`, a timeout `slow`, a failed fetch `unreachable`, a body that does not parse
  `malformed`. `setSync` gives `stored: true` only for a 200 whose `sync` equals the post's `client`-free fields
  (`state`, `copy`, `epoch`, `generation`), `not_holder` and `stale_epoch` only for a 409 naming them, and `unknown`
  for everything else. The link key goes only into the `authorization` header, never into a result, an error or a
  log line.

- [ ] **Step 1: Write failing tests** in `relay-client.test.ts`:
  - `reads a held route and an empty one`: after `register('acme', 'acme-aaaaaaaa-link')`: `known: true, state:
    'held', client: 'acme-aaaaaaaa-link', generation: 1`; after `drop('acme')`: `empty`, generation 1.
  - `reads anything else as unknown, never as empty`: `frpsDown` gives `{known: false, why: 'refused'}`; a wrong key
    `refused`; `routeAnswer = 'garbage'` gives `malformed`; `'hang'` with `timeoutMs = 200` gives `slow` within 400
    ms; a closed port gives `unreachable`; `routeAnswer = 'badstate'` gives `malformed`.
  - `takes an extra field in a route answer`: `routeAnswer = 'extra'` gives `known: true`.
  - `posts the sync record as the holder`: `stored: true` and the next route's `sync` equals it; the same epoch again
    gives `stale_epoch`; another client gives `not_holder`; `frpsDown` gives `unknown`.
  - `tells relay health`: `up: true` with `relayStarted` and `passthrough: true`; `passthrough: false` when the fake says
    false and when the field is missing (a relay from before Task 9); `up: false` and `passthrough: false` while
    `frpsDown`, and while `down`.
  - `changes the key and gets a visitor key`: `changeKey` returns a key the fake now takes, the old one refused;
    `visitorKey` returns the fake's; with `down` both throw with reason `relay_unreachable`.
  - `never puts the key in a result or an error`: for every call above, `JSON.stringify` of its result or error does
    not contain the key.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/relay-client.test.ts`. Expected: FAIL
  (`route` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `test/link.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "Read who holds the link, its sync record and relay health, and fail closed".

### Task 13: Deploy the relay at night, check today's links, merge

**Repo:** both. **Starts from:** Tasks 1 to 12 committed and reviewed. **Done when:** Step 4 passes for the agent;
Steps 7 to 10 are the team lead's (the deploy, its checks and the merge), never an agent's.

**Files:**
- Create (relay repo): `relay/deploy.sh`, run on the Mac from the repo: reads `EDGE_SSH` and `EDGE_DIR` from
  `$EDGE_DEPLOY_ENV` (default `~/.hornhoof-edge/deploy.env`, outside the repo), refuses a dirty tree, then
  `git archive HEAD relay Caddyfile pages www` piped into `tar -x -C "$EDGE_DIR"` over `$EDGE_SSH`, then `$EDGE_SSH
  sh "$EDGE_DIR/relay/setup-relay.sh"`, and exits with its status. It names no host itself.
- Modify (relay repo): `relay/relay.py` (`admin gate`, `admin quiet`); `relay/setup-relay.sh` (the order below, and
  what Tasks 9 and 10 added: frpc, the edge client, the Caddyfile, the pages).
- Test: `relay/test/test_deploy.py`
- Modify (main checkout, not committed): `notes/ops/hornhoof-org.md`.

**Interfaces:**
- Produces, in `relay.py`:
  - `relay.py admin gate [--now HH:MM] [--reboot-file PATH]` (defaults: the UTC time, `/var/run/reboot-required`):
    exit 0 printing the whole seconds left until 07:15 UTC when the time is in [06:00, 07:15) and the file is absent;
    else exit 1 with `relay restarts run between 06:00 and 07:15 UTC (03:00 to 04:15 at UTC-3); now <hh:mm> UTC` or
    `the droplet reboots for updates at 07:30 UTC; deploy another night`.
  - `quiet_sample(text: str) -> dict[str, int]`: from the output of `ss -tinH state established '( sport = :<port> )'`,
    one entry per connection, keyed `<local> <peer>`, valued `bytes_sent + bytes_received` (`bytes_acked` where a line
    has no `bytes_sent`).
  - `relay.py admin quiet [--port 443] [--every 60] [--for SECONDS] [--bytes 65536]`: samples every `--every` seconds;
    exits 0 with `quiet: <n> connections, the busiest moved <b> bytes in <every> s` at the first interval in which no
    connection seen in both samples moved more than `--bytes`, and no connection seen only in the second holds more;
    exits 1 with `busy: <k> connections moved more than <bytes> bytes in <every> s` once `--for` seconds have passed;
    exits 2 with `cannot tell: <why>` when `ss` is missing or fails. It prints no address. Port 443 carries every
    company's tunnel (wss through Caddy) and every visitor, so it sees each link's traffic.
- `setup-relay.sh`, as root on the droplet, in this order:
  1. Works out whether frps must restart (binary, rendered config or unit differ from the installed ones), whether
     Caddy must (its Caddyfile differs; `caddy validate` on the new one first, stopping with `nothing changed` if it
     fails), and whether anything changes at all, before it touches a file.
  2. When frps is active and anything will restart: `relay.py admin gate`, then `relay.py admin quiet --for <the
     seconds gate printed>`, both from the new copy. Any non-zero exit stops it with `nothing changed` and that exit
     status. `HORNHOOF_RELAY_ANYTIME=1` skips both and prints `restarting outside the night window`. A fresh droplet
     (frps not active) skips them.
  3. Copies every file it will replace (`/etc/caddy/Caddyfile` and the pages included), and `relay.db` through
     `sqlite3`'s `.backup` (as the ops note does), into `/root/relay-before-<UTC yyyymmdd-hhmm>/`, and prints the one
     command that puts them back: it stops `edge-frpc` and frps (freeing 443), restores the files, disables
     `edge-frpc`, and restarts Caddy (back on 443), `hornhoof-relay` and frps. The rollback runs at any hour.
  4. Installs as today, and: `frpc` from the same frp tarball; `/etc/frp/edge-frpc.toml` and `edge-frpc.service`;
     `/etc/hornhoof-relay/edge.env` with `EDGE_TOKEN=<32 random bytes, hex>`, made once, mode 0600 root, and the same
     value as `RELAY_EDGE_TOKEN` in `/etc/hornhoof-relay.env` beside `RELAY_FRPS_HTTPS=127.0.0.1:443`; the Caddyfile to
     `/etc/caddy/Caddyfile`; `www/index.html` and the 404 and 410 pages where `setup.sh` puts them.
  5. Restarts once. When frps or Caddy must restart: `systemctl stop edge-frpc frps`, `systemctl restart caddy` (it
     gives up 443 and takes `127.0.0.1:8443` and 80), `systemctl restart hornhoof-relay`, a wait of up to 10 s for
     `127.0.0.1:7600` to accept, `systemctl start frps` (it takes 443), `systemctl enable --now edge-frpc`, then a wait
     of up to 15 s for `curl -sf --resolve hornhoof.org:443:127.0.0.1 https://hornhoof.org/api/v1/health`; a today's
     tunnel whose `Ping` lands while relay.py is down drops in the same blink. Otherwise `systemctl restart
     hornhoof-relay` alone. Then `relay setup done`.

- [ ] **Step 1: Write failing tests** in `test_deploy.py`:
  - `test_gate`: `--now 05:59` exit 1; `06:00` exit 0, prints `4500`; `07:14` exit 0, prints `60`; `07:15` and
    `12:00` exit 1; `--now 06:30` with `--reboot-file` naming an existing temp file exit 1 with `reboots`.
  - `test_quiet_sample_parses_ss`: a recorded `ss -tinH` text in the test (three connections, addresses from
    `127.0.0.1` and `192.0.2.0/24` only) gives three keys and their byte sums; a line with `bytes_acked` and no
    `bytes_sent` uses `bytes_acked`.
  - `test_quiet_waits_for_a_quiet_minute` (Linux only, `skipUnless(sys.platform == 'linux')`: macOS has no `ss`; CI
    runs it): a `today` client holds `acme`; a thread POSTs 200 KB through the vhost port every 0.5 s; `admin quiet
    --port <frps bind port> --every 2 --for 6` exits 1 with `busy:`; once the thread stops, `--for 10` exits 0 with
    `quiet:`. The frps bind port is where the test's frpc lands, as port 443 is on the droplet.
  - `test_quiet_cannot_tell`: with `PATH` holding no `ss`, exit 2 with `cannot tell`.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_deploy.py -v`. Expected: FAIL (`admin gate` is unknown).
- [ ] **Step 3: Implement** `gate`, `quiet_sample`, `quiet`, the order of `setup-relay.sh` and `deploy.sh`.
- [ ] **Step 4: Run** `python3 -m unittest discover -s relay/test -v` and `sh -n relay/setup-relay.sh relay/deploy.sh`.
  Expected: PASS, no output from `sh -n`. Commit (`commit -s`) "Restart the relay once, at night, while its links
  are quiet".
- [ ] **Step 5: Run every test.** Relay repo: `python3 -m unittest discover -s relay/test -v` → PASS. Hornhoof, from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000 > <ws>/full.log 2>&1; tail -30
  <ws>/full.log` → all pass; `npx tsc -p apps/server/tsconfig.json --noEmit` → no output.
- [ ] **Step 6: Review.** The team lead reads both branches against the contract table, spec 3.4 and 3.10, and the
  overview's TLS section, and the relay repo against overview decision 1 (nothing private, every commit signed off);
  the CLI agent that did not write a task reviews it too (Gemini for Codex's tasks, Codex for Gemini's); one fix pass,
  each fix with its failing test first.
- [ ] **Step 7: Deploy at night** (overview decision 4). Before it, the team lead checks that `$EDGE_SSH caddy
  version` is the 2.11 release `relay/test/caddy.sh` pins (stop if the minor differs: the tests ran another Caddy),
  and keeps `curl -fsS https://hornhoof.org/install.sh | shasum -a 256`. Then, between 06:00 and 07:15 UTC (03:00 to
  04:15 at UTC-3) on a night after the review, `sh relay/deploy.sh` from the relay repo. Expected: `quiet: ...`, the
  backup folder, the rollback command, `relay setup done`; frps and Caddy restarted once, together. On `busy`,
  `cannot tell` or a gate refusal nothing changed: deploy the next night.
- [ ] **Step 8: Check.** If any check fails: run the printed rollback command, check hornhoof.org and the link again,
  and stop.
  - `curl -s https://hornhoof.org/api/v1/health` → `{"ok": true, "frps": true, "relayStarted": ..., "passthrough":
    true}`; `curl -s https://hornhoof.org/ | grep -c '<title>Hornhoof'` → `1`; the install script's sha256 equals the
    one kept before; `curl -s -o /dev/null -w '%{http_code}' https://admin.hornhoof.org/` → `404`, with
    `X-Robots-Tag: noindex, nofollow`.
  - Ivan's link, still in http mode: `curl -s -o /dev/null -w '%{http_code}'
    https://5y32cnxttxtucl3hhwbnzq4q.hornhoof.org/api/health` → `200` within 30 s of the restart; `curl -s -H
    "Authorization: Bearer $(cat ~/.hornhoof-edge/relay/hornhoof/key)"
    https://hornhoof.org/api/v1/links/5y32cnxttxtucl3hhwbnzq4q/route` → `state: "held"`, `client: "legacy"`,
    `generation` 1 or more, `sync.state: "off"`. On the droplet `hornhoof-relay list` shows every binding as before.
  - Passthrough end to end, with a throwaway name that never gets a public certificate: on the droplet
    `hornhoof-relay add relay-check-<8 random hex>` (it prints the key once); on the Mac, `openssl s_server -accept
    127.0.0.1:9443 -www` with a self-signed certificate for that name, and `relay/test/.bin/frpc` with Hornhoof's
    settings (`wss` to hornhoof.org:443, `metadatas.name` and `metadatas.key`) and one `https` proxy named after it
    to `127.0.0.1:9443` with `transport.proxyProtocolVersion = "v2"` left out (`s_server` reads no PROXY header). Then
    `openssl s_client -connect <name>.hornhoof.org:443 -servername <name>.hornhoof.org </dev/null` shows that
    self-signed certificate's subject. `hornhoof-relay release <name>`: the next `s_client` gets no certificate (R7.4).
    Stop both programs.
- [ ] **Step 9: Update the ops note**: where the code lives now (the relay repo; the droplet folder keeps the base
  setup, `README.txt` says how the two meet), the layout on 443 (frps routes by name, `edge` carries the rest to Caddy
  on `127.0.0.1:8443`, Caddy keeps 80 and the certpush wildcard), the API section with the new endpoints, the tunnel
  settings (client ids, keepalive, the 30 s bound), blocking restarts nothing (410 at once in http mode, new
  connections refused in https mode, `ban --cut` for open ones), a freed name waits for its old tunnel, the env files
  and the edge token, the night gate and `HORNHOOF_RELAY_ANYTIME`, the rollback.
- [ ] **Step 10: Merge.** Relay repo: the work is on its `main`; the team lead pushes it. Hornhoof: `git merge
  --ff-only relay-contract` into main, `git push origin main`, and wait for CI green.

## Addendum: R6.1 takes the new key it is given (plan 9's ruling 20)

Plan 9 is the first to change a link's key by itself (a machine that held the company's data left), and an answer
lost on the way would leave the company with no key that works, since R6.1 picks the new key and refuses the old one
at once. So R6.1 also takes the new key from its caller: Hornhoof saves the key it chose before it asks, and after a
lost answer it reads `route` with that key to learn whether the change happened. Hornhoof's side (the client's
`changeKey(name, key, next?)` and the fake relay) is plan 9's Task 3; this addendum is the relay's side. The team lead
runs it and deploys it with the rest of the series' relay work at its end, before the rehearsal; plan 9's lab runs on
the fake relay and does not need it.

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
