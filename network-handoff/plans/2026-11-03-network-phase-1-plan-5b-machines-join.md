# Network Phase 1, Plan 5b: Machines Join the Company, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A computer joined with the Machines tab's command gets the company's small core (`front`, `keeper`, `updater`)
in a folder of its own and becomes a worker: its keeper joins with a one-use ticket, holds a `worker` certificate,
reaches the company server's app over the peer link (directly on the local network, else through hornhoof.org as an stcp
visitor), and serves the company on that machine's localhost, so its nodes point at their own machine. With no server in
reach it shows where the company can be opened. Workers report their addresses and measures, follow the server's build
one at a time without cutting a running turn, and Disconnect cuts one off for good. The Machines tab shows where the
server runs, each machine's local address, and offers the core to machines joined before. Each person's own key, made in
their browser and kept on the server only wrapped by their password, rides in every join command, and the worker pins it
for plan 6. The lab gets its Docker-in-Docker machines.

**Architecture:** One migration (`0050_machines_join`): addresses, path, update state and the owner's pin on `machines`,
the tables `machine_tickets`, `machine_online` and `person_keys`, `node_codes.core`, and the peer secret kind `visit`.
On the server side, `modules/network/join.ts` (tickets, the signed renewal, the worker's view of the network, the online
share) and `modules/network/follow.ts` (the server's build and whose turn it is to install it), with routes in
`modules/network/routes.ts` and the join answer in `modules/nodes/routes.ts`. On the machine side, the keeper gains a
second mode, `modules/keeper/worker.ts`, which dials the data machines with `net/peer-link.ts` (mutual TLS on HTTP/2,
direct or through a local stcp visitor from `modules/link/visit-client.ts`) and passes its front door through `CONNECT
app`. One compose file serves both kinds of machine: a worker's `.env` adds `compose.worker.yaml`, which puts the data
services in the profile `data`, so a server's compose file and `.env` read as before. `install.sh` gains the worker's
core, the updater a worker mode and the address helper, and the node a `set-server` command. In the browser,
`owner-key.ts` makes each person's key, wraps it with their password for the server, and adds it to every join command.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:tls`, `node:crypto` Ed25519); Fastify 5; drizzle-orm 0.45.4
on node-postgres and PGlite; frpc 0.71.1; bash 3.2 and BusyBox for `install.sh` and `updater.sh`; Docker Compose
profiles; WebCrypto in the browser (ECDSA P-256, PBKDF2-SHA256, AES-GCM); vitest with PGlite; Docker for `npm run
test:real` and the new `npm run test:lab` (Docker-in-Docker).

**Spec:** `notes/specs/2026-11-02-single-network-design.md` section 2 ("Joining", the Machines tab's "Company server
here", "Open here: localhost:8081"), 3.1 (the small core on every computer, the data services as a compose profile),
3.2 (paths, address discovery, "Mac does not take connections from Debian"), 3.3 (the load report's 7-day online
share), 3.9 ("Finding the leader"), section 6 (the joined machine's folder, the leader's web port first), section 9
("Make Mac a full machine of the company", workers update one by one, keeper messages compatible across one version),
section 10 (the expired certificate, "A stolen machine"), section 12 (the lab's Docker-in-Docker machines). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 5's entry. Plan 5 (see "Handed over by plan 5").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/machines-join` on a new branch `machines-join` from main (`git
worktree add`, then `npm ci` there once), after plan 5 is merged into main and shipped.

**Handed over by plan 5** (and by plans 1 to 4 through it; merged and shipped before this plan starts):
- `modules/network/authority.ts`: `issueCertificate`, `certFacts`, `issuedBy`, `needsRenewal`, `makeCrl`, `CERT_DAYS`,
  `RENEW_AFTER_DAYS`, `SKEW_MS`, `Authority`, `Issued`, `CertFacts`; `MachineRole`, `MACHINE_ROLES`.
- `modules/network/store.ts`: `authorityOf`, `makeAuthorityOnce`, `thisMachine`, `findThisMachine`,
  `revokedSerials`, `peerSecret(db, config, kind, leading)`; `modules/network/via.ts`: `VIA`, `OWN_VIA`, `askerOf`,
  `Asker`; `modules/network/routes.ts`: `networkRoutes` with `POST /api/network/certificate`, `GET
  /api/network/peers` and `POST /api/network/report`; `modules/nodes/nodes.ts`: `shownMachine`, `builtinMachine`.
- Tables `authority`, `certificates`, `peer_secrets` (kinds `data` and `app`, check `peer_secrets_kind`), and on
  `machines` `network_id` (unique over the whole column), `role`, `sign_key`, `web_port`, `peer_port`, `commit`,
  `uptime_s`, `fsync_p99_ms`, `disk_free`, `report_at`; the leader's own machine as a hidden `server:<machine id>` row.
- The keeper: `KEEPER_DIR`, `machineKey(dir)`, `MachineKey`, `CERT_FILE`, `HeldCertificate`, `readHeldCertificate`,
  `CertificateKeeper` (with `renewNow`), `Measures`; `KEEPER_PORTS` (`peer` 7070, `front` 7080, `linkHttp` 7081,
  `peerApp` 7071); `Keeper.peerPorts()`; `<dir>/crl.json`; `LeaseStore.othersHoldData()`.
- `net/peer-server.ts`: `PeerServer`, `Peer`, `PEER_PATHS` (`hello`), `APP_AUTHORITY`, `DB_AUTHORITY`; its `hello`
  answers `{ machine, role, lead, commit, seen }`; `net/peer-door.ts`: `PeerDoor`.
- `modules/link/peer-client.ts`: `peerClientId`, `serviceName`, `PeerServices`, `peerConfigFor`, `peerClientFor`
  (the server's peer frpc, `frpc-peer.toml`).
- Plan 1, on hornhoof.org: an frpc logged in as `<link>-<machine8>-visit` with the link's visitor key runs stcp
  visitors and registers nothing (R5.1); `POST /api/v1/links/<name>/visitor-key` with the link key answers
  `{ visitorKey }` and replaces the one before (R6.2), which the app's relay client calls as `visitorKey(name, key)`.
- Plan 2: `net/proxy.ts` (`passThrough`, `PassOptions`, `serve`, `Target`, `firstForwarded`, `socketAddress`); `front`;
  the keeper's front door; `updaterBusy`; the port registry in `install.sh` (`take_port_lock`, `read_registry`,
  `write_registry`, `bound_ports`, `reserve_ports`, the volume `hornhoof-ports`); `HORNHOOF_MACHINE_ID` as the host
  id by hand; compose's services `front`, `keeper`, `migrate`, `app`, `db`, `node`, `updater`; the updater's
  `--take-over`. Plan 4: `KEEPER_HOLD_MS`, `PassOptions.holdMs`, `holding`, `held`, `heldAnswer`; `front` stamping
  tool calls. Plan 3: `HIDDEN`, `CLOSED`, `AFTER_MIGRATIONS`.
- Today's code: `/api/nodes/join` and `JoinBody` (`modules/nodes/routes.ts`), `disconnectMachines`
  (`modules/nodes/disconnect.ts`), `createNodeCode`, `commandFor`, `publicUrl`, `install.sh`'s `join_machine`,
  `node_mode`, `start_node`, `existing_nodes`, `host_id`, `uninstall_mode`; `updater.sh`'s `update`, `healthy`,
  `go_back`, `drop_orphans`, `pull_images`; the node's `set-key` (`apps/node/src/main.ts`); `Machines.tsx`; `reinvite`
  (`modules/people/routes.ts`), `verifyPassword` (`auth/password.ts`) and `POST /api/auth/login`'s limiter; in
  `apps/web`, `ui/CommandBox.tsx`, `screens/Setup.tsx`, `api.ts`'s `request` and `Shell`'s sign-out; `UpdateCheck`,
  `registry()`, `UpdaterStatus` (`modules/updates/`), `config.image`, `config.commit`; the queue's `take`,
  `openTypedTurn` and `pumpWaiting`; `modules/testruns/runs.ts`'s `giveOut` and `pumpTests`; `nodes.machine_id`,
  `nodes.last_seen_at`, `test_parts.machine_id`; `machines.machine_key`, whose `hashToken('hornhoof-host:' + key)` is
  the host id `install.sh` gives that computer. Plans 3 and 4: `test/real/pg.ts`'s `realDatabase`, `migrateDb`,
  `openDb`, `npm run test:real`.
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`; a page the keeper serves itself carries an
  English and a Russian line, as plan 4's `heldAnswer` does.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges
  (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), hosts under `hornhoof.test`, and keys and certificates made at
  run time. The lab's images are pinned by digest.
- No new npm dependency: the owner's key uses WebCrypto in the browser and `node:crypto` on the server.
- One new migration, never an edit of an older one: `0050_machines_join` by `npx drizzle-kit generate --name
  machines_join` from `apps/server`.
- A worker holds no company secret: no `HORNHOOF_SECRET`, `NODE_KEY`, `POSTGRES_PASSWORD`, link key, `data` stcp
  secret or database. It holds its machine key, its certificate, its nodes' keys, the link's visitor key and the `app`
  stcp secret. A private key never goes into a log line, an answer, or a file outside the keeper's own volume.
- Messages between keepers and the server's app change only by additions: a field is added, never removed or given
  another meaning, and a new request field is optional, so a keeper one version apart still works (spec section 9).
- The keeper starts before `migrate` (plan 2): every read of a table or column this plan adds keeps what the keeper has
  when it fails, and nothing a data machine's keeper does each second reads them.
- Fail toward a working company: nothing a worker does or fails to do changes what the server's machine runs, and a
  failed join, renewal, report or follow on the server answers that request alone.
- Every certificate a machine row gets is issued inside a transaction that holds that row `FOR UPDATE` and finds it
  live (`lockLiveMachine`, Task 2): plan 5's `POST /api/network/certificate`, the join and the renewal alike. Disconnect
  updates the rows first in its own transaction, so the two never cross.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` and
  `apps/node` the same with their files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm
  test -- --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root:
  `npx tsc -p apps/server/tsconfig.json --noEmit`, and `apps/web` and `apps/node` likewise when touched, each printing
  nothing. Shell, from the root: `bash -n` and `shellcheck` on `scripts/install.sh` and `apps/updater/updater.sh` print
  nothing. Never run prettier.

## Rulings made while planning

1. **This plan brings workers, and the server stays the one data machine.** A joined computer is a worker: it runs the
   small core and its nodes, opens the company on its localhost, holds no data. Copies and the server order are plan
   9's, phones phase 3's. Disconnect changes the stcp secrets and the visitor key but not the link key: only a data
   machine holds the link key (spec section 10, "Secrets"), and the first data machine apart from the server comes
   with plan 9, which changes it then. That is a deviation from the overview's plan 5 entry.
2. **One compose file, and an overlay for workers.** `compose.yaml` keeps every service as today, with no profile, so
   a server's `.env` and plan 5's updater (its `pull_images`, plan 2's `remove_unnamed`, its installer call) find the
   same services as before. A new `compose.worker.yaml`, in the image beside it, gives `db`, `migrate`, `app` and `node`
   `profiles: ["data"]`; a worker's `.env` says `COMPOSE_FILE=compose.yaml:compose.worker.yaml`, which `docker compose`
   run in its folder reads (tried on Compose 5.0.1: there `config --services` lists `front`, `keeper` and `updater`, and
   with `-f compose.yaml` all of them). Compose fills `${VAR:?...}` in every service, also outside the active profiles
   (tried), so `HORNHOOF_SECRET` and `NODE_KEY` become `${...:-}`, and the app and the data keeper refuse an empty one
   themselves (`loadConfig`), as the built-in node does today. The keeper's `depends_on: db` gets `required: false`,
   which Compose takes when `db` is not active (tried). A worker is never told `compose up db`, since a service named
   on the command line starts whatever its profile (tried): its updater's `drop_orphans` names `keeper`, and its
   `pull_images` and the service lists it reads take both files of the build with `-f`.
3. **A join from the new installer brings a ticket for the core.** `install.sh` sends `core: true`; the join answer
   then carries `core <folder> <ticket> <port> <company>`, or `core-here <port>` when the joining computer is the
   server's own (its host id hashes to `config.hostId` or to the server's network id), and `build ...` when the server
   knows its exact build (ruling 10). The ticket is 32 random bytes, kept as a hash in `machine_tickets` (hidden, row
   level security), good once for 24 hours. The installer writes it into the core's `.env`; the keeper uses it once,
   with its own key, at `POST /api/network/join` on the address the command came from, and gets its certificate, the
   authority and its view of the network. The join trusts that address as the command does: whoever answers there gave
   the installer too. The network id it sends must be `hashToken('hornhoof-host:' + machine key)` of the ticket's row,
   the id the installer gives that computer's keeper, so a ticket binds one computer. The keeper redeems each ticket
   once (it keeps the last one's hash), so a second join on that machine gives it a fresh certificate for the same key
   and changes nothing that works; a refused ticket changes nothing while it holds a live certificate. Two people on
   one computer share its core under the first one's row: the second one's ticket answers 409 `machine_taken`, until
   the first one's row is disconnected.
4. **The folder.** `~/hornhoof-<link name>`, else `~/hornhoof-` and six letters drawn from the company id (the same on
   every machine, so a company never wants `~/hornhoof`); `.env` names the company in `HORNHOOF_COMPANY`. A folder of
   that name that names another company, or none, gets the next suffix `-2` to `-9`. The core's web port is first the
   server's own (spec section 6), else the registry's next; its peer port the registry's next.
5. **The machine id of a worker is its host id**, as by hand on a server (plan 2), so the server tells its own computer
   by it. A server installed before host ids existed and never installed by hand since cannot tell its own computer;
   a join there makes a worker core beside the server, which works, and `install.sh server` by hand once writes the id.
6. **Two paths to a data machine, direct first.** Direct: each of its addresses with the peer port, 3 s each. Else
   the relay: the
   worker's visitor frpc `<link>-<machine8>-visit` logs in with the link's visitor key and opens the stcp service
   `<link>-<target8>-app` with the `app` secret on a local port. `<machine8>` and `<target8>` are the first 8
   characters of the network ids (`HORNHOOF_MACHINE_ID`), as plan 5's `serviceName` names the server's services, not of
   the rows' uuids, which the certificates name. Inside either, TLS 1.3 with the worker's certificate,
   and the server's certificate must be of the authority, of the role `data`, for the machine dialed, and not on the
   revoked list. On the relay the worker tries direct again every minute. When an address on a `/24` the worker shares
   failed and the relay works, it reports `directFails`, which the server's card shows as "Mac does not take
   connections from Debian"; a worker in another home, which shares no network with it, raises no such line.
7. **An expired certificate, or secrets changed meanwhile, renew by a signed request, never through the peer port.**
   Plan 5 keeps the peer port's handshake strict. A worker posts `POST /api/network/renew` over plain HTTP(S) to its
   join address, then to its cached link's `url` when that is https and another address, then to each data machine's
   web port: at once when a data machine refuses its certificate or the
   certificate expired, after 10 s with no session to any data machine, then every 30 s while it has none. The body is
   `{ machine, serial, at, signature }`, the signature Ed25519 by its machine key over
   `hornhoof-renew:<machine>:<serial>:<at>`. The server takes it in one transaction holding the row `FOR UPDATE`: the
   row live with that `sign_key`, `at` within 5 minutes and after the last one it took (`renew_at`, set in the same
   transaction). It answers the worker's view of the network, and a new certificate only when `serial` is not a live
   certificate of that machine or `needsRenewal` holds for it. The answer is signed with the authority's key over
   `hornhoof-renewed:<machine>:<serial>:<at>:` and the answer's text, and a disconnected machine gets a signed
   `disconnected`; the worker takes neither without the signature of the authority it holds, so a path that changes the
   answer only makes the renewal fail. An answer that did not come over TLS (`cameOverHttps`, which plan 2 keeps
   working behind the keeper) leaves the view's `link` out, so a listener on the local network sees no secret, and the
   worker keeps its cached link, as for any field an answer lacks. The worker that needs new secrets after a
   Disconnect is on the relay, and it renews through an https address, the join server's or its link's, so nothing is
   lost. The view carries no `build` and no `go` either, which come only through the peer link. This is spec
   section 10's "may use its expired certificate only to ask for a new one", carried by the key the certificate
   names.
8. **Finding the leader.** The worker keeps sessions to the data machines its last view lists (one in this plan),
   asks each `hello` every 10 s, and takes the one that says `lead`. Its front door passes each request through `CONNECT
   app` on that session, held up to `KEEPER_HOLD_MS` while there is none. With no leader for 60 s, a page request
   gets at once a page listing the data machines' `localhost` addresses and the link; an API call gets 503 after the
   hold. The view is kept in `<dir>/peers.json`, so a worker started with no server in reach still knows them.
9. **Nodes point at their own machine.** A node joined on a computer with a core gets `http://host.docker.internal:<its
   web port>` by `set-key`; a node there from before gets it by the new `set-server`, run by the installer only when it
   restarts that node anyway (an update without a code, or the worker's update). A node is never restarted for this
   alone.
10. **Workers follow the server's build, one at a time, between turns.** The server knows its exact build when the
    registry has its commit's tag (`find`, the tag `requestFor` uses), with the node and updater images of that tag;
    else none, and workers stay where they are, as they do with a server that answers no `build` (plan 5's). A worker
    on another commit gets the build in its view and downloads it at once (spec section 9, step 1). It installs only
    with the server's grant, `go`: one grant in the company at a time, under one lock; only once the worker reports the
    build downloaded and while none of its nodes runs a turn or a test part; good for 15 minutes from the grant and
    never extended. While a grant is good, new turns, test parts and typed turns wait on that worker's nodes; it ends
    when the worker reports the new commit, reports the install failed, or the 15 minutes pass. A worker whose attempt
    failed or ran out gets `go` for the same commit again after 6 hours.
11. **Addresses.** On Linux the updater runs a short `--network host` container of its own image every minute and
    writes `/control/addresses.json`; on a Mac `install.sh` records `ipconfig getifaddr en0` and `en1` into `.env` once
    (`HORNHOOF_ADDRESSES`); each keeper adds the private address a data machine's `hello` says it was seen from. The
    keeper reports up to 8 private IPv4 addresses, without loopback, and the server keeps them on the row. A Mac server
    whose address changes is reached through the relay until `install.sh` runs there again; plan 9's copies, which
    dial it, tell it. On Linux the updater's helper also covers a server moved in by Update. A Mac server moved in by
    Update has no address, and its workers reach it through the relay, which works, until it is installed again from
    a release (Ivan plans that himself), which records it; no step asks anyone to type a command for it. A Mac address
    that changes after that is plan 9's.
12. **The online share is 20 seconds per report.** Each report adds 20 s to the machine's UTC day in
    `machine_online`, once per 15 s at most and up to a day. The share is over one window, from the later of 7 days ago
    and the row's `created_at` to now: the seconds of the days in it, the oldest day's in proportion to its part inside
    the window, over the window's length, clamped to 0 to 1. Plan 9's score reads `onlineShare`; nothing shows it
    yet.
13. **Disconnect cuts a worker off for good.** In its transaction, which updates the machines' rows first: every
    certificate of the machine revoked, its `network_id` cleared, its unused tickets gone and its unused commands
    (`node_codes` naming it) used up; when it had a core, the `data`, `app` and `visit` peer secrets go too, once. After
    it commits, the app asks the relay for a new visitor key at once, past the one-a-minute rule that guards its other
    asks, which ends the old key; a failure is tried again on the next view a keeper reads. The server's own keeper
    makes new stcp secrets within 5 s (plan 5) and its peer frpc restarts with them; workers on the direct path keep
    their sessions, and workers on the relay lose theirs and take the new secrets by renewal within a minute (ruling
    7). The disconnected keeper's handshakes fail from plan 5's list on, its renewal gets the signed `disconnected`, and
    then it asks nothing more and its front door answers a page saying the machine was disconnected.
14. **"Make Mac a full machine of the company"** is a card action for the machine's owner on a computer with no core (no
    `network_id`) one of whose nodes was seen in the last day, other than the server's own: a one-use command whose code
    has `core` set, made for that machine. Its join answers the core and no node, and the machine's nodes move to the
    core at their next restart (ruling 9).
15. **The lab.** `npm run test:lab` builds the three images from the worktree, a machine image on a pinned
    `docker:dind`, and runs Docker-in-Docker machines on a network of their own: a server installed by `install.sh
    server`, a worker joined with the Machines tab's command, then Disconnect. It is the stand for joining in Task 10
    too, since the team lead has no second machine of his own. Network cuts, `tc netem` and five machines come with
    plan 9.
16. **The macOS firewall.** Both Mac engines publish a port on every interface of the Mac, so neither needs a line of
    its own. Docker Desktop listens through `com.docker.backend` (the team lead saw it on `*:18080`). Colima, which
    `install.sh` installs on a Mac without Docker, adds to Lima's rules one that forwards a port the VM binds on
    `0.0.0.0` to `0.0.0.0` on the Mac, through Lima's ssh forwarder, so the listener is `ssh` (colima
    `environment/vm/lima/yaml.go`, "handle port forwarding to allow listening on 0.0.0.0", since v0.3.0, read at
    v0.10.3; Lima's own default of `127.0.0.1` applies only to ports the VM binds on loopback). Compose publishes the
    web and peer ports with no host address, which this rests on, and a test pins it (Task 6). So the Connect a machine
    panel and the card's refusal line name both programs, `com.docker.backend` and, with Colima, `ssh`, and say the Mac
    may ask once; each line is true on both. The command does not know the server's system, and nothing is added to
    find out.
17. **Only a keeper's own request is the keeper's.** A worker's front door, published on every interface, passes any
    request over `CONNECT app`, and plan 5's `PeerDoor` writes `x-hornhoof-via: <machine>` on everything that comes
    that way; so a LAN neighbor at the worker's web port, or a page on its localhost, could otherwise ask the network
    routes as the worker and read its view, the link's app secret and visitor key among it, or report for it.
    `PeerLink.request` sends `x-hornhoof-via: keeper`, which every front door strips (plan 2), and the `PeerDoor` adds
    `x-hornhoof-keeper: 1` only to a request that came with it. `GET /api/network/peers`, `POST /api/network/report`
    and `POST /api/network/certificate` take a peer only with that mark (`keeperAsker`), and answer anything else as
    they answer a request with no via: 403 `not_keeper`. `POST /api/network/join` and `POST /api/network/renew` stay
    open, as designed: the ticket and the machine's signature carry them. The via alone still names the worker for
    everything else (`clientAddress`).
18. **A command carries its owner's key, and the worker pins it.** Plan 6 lets a machine's computer access open only
    by a grant signed with its owner's key, which the machine's keeper pins from what its owner carried there: the
    command they ran on it, never a server's answer. So the join command takes `--owner-key <key>` (the owner's public
    key, SPKI DER in base64url), and every join command the web app shows carries the viewer's (ruling 19), so no
    worker joins without a pin. The installer writes it into the core's `.env` as `HORNHOOF_OWNER_KEY`, together with
    the ticket and only then, replacing an older line; a join without it keeps the line, and the updater keeps it too.
    The keeper's environment carries it and `workerConfig` reads it; the installer never sends it anywhere. The
    worker's keeper pins it in its own volume (`owner.json`) when its join with that ticket succeeds; a failed join
    (409 `machine_taken`) changes nothing, a later redeemed ticket with another key replaces it, and no answer of a
    server ever gives one. Its report carries the pin's print, which the server keeps as `owner_pin`. Grants and their
    check are plan 6's.
19. **Each person's key is made in their browser and kept on the server only wrapped.** The browser makes an ECDSA
    P-256 key pair (in WebCrypto in every current browser, and Node verifies it alike), derives an AES-GCM 256 key from
    the person's password by PBKDF2-SHA256 with 600 000 iterations and 16 random bytes of salt, and wraps the private
    key (`pkcs8`, a 12-byte IV). The server keeps, per person, the public key, the wrapped key, the salt, the IV and the
    iterations (`person_keys`, hidden from agents' SQL), and takes a new key only with the person's password, checked
    as sign-in checks it, and only while the person has none. The browser makes the key the first time it shows that
    person a join command, asking for the password once then (Setup uses the one just typed), and keeps the private key
    as a non-extractable `CryptoKey` in IndexedDB until sign-out, the app's 401 `signed_out`, or a public key on the
    server that is not its own. A reset of the password (`reinvite`) deletes the person's `person_keys` row, so the old
    wrapped key cannot be used; the owner makes a new key, and a machine takes it only from a new command run there.
    Plan 6 unlocks the key on other devices and signs with it. (Ruled by the lead: the key comes here, so that no
    worker joins without a pin.)

## Review Focus

1. A disconnected worker: its open session closes within 6 s, its next handshake fails, `renew` answers the signed
   `disconnected`, `join` and every network route refuse it, a command made for it before no longer joins, its visitor
   key no longer logs in, and its old `app` secret no longer opens the service. Tests in Task 2 (`cuts a disconnected
   machine off`, the real races), Task 4 (`stops at disconnect and says so`) and Task 9.
2. A join or renewal that should fail, or an answer changed on its way: a used, expired or unknown ticket, a ticket of
   a disconnected machine or of a disabled person, a network id of another computer, a signature by another key, an
   `at` 6 minutes old, the same `at` twice or at once, a renewal racing Disconnect; and on the worker, a renewal answer
   not signed by the authority it holds. Each is refused and writes nothing. Tests in Task 2 (`joins once with a
   ticket`, `renews only with the machine's key, once per moment`, the real races) and Task 4 (`drops a renewal answer
   it cannot trust`).
3. A worker never reaches `db` and never holds a company secret: its `.env`, its keeper's environment and every answer
   it gets carry none, and its view has no `dataSecret`; a renewal answer over plain HTTP carries no `link`, so no
   secret crosses the local network in clear. Nothing that reaches a worker's web port, from its LAN or from a page on
   its localhost, gets `peers`, `report` or `certificate` as the worker (ruling 17). Tests in Task 2 (`gives a worker
   its view and nothing of the data`, `leaves the link out of a renewal over plain HTTP`, `takes a peer's request only
   from its keeper`), Task 4 (`refuses the network routes at the worker's web port`), Task 6 (`writes a worker's
   settings without a company secret`) and Task 9.
4. A turn on a worker is never cut by the worker's update: one grant in the company at a time, given only while the
   worker's nodes run no turn and no test part; new turns, test parts and typed turns wait while it installs; the wait
   ends by itself 15 minutes after the grant, never extended, and at once when the install fails. Tests in Task 5
   (`lets one worker install at a time, between turns`, `holds turns on a worker while it installs`, the real
   races).
5. A server updated to this build stays one working machine, also when plan 5's updater runs the update and when it
   goes back to plan 5's build with a worker joined: the data services start, nothing asks for a secret it has not got,
   and the worker keeps working against the older server. Tests in Task 6 (`keeps every service for a server, and the
   data services out on a worker`, `keeps a server's data services`, `starts a worker's core alone`), Task 4 (`keeps
   working against a server of plan 5`) and Task 10's rehearsal.
6. A worker's pin comes only from its owner's command: never from a ticket of another person that failed (409
   `machine_taken`), from any answer of a server, or from a join command shown without the key; and a person's key
   reaches the server only wrapped, is taken only with their password and only while they have none, and is gone
   after a reset. Tests in Task 7 (`pins only from a redeemed ticket`, `keeps a person's key only wrapped, and only
   with their password`, `takes the key away on a reset`, `shows a join command only with the viewer's key`).

---

### Task 1: The tables for joined machines

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** main with plan 5 merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0050_machines_join.sql` (with its `meta` files)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/agent-sql.ts` (`HIDDEN`),
  `apps/server/src/modules/tools/database.ts` (`CLOSED`)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/orchestrator-control.test.ts`

**Interfaces:**
- Produces, in `db/schema.ts`:
  ```ts
  export const LINK_PATHS = ['direct', 'relay'] as const;
  export type LinkPath = (typeof LINK_PATHS)[number];
  export const UPDATE_STATES = ['ready', 'installing', 'failed'] as const;
  export type UpdateState = (typeof UPDATE_STATES)[number];
  // machines gains, with check('machines_path', sql`path IS NULL OR path IN ('direct', 'relay')`) and
  //   check('machines_update_state', sql`update_state IS NULL OR update_state IN ('ready', 'installing', 'failed')`):
  //   addresses: text('addresses').array().notNull().default(sql`'{}'::text[]`)   private IPv4 addresses it reported
  //   path: text('path', { enum: LINK_PATHS })            how the worker reaches the server now; null: it does not
  //   directFails: boolean('direct_fails').notNull().default(false)
  //   renewAt: timestamp('renew_at', { withTimezone: true })        the `at` of the last signed renewal taken
  //   updateCommit: text('update_commit')                 the commit the worker downloaded or installs
  //   updateState: text('update_state', { enum: UPDATE_STATES })
  //   goCommit: text('go_commit')                         the commit the server last let it install
  //   goAt: timestamp('go_at', { withTimezone: true })    when; that grant is good FOLLOW_TURN_MS from then
  //   failedCommit: text('failed_commit')                 the last commit whose install failed or ran out there
  //   failedAt: timestamp('failed_at', { withTimezone: true })
  export const machineTickets = pgTable('machine_tickets', {
    ticketHash: text('ticket_hash').primaryKey(),               // hashToken of the ticket
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  }).enableRLS();
  export const machineOnline = pgTable('machine_online', {
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    day: date('day', { mode: 'string' }).notNull(),             // UTC
    seconds: integer('seconds').notNull().default(0),
  }, t => [primaryKey({ columns: [t.machineId, t.day] }), check('machine_online_seconds', sql`seconds BETWEEN 0 AND 86400`)]).enableRLS();
  //   ownerPin: text('owner_pin')                         the print of the key its keeper pinned, as it reports it
  export const personKeys = pgTable('person_keys', {          // ruling 19
    personId: uuid('person_id').primaryKey().references(() => people.id),
    companyId: companyId(),
    publicKey: text('public_key').notNull(),                       // SPKI DER, base64url
    wrapped: text('wrapped').notNull(),                             // the pkcs8 private key under AES-GCM, base64url
    salt: text('salt').notNull(),
    iv: text('iv').notNull(),
    iterations: integer('iterations').notNull(),
    createdAt: createdAt(),
  }, () => [check('person_keys_iterations', sql`iterations >= 600000`)]).enableRLS();
  // nodeCodes gains core: boolean('core').notNull().default(false)   a command that brings the core to its machine
  // PEER_SECRET_KINDS becomes ['data', 'app', 'visit'], and the check peer_secrets_kind
  //   kind IN ('data', 'app', 'visit'); a visit row seals JSON { name, key }: the relay's visitor key for that link
  ```
  When the generated SQL lacks a check, `ENABLE ROW LEVEL SECURITY`, or the dropped and re-added
  `peer_secrets_kind`, the agent stops and reports.
- `HIDDEN` gains `'machine_tickets'`, `'machine_online'` and `'person_keys'`; `CLOSED`'s sentence adds "the machines'
  join tickets and online time, and people's keys".

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0050`, `adds what joined machines need, journaled and closed`: after migrating
    fully and `AFTER_MIGRATIONS`, `machines` has the new columns (`addresses` defaulting to `{}`), `node_codes.core`
    defaults to false, the three tables exist with a `net_journal` trigger and `relrowsecurity` true; `person_keys`
    refuses `iterations` 599999 with `23514`; `path` takes
    `direct`, `relay` and null and refuses `lan` with `23514`; `update_state` refuses `done` with `23514`;
    `machine_online.seconds` refuses `86401`; `peer_secrets` takes `visit` and refuses `x` with `23514`.
  - `orchestrator-control.test.ts`: the hidden-table cases gain the three tables; `stays out of the join tables when
    granted them`: with a row in each and the orchestrator's role granted `SELECT, INSERT, UPDATE, DELETE` on them, as
    plan 5's grant builder would after a downgrade, `SELECT` returns no row and `INSERT` fails with `42501`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name machines_join`, then `HIDDEN` and
  `CLOSED`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables joined machines need: tickets, online time, addresses, update state and
  people's keys".

### Task 2: The server's side of joining

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/network-join.test.ts test/network-routes.test.ts
test/nodes.test.ts test/link.test.ts test/auth.test.ts` passes, then the whole server suite; from the worktree root `npm
run test:real` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/join.ts`
- Modify: `apps/server/src/modules/network/routes.ts`, `apps/server/src/modules/network/store.ts`,
  `apps/server/src/modules/network/via.ts` (`keeperAsker`, ruling 17),
  `apps/server/src/modules/nodes/routes.ts` (`JoinBody`, the join answer, `POST /api/machines/:id/core`),
  `apps/server/src/modules/nodes/codes.ts` (`core`), `apps/server/src/modules/nodes/disconnect.ts`,
  `apps/server/src/errors.ts` (reasons), `apps/server/src/auth/tunnel.ts` (`clientAddress`)
- Test: `apps/server/test/network-join.test.ts` (new), `apps/server/test/network-routes.test.ts`,
  `apps/server/test/nodes.test.ts`, `apps/server/test/auth.test.ts`, `apps/server/test/real/network-races.test.ts`
  (new)

**Interfaces:**
- Consumes: Task 1's tables; plan 5's store, routes and `issueCertificate`; the relay client's `visitorKey(name, key)`
  (plan 1); `tunnelSettings(db, config)` (plan 2).
- Produces:
  ```ts
  // modules/network/join.ts
  export const TICKET_HOURS = 24;
  export const RENEW_WINDOW_MS = 5 * 60_000;
  export const ONLINE_STEP_S = 20;
  export function companyFolder(linkName: string | null, companyId: string): string;
  //   'hornhoof-' + linkName, else 'hornhoof-' + six letters a..z, one per byte of sha256(companyId) mod 26
  export function issueTicket(tx: Db, machineId: string, now?: Date): Promise<string>;   // 32 random bytes, base64url
  export const renewMessage = (machine: string, serial: string, at: string): string => `hornhoof-renew:${machine}:${serial}:${at}`;
  export const renewedMessage = (machine: string, serial: string, at: string, payload: string): string =>
    `hornhoof-renewed:${machine}:${serial}:${at}:${payload}`;
  export type Signed = { payload: string; signature: string };   // payload: JSON text; signature: base64 Ed25519
  export function signedAnswer(ctx: Ctx, ask: { machine: string; serial: string; at: string }, body: object): Promise<Signed>;
  //   JSON.stringify(body) signed by the authority's key over renewedMessage
  export function lockLiveMachine(tx: Db, machineId: string): Promise<typeof machines.$inferSelect | null>;
  //   SELECT ... FOR UPDATE; null for an unknown or revoked row
  export function revokeMachineRows(tx: Db, machineIds: string[], now: Date): Promise<void>;
  //   Disconnect's part of this plan, after its machines update in the same transaction (see below)
  export type DataMachine = { machine: string; networkId: string; hostname: string | null; addresses: string[]; peerPort: number | null; webPort: number | null };
  export type WorkerLink = { name: string; url: string; serverAddr: string; serverPort: number; appSecret: string; visitorKey: string };
  export type WorkerView = { machine: string; role: MachineRole; authorityPem: string | null; revoked: string[]; data: DataMachine[]; link: WorkerLink | null };
  export function workerView(ctx: Ctx, machineId: string): Promise<WorkerView>;
  //   data: the live rows of the role data with a network id (no server: row is ever dropped from it), hostname,
  //   addresses and ports from their reports; link null without a public link, without both of `app` secret and
  //   visitor key, or outside lead
  export function visitorKeyOf(ctx: Ctx, opts?: { force?: boolean }): Promise<string | null>;
  //   the stored key when its name is the link's; else, while leading, the relay's answer for the link's key, stored
  //   sealed as kind visit; one call at a time and, unless force, at most one a minute; a failure logged once and null
  export function dropPeerSecrets(tx: Db): Promise<void>;   // deletes the data, app and visit rows, nothing else
  export function countOnline(tx: Db, machineId: string, prevReportAt: Date | null, now?: Date): Promise<void>;
  //   adds ONLINE_STEP_S to today's row unless prevReportAt is within 15 s; seconds capped at 86400; rows older than
  //   8 days of this machine deleted
  export function onlineShare(db: Db, machineId: string, now?: Date): Promise<number | null>;
  //   ruling 12's window W = [max(now - 7 days, created_at), now]: the seconds of each UTC day inside W, the oldest
  //   day's times the share of that day inside W, summed, over W in seconds, clamped to 0..1; null when W is under a
  //   minute
  // errors.ts: ErrorReason gains 'ticket_used' | 'machine_taken' | 'renew_refused'
  // modules/network/via.ts
  export const KEEPER_MARK = 'x-hornhoof-keeper';   // '1', written only by the PeerDoor (Task 3)
  export function keeperAsker(req: FastifyRequest, config: Config): Promise<Asker | null>;
  //   askerOf's answer; for { own: false } only when the request carries KEEPER_MARK '1', else null
  ```
- `JoinBody` gains `core: z.boolean().default(false)`. When it is true and the join succeeds, the plain-text answer
  starts, before the node lines, with:
  - `build <tag> <app ref> <node ref> <updater ref>` only once Task 5 gives the server's build (none in this task);
  - `core-here <web port>` when `hashToken('hornhoof-host:' + machineId)` is `config.hostId` or `config.machineId`,
    the port being the `web_port` of the server's own row (`findThisMachine`), 8080 when none;
  - else `core <folder> <ticket> <web port> <company id>`: `companyFolder`, a ticket for the joined machine's row from
    `issueTicket` in the join's transaction, and the same port.
  A code with `core` set (ruling 14) must name a machine of its person (`other_machine` as today otherwise); its join
  answers these lines and no node line, and never `already_on_machine`. Without `core: true` nothing changes. The JSON
  answer gains `core: { folder, ticket, port, company } | { here: true, port } | null`.
- `POST /api/machines/:id/core`: the machine's owner only (403 `not_owner` otherwise), a live computer row; 409
  `conflict` 'This machine is a full machine of the company already.' (`core_present`) when it has a `network_id` or
  it is the server's own (by host id as above); else `createNodeCode` with `{ subscriptionIds: [], machineId,
  core: true }` and `commandFor`, answered as `POST /api/machines/:id/plans` answers.
- `POST /api/network/join`, taken from anyone (no `askerOf`), body `{ ticket: string (43), networkId: 32 or 64 hex,
  signKey: SPKI PEM up to 1024 }`: in one transaction, the ticket row `FOR UPDATE`, unused and unexpired, then its
  machine row by `lockLiveMachine` and its person active, else 410 `gone` 'This join ticket was used or has expired. Run
  the command from Hornhoof again.' (`ticket_used`); `networkId` must be `hashToken('hornhoof-host:' + machine_key)` of
  that row, and no other live row may hold it (a revoked one gives it up in the same transaction), else 409
  `machine_taken`, a unique violation (`23505`) on `network_id` included, never a 500; while not leading 503
  `unavailable`. It sets `used_at`, `network_id`, `role` `worker` and `sign_key`; when the row had another `sign_key` (a
  core installed again, with a new key), its earlier certificates are revoked in the same transaction. It issues a
  `worker` certificate with its `certificates` row and answers `{ machine, role, certPem, authorityPem, until, view:
  WorkerView }`.
- `POST /api/network/renew`, taken from anyone, body `{ machine: uuid, serial: hex, at: ISO, signature: base64 }`, in
  one transaction: `lockLiveMachine`; the row with a role and a `sign_key` that verifies the signature over
  `renewMessage`, `|now - at|` within `RENEW_WINDOW_MS` and `at` after `renew_at`; then `renew_at` is `at`, and a new
  certificate and its row, when one is due, in that transaction. A certificate is due only when `serial` is not a live,
  unexpired certificate of that machine or its `until` is within `CERT_DAYS - RENEW_AFTER_DAYS` days. The answer is 200
  `signedAnswer` of `{ machine, serial, at, role, authorityPem, certPem: string | null, until: string | null, view:
  WorkerView }`. A revoked row whose `sign_key` verifies the signature gets 410 `signedAnswer` of `{ disconnected: true
  }`; an unknown or role-less row 404 `not_a_machine`, and a bad signature or an old or repeated `at` 401
  `renew_refused` 'This renewal is not signed by the machine, or is too old.', both unsigned. The payload's `view` has
  no `link` key unless `cameOverHttps(req, config)`. While not leading, a renewal that needs a new certificate is 503;
  one that does not answers.
- Plan 5's `POST /api/network/certificate` issues only after `lockLiveMachine` in its transaction.
- Plan 5's `GET /api/network/peers`, `POST /api/network/report` and `POST /api/network/certificate` call `keeperAsker`
  in place of `askerOf`; null keeps plan 5's 403 `not_keeper`. `join` and `renew` call neither.
- `clientAddress(req, config)` (`auth/tunnel.ts`), before anything else: a request from the keeper's address
  (`fromTunnel`) whose `x-hornhoof-via` is a peer machine's id, not `keeper`, gives `peer:<that id>`. Plan 5's
  `PeerDoor` passes the worker's own `x-forwarded-for`, so a worker's owner could otherwise turn that header and get
  past the sign-in guard of `modules/auth/routes.ts`, which keys on email and `clientAddress`; every limiter keyed on
  `clientAddress` now counts a worker as one address. The forwarded value may still go into logs. The check reads the
  header and `fromTunnel` in `auth/tunnel.ts` itself, without importing `network/via.ts`, so no import cycle comes.
- `GET /api/network/peers` (plan 5) for a worker's `x-hornhoof-via` also carries `data` and the `link` of
  `workerView`; plan 5's own fields stay as they are, and a data machine's answer gains `data` alone.
- `POST /api/network/report` (plan 5) takes also `addresses` (at most 8 IPv4 strings, each private: 10/8, 172.16/12,
  192.168/16, or the documentation ranges and `127.0.0.1`, which only tests send), `hostname` (up to 120 of
  `[A-Za-z0-9._-]`, written only on a `server:` row), `path` (`direct`, `relay` or null) and `directFails` (boolean),
  and calls `countOnline` with the row's `report_at` before the update.
- `disconnectMachines` also, in its transaction and after its `machines` update, `revokeMachineRows`:
  `certificates.revoked_at` now for every unrevoked certificate of the machines, `network_id` null on those of the role
  `worker`, their unused tickets deleted, `used_at` now on their unused `node_codes`, and when any had a `network_id`,
  `dropPeerSecrets(tx)`; after it commits, `visitorKeyOf(ctx, { force: true })`, not awaited, a failure caught and
  logged. Nothing deletes a peer secret after the commit.

- [ ] **Step 1: Write failing tests** in `network-join.test.ts`, on `testApp({ TUNNEL_HOST: 'localhost',
  HORNHOOF_MACHINE_ID: <64 hex>, HORNHOOF_HOST_ID: <the same> })` with a company set up and the fake relay of
  `fake-relay.ts` answering `visitorKey`:
  - `answers a new installer with the core and a ticket`: `POST /api/machines/command`, then `/api/nodes/join` with
    `core: true` and `accept: text/plain` gives a first line `core hornhoof-<six letters> <43 characters> 8080 <company
    id>` and the machine node's line; with a link `acme` the folder is `hornhoof-acme`; without `core` the answer is
    exactly today's.
  - `tells the server's own computer by its host id`: a join whose `machineId` hashes to the host id gives `core-here
    8080` and no ticket row.
  - `joins once with a ticket`: the ticket from a join, posted to `/api/network/join` with a fresh key and a network id,
    gives a `worker` certificate for that row (`certFacts`), `issuedBy` the authority, and a view whose `data` names
    the server's row; the row has the network id, role and `sign_key`; the same ticket again is 410 `ticket_used`; an
    expired ticket, a ticket whose machine was disconnected, and one whose person was disabled are 410 and write
    nothing; a network id that is not the hash of the row's machine key is 409 `machine_taken` and writes nothing; a
    second ticket of the same row redeemed with a new key revokes the first certificate; a second person's row on the
    same computer gets 409 `machine_taken`, and after the first row's Disconnect its ticket joins.
  - `renews only with the machine's key, once per moment`: for the joined worker, a renewal signed by its key with its
    serial and `at` now answers `{ payload, signature }` whose signature verifies with the authority's public key over
    `renewedMessage` of that machine, serial and `at`, and whose payload has a view and `certPem: null`; with an
    unknown serial a certificate; signed by another key 401; `at` 6 minutes old 401; the same `at` twice, the second
    401; all three unsigned. After `POST /api/machines/<id>/disconnect`, 410 with a signed `{"disconnected":true}`; an
    unknown machine an unsigned 404.
  - `leaves the link out of a renewal over plain HTTP`: with a link, the same worker's renewal straight to the app has
    no `link` key in its signed payload's view, and one through `viaLink()` (`cameOverHttps` true) has the link with
    its `appSecret` and `visitorKey`.
  - Every case here and in plan 5's `network-routes.test.ts` that asks as a peer (`x-hornhoof-via: <machine id>`) also
    sends `x-hornhoof-keeper: 1`, as the `PeerDoor` writes it for a keeper's own request.
  - `takes a peer's request only from its keeper`: from the keeper's address, `GET /api/network/peers`, `POST
    /api/network/report` and `POST /api/network/certificate` with `x-hornhoof-via: <worker id>` and no mark each answer
    exactly what the same request with no via answers (403 `not_keeper`) and write nothing; with the mark they work;
    `join` and `renew` answer with no via at all.
  - `gives a worker its view and nothing of the data`: through `GET /api/network/peers` with `x-hornhoof-via: <worker
    id>` and a link: `link` has `name`, `url`, `serverAddr`, `serverPort`, an `appSecret` of 43 characters and the fake
    relay's `visitorKey`, no `dataSecret` and no `key`; the JSON holds none of `HORNHOOF_SECRET`, the link key or the
    `data` secret anywhere; outside `lead`, `link` is null.
  - `keeps the reported addresses and counts online time`: three reports 20 s apart (a fake clock) store `addresses`
    and `path`, and `machine_online` holds 60 s for today; a public address in `addresses` is 400; `hostname` lands on
    the `server:` row and not on a worker's.
  - `counts the online share over one window`: a row created 8 days ago with `machine_online` full (86400) for each
    day: `onlineShare` at 00:05 UTC and at 12:00 UTC is within 0.01 of 1; a row created 30 minutes ago with 1800 s
    today gives 1, and with 2000 s still 1; one created 20 s ago gives null.
  - `cuts a disconnected machine off`: a joined worker with two certificates, an unused ticket and an unused command
    from `POST /api/machines/<id>/core`; a `visitorKey` call 10 s before; Disconnect revokes both serials (in the next
    `revoked`), clears its `network_id`, deletes the ticket and the three peer secrets, the command then joins as a
    used code does today, and the fake relay got a second `visitorKey` call; a `data` and an `app` secret made by
    `peerSecret` right after the Disconnect are still there once that call has ended; the worker's `GET
    /api/network/peers` and `POST /api/network/certificate` answer 404.
  - `offers the core to a machine that has none`: the owner's `POST /api/machines/<id>/core` gives a command; its join
    with `core: true` answers a `core` line and no node line and never `already_on_machine`; a second person's call is
    403; for a machine with a `network_id` 409 `core_present`.
  - `auth.test.ts`, `counts sign-ins through a worker as one address`: on `testApp({ TUNNEL_HOST: '192.0.2.10' })`, 10
    failed sign-ins from `192.0.2.10` with `x-hornhoof-via: <a worker's id>`, each with another `x-forwarded-for`,
    then the right password with an eleventh one: 429 `too_many_attempts`, as 10 from one address; the same email
    through another worker's id is not held by it.
  - `real/network-races.test.ts`, on a `realDatabase()` migrated with `migrateDb` and two `openDb` connections to it,
    with a worker row and its certificate: two transactions that each `lockLiveMachine` and claim the same `at` as
    `renew_at`, started together, leave one claim; a transaction that `lockLiveMachine`s, waits 200 ms and inserts a
    certificate row, while a second one updates the row's `revoked_at` and runs `revokeMachineRows`, leaves no
    unrevoked certificate of the row; with the Disconnect first, `lockLiveMachine` gives null; two joins of one ticket
    at once give one certificate and one 410.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let a joined machine take its core with a one-use ticket, renew by its key, and be cut off
  by Disconnect".

### Task 3: The peer link from a worker

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/peer-link.test.ts test/visit-client.test.ts
test/proxy.test.ts test/peer-server.test.ts` passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/net/peer-link.ts`, `apps/server/src/modules/link/visit-client.ts`
- Modify: `apps/server/src/net/proxy.ts` (`PassOptions.connect`), `apps/server/src/net/peer-door.ts` (plan 5's: the
  keeper's mark)
- Test: `apps/server/test/peer-link.test.ts`, `apps/server/test/visit-client.test.ts` (new),
  `apps/server/test/proxy.test.ts`, `apps/server/test/peer-server.test.ts` (plan 5's)

**Interfaces:**
- Consumes: `PeerServer`, `PEER_PATHS`, `APP_AUTHORITY` (plan 5, in tests and for the authority); `certFacts`;
  `HeldCertificate`, `MachineKey`; `Client` and the link frpc's head of `configFor` (plan 2).
- Produces:
  ```ts
  // net/proxy.ts: PassOptions gains connect?: (req: http.IncomingMessage) => Promise<Duplex>; with it, target is
  //   not used and may be left out; a rejected connect counts as an unreachable target, held as holdMs says
  // net/peer-link.ts
  export type DialTarget = { machine: string; networkId: string; addresses: string[]; peerPort: number | null; relayPort: number | null };
  //   machine: the row's uuid, which the certificate names; networkId: its keeper's id, which the relay's names use
  export type Hello = { machine: string; role: MachineRole; lead: boolean; commit: string; seen: string };
  export type PeerLinkOptions = {
    held: () => HeldCertificate | null;
    key: MachineKey;
    revoked: () => ReadonlySet<string>;
    own: () => string[];                // this machine's addresses, for the shared /24 rule
    log: (line: string) => void;
    connectMs?: number;                 // 3000, per address
    everyMs?: number;                   // 5000: sessions looked after
    helloMs?: number;                   // 10_000
    directEveryMs?: number;             // 60_000: direct tried again while on the relay
    pingMs?: number;                    // 15_000; a ping not answered in 10 s ends the session
  };
  export class PeerLink {
    constructor(opts: PeerLinkOptions);
    use(targets: DialTarget[]): void;                 // the data machines to keep sessions to, from the last view
    leader(): { machine: string; path: LinkPath; hello: Hello } | null;   // the first target whose hello says lead
    seen(): string[];                                 // what hellos said this machine was seen as
    state(): { path: LinkPath | null; directFails: boolean; refused: boolean };
    //   refused: since the last session, a data machine ended a handshake with an alert about this machine's
    //   certificate (an error code matching /ALERT_(BAD_CERTIFICATE|CERTIFICATE_|UNKNOWN_CA)/)
    connectApp(): Promise<Duplex>;                    // CONNECT app:8080 on the leader's session; 200 or it rejects
    request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
    //   one HTTP/1.1 request over connectApp(), JSON both ways, 10 s, with x-hornhoof-via: keeper (ruling 17)
    close(): Promise<void>;
  }
  // modules/link/visit-client.ts
  export const visitClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-visit`;
  export const VISIT_FIRST_PORT = 7090;               // target i listens on 127.0.0.1:7090 + i in the keeper
  export type VisitSettings = { name: string; serverAddr: string; serverPort: number; visitorKey: string; appSecret: string };
  export function visitConfigFor(s: VisitSettings, opts: { machineId: string; targets: string[] }): string;
  //   machineId: this keeper's network id; targets: the data machines' network ids
  export function visitClientFor(s: VisitSettings, opts: { machineId: string; targets: string[]; dir?: string }): Client;
  //   its config is <dir ?? tmpdir()>/frpc-visit.toml, 0600
  ```
- A session is `http2.connect` over `tls.connect` with the held certificate and key, `ca` the held `authorityPem`,
  `minVersion: 'TLSv1.3'`, `ALPNProtocols: ['h2']`, `settings.initialWindowSize` 1 MiB, and `checkServerIdentity`
  returning an error unless `certFacts` of the server's certificate names the target's `machine`, the role `data`, and
  a serial not in `revoked()`. Node 22 hands `checkServerIdentity` a `PeerCertificate`; its PEM is `new
  X509Certificate(cert.raw).toString()`. Direct: the target's addresses in order, at `peerPort`; else the relay at
  `127.0.0.1:relayPort` when set. `directFails` is true while the session is on the relay and the last try of an
  address sharing a `/24` with one of `own()` failed. Every `helloMs` a `GET
  /peer/hello` on each session updates its hello.
- `visitConfigFor`, exactly, with the link frpc's head of plan 2 (`serverAddr` to `transport.tcpMuxKeepaliveInterval`)
  and then:
  ```toml
  clientID = "<name>-<machine8>-visit"
  metadatas.name = "<name>"
  metadatas.visitor = "<visitor key>"
  metadatas.client = "<name>-<machine8>-visit"

  [[visitors]]
  name = "<name>-<machine8>-to-<target8>"
  type = "stcp"
  serverName = "<name>-<target8>-app"
  secretKey = "<app secret>"
  bindAddr = "127.0.0.1"
  bindPort = <7090 + i>
  ```
  one `[[visitors]]` block per target, in order; `clientID` in place of the head's, and no `metadatas.key`.

- [ ] **Step 1: Write failing tests.**
  - `visit-client.test.ts`: the exact config for `acme`, machine (network id) `ab12cd34` and 56 more hex digits, one
    target network id `77aa0011...`, a visitor key and a secret of 43 characters; two targets give ports 7090 and 7091;
    the file is `frpc-visit.toml` with mode `0600`, and no `metadatas.key` line.
  - `proxy.test.ts`, `passes a request through a stream it is given`: `passThrough({ connect, ... })` with a `connect`
    that opens a TCP connection to an echo server answers the echo; a `connect` that rejects twice and then connects,
    with `holdMs` 2000, answers once it connects.
  - `peer-link.test.ts`, with a test authority (plan 5), a `PeerServer` of a `data` machine on `127.0.0.1:0` whose app
    door reaches an echo app, and a worker's certificate and key:
    - `reaches the leader directly and passes requests`: `use([{ machine, addresses: ['127.0.0.1'], peerPort, relayPort:
      null }])`; within 2 s `leader()` names it with path `direct`; `request('GET', '/api/health')` answers the echo's
      200; `seen()` holds `127.0.0.1`.
    - `takes the relay when direct does not answer`: addresses `['192.0.2.1']` (nothing answers, `connectMs` 200) and
      `relayPort` the server's app door port: path `relay`; with `own()` `['192.0.2.9']`, `directFails` is true; with
      `own()` `['198.51.100.9']` it is false (the address failed, but it is not on the worker's network).
    - `trusts only the machine it dialed`: a server certificate of another `data` machine, of the role `worker`, or on
      `revoked()` gives no session and no `leader()`.
    - `follows the hello`: a server whose `hello` says `lead: false` is no leader; once it says true, it is within 1 s.
    - `ends a session that stops answering`: with `pingMs` 100, closing the server's socket without a goodbye leaves
      `leader()` null within 1 s.
    - `tells when the data machine refuses its certificate`: the worker's serial on the server's list (plan 5's peer
      server): no session, and `state().refused` is true within 1 s; a session that comes later sets it false.
    - `sends the keeper's own requests as the keeper`: the echo app sees `x-hornhoof-via: <the worker's machine>` and
      `x-hornhoof-keeper: 1` on a `request(...)`; a request piped through `connectApp()` with no via of its own reaches
      it with the via and no mark.
  - `peer-server.test.ts`, `marks only the keeper's own requests`: plan 5's `PeerDoor` with `headers(req)` adding
    `x-hornhoof-keeper: 1` only when the incoming request carried `x-hornhoof-via: keeper`, read before `passThrough`
    drops it: a request with it reaches the echo with the via and the mark; one without it, and one with only its own
    `x-hornhoof-keeper: 1`, reach it with the via and no mark.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Dial the company's data machines from a worker, directly or through the relay, and pass
  requests to the leader's app".

### Task 4: The worker's keeper

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/worker-keeper.test.ts test/addresses.test.ts
test/keeper.test.ts test/keeper-peer.test.ts test/config.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/worker.ts`, `apps/server/src/modules/keeper/worker-config.ts`,
  `apps/server/src/modules/keeper/worker-pages.ts`, `apps/server/src/modules/keeper/addresses.ts`
- Modify: `apps/server/src/keeper.ts` (the role), `apps/server/src/modules/keeper/keeper.ts` (the data keeper's report
  gains `addresses` and `hostname`), `apps/server/src/config.ts` (an empty `HORNHOOF_SECRET` refused with a clear line)
- Test: `apps/server/test/worker-keeper.test.ts`, `apps/server/test/addresses.test.ts` (new),
  `apps/server/test/keeper.test.ts`, `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `PeerLink`, `visitClientFor` (Task 3); `CertificateKeeper`, `machineKey`, `Measures` (plan 5); the routes of
  Task 2; `passThrough`, `serve`, `KEEPER_HOLD_MS`, `heldAnswer`, `updaterBusy` (plans 2 and 4).
- Produces:
  ```ts
  // modules/keeper/worker-config.ts
  export type WorkerConfig = {
    machineId: string; joinServer: string; ticket: string | null; controlDir: string; dir: string;
    commit: string; ports: { web: number | null; peer: number | null }; addresses: string[]; hostname: string | null;
    ownerKey: string | null;   // HORNHOOF_OWNER_KEY, ruling 18: 80 to 200 of [A-Za-z0-9_-], else null and one log line
  };
  export function workerConfig(env: NodeJS.ProcessEnv): WorkerConfig;
  //   HORNHOOF_MACHINE_ID (32 or 64 hex) and HORNHOOF_JOIN_SERVER (an http or https URL) required, each with a line
  //   saying to run the join command again; HORNHOOF_JOIN_TICKET, HORNHOOF_ADDRESSES (comma separated),
  //   HORNHOOF_HOSTNAME, HORNHOOF_PORT, HORNHOOF_PEER_PORT optional; dir KEEPER_DIR, controlDir HORNHOOF_CONTROL_DIR or
  //   /control; reads no HORNHOOF_SECRET, NODE_KEY or DATABASE_URL
  // modules/keeper/addresses.ts
  export const ADDRESSES_FILE = 'addresses.json';     // { at: seconds, addresses: string[] }, written by the updater
  export function isPrivate(address: string): boolean;   // the ranges of Task 2's report rule
  export function ownAddresses(opts: { controlDir: string; env: string[]; seen: string[]; now?: Date }): string[];
  //   the file's when `at` is within 5 minutes, then env, then seen; private IPv4 only, no loopback, unique, at most 8
  // modules/keeper/worker-pages.ts
  export function noLeaderAnswer(req: http.IncomingMessage, view: { data: DataMachine[]; linkUrl: string | null }): Refusal;
  export function disconnectedAnswer(req: http.IncomingMessage): Refusal;
  // modules/keeper/worker.ts
  export const PEERS_FILE = 'peers.json';             // the last WorkerView, 0600
  export const NO_LEADER_PAGE_MS = 60_000;
  export type WorkerStatus = { role: 'worker'; commit: string; machine: string | null; certificate: boolean;
    leader: { machine: string; hostname: string | null; path: LinkPath } | null; disconnected: boolean };
  export class WorkerKeeper {
    constructor(opts: { config: WorkerConfig; frontHost: string; host?: string; ports?: { front?: number };
      log: (line: string) => void; now?: () => Date; fetch?: typeof fetch;
      visitClientFor?: (s: VisitSettings, machineId: string, targets: string[]) => Client; visitPort?: number;
      viewEveryMs?: number; reportEveryMs?: number; renewAfterMs?: number; renewEveryMs?: number;
      noLeaderPageMs?: number; certificate?: { retryMs?: number } });
    //   visitPort VISIT_FIRST_PORT, viewEveryMs 30_000, reportEveryMs 20_000, renewAfterMs 10_000, renewEveryMs
    //   30_000, noLeaderPageMs NO_LEADER_PAGE_MS
    start(): Promise<{ front: number }>;
    status(): WorkerStatus;
    stop(): Promise<void>;
  }
  ```
- The worker keeper, in order of what it needs:
  - Its key by `machineKey(dir)`; a `CertificateKeeper` whose `ask` is: with a ticket it has not redeemed (its hash is
    not the one in `<dir>/ticket.json`), `POST <joinServer>/api/network/join` (`{ ticket, networkId: machineId, signKey
    }`), then that hash saved; else `POST /api/network/certificate` through `PeerLink.request`. A 409 `machine_taken`
    is one log line, and the keeper keeps what it holds.
  - A renewal (ruling 7), apart from `ask`: at once when `PeerLink.state().refused` or the held certificate has expired,
    after `renewAfterMs` with no session to any data machine, then every `renewEveryMs` while there is none; to the join
    server, then to the cached link's `url` when it is https and not the join server, then to
    `http://<address>:<webPort>` of each data machine, a 200 or a signed 410 ending the round. An answer counts only
    when its `signature` verifies with the held authority's public key over `renewedMessage` of this request's machine,
    serial and `at`, and its payload's `authorityPem` is the held one; its certificate, when it has one, is taken only
    when `issuedBy` the held authority and naming this machine and this key; its `revoked` is added to the held list,
    which it never shrinks; its view is merged as below. Anything else, an unsigned 404 or 401 included, is a failed
    renewal, one log line per hour at most.
  - `disconnected` is set only by a signed 410 renewal answer, a 410 `ticket_used` from the join while holding no
    certificate, or a 404 with the reason `not_a_machine` through the peer link. Then it stops its visitor frpc and its
    sessions, asks nothing more until it starts again, and logs one line.
  - Its view: from `peers.json` at start, then every `viewEveryMs` `GET /api/network/peers` through the link, or a
    renewal's. An answer is merged into the cached view field by field: a field the answer lacks keeps its cached
    value (a server of plan 5 answers no `data` and a `link` without `url`, `serverAddr`, `serverPort` or
    `visitorKey`), and `build` and `go` are null when it lacks them. Each merged view is written to `peers.json` and
    given to `PeerLink.use` (targets carry `machine` and `networkId`), each target's `relayPort` `visitPort + i` when
    `link` is set. Its `revoked` is `PeerLink`'s `revoked()`.
  - A visitor frpc child, through plan 2's `TunnelKeeper` (`restartMs` 2000, `everyMs` 3000), whose `read` answers
    the view's link as `VisitSettings` and the data machines as targets, `null` without a link, `undefined` before any
    view.
  - Every `reportEveryMs`, through the link, `POST /api/network/report` with `Measures.snapshot()`, `commit`, the ports,
    `addresses: ownAddresses(...)` with `PeerLink.seen()`, and `PeerLink.state()`; a failure is one log line per hour
    at most.
  - The front door on `KEEPER_PORTS.front`, `serve(passThrough(...))` with `connect: () => link.connectApp()`, the
    headers of plan 2's front door and plan 4's `x-hornhoof-invocation` from `front`, `holdMs: KEEPER_HOLD_MS`, and
    `holding`: while `disconnected`, `disconnectedAnswer`; while `updaterBusy` says maintenance, plan 2's maintenance
    answer; with no leader for `noLeaderPageMs` and a page request (`GET` or `HEAD`, `accept` with `text/html`, a
    path not under `/api/` or `/mcp`), `noLeaderAnswer` at once; `held`: `noLeaderAnswer` for a page request,
    `heldAnswer` otherwise. `GET /api/keeper` is answered by the keeper itself with `status()` as JSON and never passed.
  - It writes no `keeper.json`, holds no lease and runs no link or peer server.
- The pages: `text/html; charset=utf-8`, no script, a `<meta http-equiv="refresh" content="15">`. `noLeaderAnswer`: 503
  with `Retry-After: 15`; under `/api/` and `/mcp` the JSON `{"error":{"code":"unavailable","message":"This machine
  cannot reach the company server now.","reason":"no_leader"}}`; a page with "This machine cannot reach the company
  server. Open the company on a machine that keeps its data:" / «Эта машина не может связаться с сервером компании.
  Откройте компанию на машине, где хранятся ее данные:», one item per data machine `<hostname or "the company
  server">: localhost:<webPort>` / `<hostname или «сервер компании»>: localhost:<webPort>`, then "or at <link url>." /
  «или по адресу <link url>.» when there is a link, every value HTML-escaped. `disconnectedAnswer`: 410 with the reason
  `disconnected` under `/api/` and `/mcp`, and "This machine was disconnected from the company. To connect it again,
  get a new command in Hornhoof under Machines and run it here." / «Эту машину отключили от компании. Чтобы подключить
  ее снова, возьмите новую команду в Hornhoof в разделе «Машины» и выполните ее здесь.»
- `keeper.ts`: `HORNHOOF_ROLE` `worker` runs `new WorkerKeeper({ config: workerConfig(process.env), frontHost: 'front',
  ... })`; anything else runs plan 5's keeper as it is, whose report gains `addresses` (`ownAddresses` with
  `HORNHOOF_ADDRESSES`) and `hostname` (`HORNHOOF_HOSTNAME`), and which takes a test option `reportAs?: () => {
  addresses: string[]; peerPort: number; webPort: number }` that its report sends in place of its own. `loadConfig`
  throws `HORNHOOF_SECRET is empty. Put the company's secret into .env, or run the install command again.` for an empty
  secret, and `NODE_KEY is empty. Put the company's node key into .env, or run the install command again.` for a
  `NODE_KEY` that is set and empty (compose now passes both empty when `.env` lacks them, ruling 2); an unset `NODE_KEY`
  stays accepted as today.

- [ ] **Step 1: Write failing tests.**
  - `addresses.test.ts`: `ownAddresses` keeps a fresh file's `192.168.1.5`, drops a file 6 minutes old, adds env's and
    `seen`'s, drops `127.0.0.1`, `8.8.8.8` and a duplicate, and stops at 8.
  - `worker-keeper.test.ts`, with a server app `testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID })` on
    `127.0.0.1:0` behind plan 5's keeper (peer ports 0, `reportAs` giving `127.0.0.1`, its bound peer port and the
    app's port) as the join server and the data machine, a machine joined through `/api/nodes/join` with `core: true`
    for the ticket, and a `WorkerKeeper` on temp folders whose `joinServer` is the app's address and whose
    `HORNHOOF_MACHINE_ID` is the hash of that machine's key:
    - `joins with its ticket and serves the company on its front door`: within 5 s `status()` has `certificate: true`
      and a leader on `direct`; `GET /api/health` through its front door answers the server's commit; a sign-in through
      it sets `hh_session`, and a `POST` with `origin` the front door's own address passes the app's origin check.
    - `reports its machine`: within 2 s more, the worker's row has `report_at`, `path` `direct` and `addresses`.
    - `answers its own status, and never passes it`: `GET /api/keeper` is `status()`, and the app saw no such request.
    - `keeps the network across a restart without the server`: stopped, the server stopped, started again on the
      same folders, `noLeaderPageMs` 100: `status()` has `certificate: true`, a page request after 100 ms gets the
      no-leader page naming `localhost:<the server's web port>`, an API call gets 503 `no_leader`.
    - `renews by its key when its certificate has expired`: a held certificate issued 31 days ago: the keeper gets a new
      one through `/api/network/renew`, and the server's peer port takes it.
    - `takes new secrets by renewal`: a keeper on the relay path (a free `visitPort`, a fake `visitClientFor` whose
      client forwards that port to the server's app door only while its config's `appSecret` is the server's current
      one, and data machine addresses that do not answer), with its default timings and a test timeout of 60 s; after
      `dropPeerSecrets` and the server keeper's new secrets it loses its session, renews within 15 s of that, and its
      next visitor config has the new `appSecret` and works again.
    - `stops at disconnect and says so`: after Disconnect, within 6 s the session is closed, within 5 s more
      `status().disconnected` is true (the refused handshake renews at once), a page request gets
      `disconnectedAnswer`, and it makes no request in the next second.
    - `refuses the network routes at the worker's web port`: through the worker's front door, once with
      `x-forwarded-for: 192.0.2.7` from `front` (a LAN neighbor) and once with `origin: http://localhost:<its port>` (a
      page on its localhost), `GET /api/network/peers`, `POST /api/network/report` and `POST
      /api/network/certificate` each answer 403 `not_keeper`, the same answer as a request with no via, also when they
      send `x-hornhoof-via: keeper` and `x-hornhoof-keeper: 1` themselves; the keeper's own `PeerLink.request` of each
      works meanwhile.
    - `drops a renewal answer it cannot trust`: with an expired certificate and a `fetch` that answers the renewal
      first with a changed view signed by another key, then an unsigned 404, then an unsigned 410: the keeper keeps
      its cached view and its certificate, `disconnected` stays false, and `revoked` never loses a serial.
    - `keeps working against a server of plan 5`: a `PeerServer` of a data machine (plan 5) whose app door reaches a
      small HTTP server answering `GET /api/network/peers` in plan 5's shape and `POST /api/network/renew` with an
      unsigned 404: the cached `data` and visitor key stay, the leader stays on `direct`, no `request.json` is
      written, and `disconnected` stays false.
  - `keeper.test.ts`, `reports its addresses and its host's name`: a data keeper with `HORNHOOF_ADDRESSES` `192.0.2.4`
    and `HORNHOOF_HOSTNAME` `deb`: the `server:` row gets both.
  - `config.test.ts`: an empty `HORNHOOF_SECRET` throws the line above, and so does a `NODE_KEY` set to `''`, while an
    unset one passes; `workerConfig` without `HORNHOOF_JOIN_SERVER` throws, and with only the worker's lines reads no
    secret; its `ownerKey` is a valid `HORNHOOF_OWNER_KEY`, and null for none or one with `$`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run a worker's keeper: join with the ticket, reach the leader, serve its machine's localhost,
  and say where the company is when it cannot".

### Task 5: Workers follow the server's build, and addresses from the updater

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/follow.test.ts test/updater.test.ts
test/updates.test.ts test/worker-keeper.test.ts test/keeper.test.ts test/conversation.test.ts test/test-runs.test.ts`
passes, then the whole server suite; from the worktree root `npm run test:real` passes; `bash -n` and `shellcheck` on
`apps/updater/updater.sh` print nothing; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/follow.ts`
- Modify: `apps/server/src/modules/updates/registry.ts` (`find`), `apps/server/src/modules/updates/check.ts`
  (`UpdateCheck.find`), `apps/server/src/modules/updates/control.ts` (`wait`), `apps/server/src/modules/network/join.ts`
  and `routes.ts` (the view's `build` and `go`, the report's `update`, the join answer's `build` line),
  `apps/server/src/modules/conversation/queue.ts` (the hold in `take` and `openTypedTurn`),
  `apps/server/src/modules/testruns/runs.ts` (the hold in `giveOut`), `apps/server/src/modules/keeper/worker.ts`
  (following), the keeper's `updaterBusy` (a `wait` step is not busy), `apps/updater/updater.sh`,
  `apps/server/test/updater-stubs/`
- Test: `apps/server/test/follow.test.ts` (new), `apps/server/test/updater.test.ts`, `apps/server/test/updates.test.ts`,
  `apps/server/test/worker-keeper.test.ts`, `apps/server/test/keeper.test.ts`, `apps/server/test/test-runs.test.ts`,
  `apps/server/test/real/follow-races.test.ts` (new)

**Interfaces:**
- Consumes: `UpdateCheck`, `registry()`, `UpdaterStatus`, `requestFor`'s tag rule (a full commit's tag); Task 2's view,
  report and `lockLiveMachine`; Task 4's keeper; the queue's `take`, `openTypedTurn`, `pumpWaiting` and its own timed
  pump; `giveOut` and `pumpTests`; `jobs.node_id` to `nodes.machine_id`, and `test_parts.machine_id`.
- Produces:
  ```ts
  // modules/updates/registry.ts: Registry gains
  //   find(tag: string): Promise<Build | null>;   // the build of that tag, null when the registry has none (404)
  // modules/updates/check.ts: UpdateCheck gains find(tag: string): Promise<Build | null>, its registry's, as the other
  //   readers of its private registry go through it
  // modules/updates/control.ts: UpdaterStatus.step gains 'wait'
  // modules/network/follow.ts
  export type LeaderBuild = { version: string; tag: string; digest: string; nodeDigest: string; updaterDigest: string; commit: string };
  export type Go = { commit: string; until: string };   // until: ISO, go_at + FOLLOW_TURN_MS
  export const FOLLOW_TURN_MS = 15 * 60_000;
  export const FOLLOW_RETRY_MS = 6 * 3_600_000;
  export const FOLLOW_LOCK = 0x68686677;              // pg_advisory_xact_lock key of the grants
  export function leaderBuild(ctx: Ctx): Promise<LeaderBuild | null>;
  //   only for a config.commit of 40 hex: UpdateCheck find(commit) and siblings(commit), both digests present; kept
  //   10 minutes, a failure kept 1 minute as null
  export function goodGrant(row: Pick<typeof machines.$inferSelect, 'commit' | 'goCommit' | 'goAt' | 'failedCommit' | 'failedAt'>, now: Date): boolean;
  //   go_commit set, go_at within FOLLOW_TURN_MS, commit not go_commit, and no failed_at after go_at for go_commit
  export function tryGrant(tx: Db, machineId: string, build: LeaderBuild, now: Date): Promise<boolean>;
  export function followOf(ctx: Ctx, machineId: string, now?: Date): Promise<{ build: LeaderBuild | null; go: Go | null }>;
  export function holdsMachine(tx: Db, nodeId: string | null, now?: Date): Promise<boolean>;
  //   locks the node's machine row FOR SHARE and answers goodGrant of it; false for no node or a node with no machine
  // WorkerView gains build: LeaderBuild | null and go: Go | null; a renewal's view has both null
  // the report gains update: { commit: string; state: UpdateState } | null, stored as update_commit and update_state;
  //   one with state failed for go_commit, or for the build, also sets failed_commit and failed_at
  ```
- `followOf` for a live worker row W, with B the server's build:
  - no B, or W's `commit` is B's: `{ build: null, go: null }`;
  - else `build: B`, and `go` is W's grant when `goodGrant` holds for B's commit, the same `until` each time, never
    extended; else `tryGrant`.
  - `tryGrant`, in one transaction: `pg_advisory_xact_lock(FOLLOW_LOCK)`, then W's row `FOR UPDATE`, then it grants
    only when W's `update_commit` is B's with state `ready`; no live worker has a `goodGrant`; W's last grant for B's
    commit, if any, is older than `FOLLOW_RETRY_MS` (a grant that ran out counts as failed), and so is a `failed_at`
    of W for it; no job is `running` on a node of W and no `test_parts` row is `running` with W's `machine_id`; the app
    leads and its updater is not running. Then `go_commit` is B's commit and `go_at` now, and a timer at the grant's
    end calls `pumpWaiting(ctx)` and `pumpTests(ctx)`.
  - A report whose `commit` is now `go_commit`, or whose `update` is `failed` for it, ends the grant and calls
    `pumpWaiting(ctx)` and `pumpTests(ctx)`.
- The hold, at every place work is claimed: `take`'s transaction asks `holdsMachine(tx, sending.nodeId)` before it marks
  the job running, and a held turn is not taken and waits; `giveOut` claims a part in a transaction that asks
  `holdsMachine` for the place's `nodeId` first (a `builtin` place is never held); `openTypedTurn` answers null while
  `holdsMachine` holds its node, as while a turn runs. Taking a lock `FOR SHARE` there and `FOR UPDATE` in `tryGrant`
  is what keeps a grant and a claim from crossing.
- The join answer's first line, when `leaderBuild` gives B: `build <B.tag> <config.image>@<B.digest>
  <config.image>-node@<B.nodeDigest> <config.image>-updater@<B.updaterDigest>`.
- The worker keeper keeps its request in `<dir>/follow.json` (`{ id, tag, at }`) and reads `/control/status.json` only
  when its `id` is that request's. When its view has `build` B and its request is for another tag, or there is none, it
  writes `/control/request.json` `{ id, version, tag, digest, nodeDigest, updaterDigest }` with a new uuid (whole, then
  moved) unless the updater runs a request in step `install`, `health` or `rollback`; a request in `pull` or `wait` is
  replaced so. For B's tag whose request `failed` or `rolled_back`, it writes a new one only after `FOLLOW_RETRY_MS`.
  It reports `update` from its request's status: `{ commit: tag, state: 'ready' }` while `running` in step `wait`,
  `installing` in `install` or `health`, `failed` once `failed` or `rolled_back`, null otherwise. When the view's `go`
  names its request's tag and `/control/go.json` does not hold that grant, it writes `/control/go.json` `{ id, commit,
  until }` (`until` in seconds since 1970), whole, then moved.
- `updater.sh` with `HORNHOOF_ROLE=worker` (from `.env` through compose, Task 6): `update` makes no backup and reads
  no migrations; `unpack` also takes `/app/compose.worker.yaml`, and `pull_images`, `services_without_node` and plan 2's
  `remove_unnamed` read the build's `-f compose.yaml -f compose.worker.yaml`. After the downloads (the app image,
  `compose pull` of the worker's services, and the node image by its digest) it removes `/control/go.json`, then is
  `step wait "Waiting for its turn to install."` until `go.json` has its id, its tag as `commit` and an `until` after
  now (then on to install), `request.json` names another id (`stop_with failed "A newer build came first, so this one
  was left."`), or 24 hours pass (`stop_with failed "The company server did not give this machine its turn within a
  day."`). `install` runs the build's `install.sh worker` with `HORNHOOF_COMPOSE_FILE` the unpacked `compose.yaml`;
  `PREVIOUS` and `BACK_APP` come from the running `keeper` container; health is `HORNHOOF_HEALTH_URL` (the keeper's
  `/api/keeper`, whose `commit` it reads as today); `swap_updater` runs only after health, as on a server; `go_back`
  restores nothing; `drop_orphans` runs `up -d --no-build --remove-orphans keeper`. An updater stopped in `wait` starts
  the request over.
  With `HORNHOOF_HOST_OS=linux`, whatever the role, once a minute: `docker run --rm --network host --entrypoint ip
  "$COMPUTER_IMAGE" -4 -o addr show scope global`, the addresses of interfaces whose names do not start with `docker`,
  `br-`, `veth` or `virbr`, written to `/control/addresses.json` whole and then moved; a failure leaves the file.
- The keeper's `updaterBusy` (plan 2) reads `running` with step `wait` as not busy, as `pull`.

- [ ] **Step 1: Write failing tests.**
  - `follow.test.ts`, with a fake registry (`find` and `siblings`) and `HORNHOOF_COMMIT` 40 hex:
    - `knows its own build by its commit`: `leaderBuild` gives the digests; with `find` null, null; a commit `local`,
      null without asking the registry.
    - `lets one worker install at a time, between turns`: workers W1 and W2 on an older commit, both reported `update:
      { commit: B, state: 'ready' }`: W1's view has `go`, W2's has `build` and no `go`; once W1 reports commit B, W2's
      next view has `go`; with a running job on a node of W2, or a running test part on W2, no `go` until it ends.
    - `never extends a grant, and remembers a failure`: W's views every minute for 20 minutes (fake clock) carry the
      same `until` and none after 15 minutes; then no `go` for B for 6 hours, then one; W reporting `failed` ends its
      grant at once, a second worker gets `go` on its next view, and W reporting `ready` again gets no `go` for B for 6
      hours.
    - `holds turns on a worker while it installs`: an agent on a node of W, a queued turn, a queued test part whose only
      place is W, and the agent's program open there: after W got `go` the turn and the part do not start and
      `openTypedTurn` on W's node answers null; they start when W reports B, and by themselves 15 minutes after `go`
      (fake clock); a report `failed` lets them start at once.
    - `answers the join with the build`: the plain-text join with `core: true` starts with the `build` line above.
    - `keeps the build out of a renewal`: a renewal's signed view has `build` and `go` null while the peers view has
      both.
  - `real/follow-races.test.ts`, on a `realDatabase()` migrated with `migrateDb` and two `openDb` connections to it:
    `tryGrant` for W1 and for W2, started together, grant one; a transaction that asks `holdsMachine` for W's node,
    waits 200 ms and marks a job on it `running`, with `tryGrant` for W started during the wait, ends with the job
    running and no grant; with `tryGrant` first, `holdsMachine` answers true.
  - `worker-keeper.test.ts`, `downloads the server's build and installs when told`: a view with `build`: one
    `request.json` with its digests; `status.json` `running`/`wait` of that id makes the next report `ready`, and of
    another id no report; a view with `go` writes `go.json` with that id, the tag and `until`; a second view with the
    same build writes no second request; a view with build B2 while B1's request waits writes a request for B2, and
    while it is in `install` none.
  - `updater.test.ts` (its stubs): `waits for its turn on a worker`: with `HORNHOOF_ROLE=worker`, a request is pulled
    with both compose files, `status.json` says `running`/`wait`, no `pg_dump` is called; a `go.json` from before the
    wait is gone, and one of another id, another commit or a past `until` is not taken; `go.json` with its id, tag and
    a later `until` leads to `install.sh worker`, a health check on the keeper's URL, and only then the updater's swap;
    a newer `request.json` ends the wait `failed` with the line above; `goes back on a worker without restoring`: an
    install that fails gives `rolled_back` with no restore call and no swap;
    `writes this host's addresses on Linux`: with `HORNHOOF_HOST_OS=linux` the stubbed `docker run ... ip` output of
    `eth0` `192.0.2.4/24`, `docker0` and `br-1a2b` gives `{"addresses":["192.0.2.4"]}`; on `darwin` no such call.
  - `keeper.test.ts`: `updaterBusy` is false for `running` with `wait`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let workers download the server's build and install it one at a time between turns, and read
  Linux machines' addresses".

### Task 6: Compose, the installer and the nodes

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/compose.test.ts test/install-script.test.ts
test/pins.test.ts` passes; from `apps/node`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/commands.test.ts`
passes; `bash -n scripts/install.sh` and `shellcheck scripts/install.sh` print nothing; both `tsc` commands print
nothing.

**Files:**
- Create: `compose.worker.yaml`
- Modify: `compose.yaml`, `Dockerfile` (copies `compose.worker.yaml` beside `compose.yaml`), `scripts/install.sh`,
  `apps/server/test/install-stubs/docker`, `apps/server/test/install-stubs/curl` (`/api/keeper` answers),
  `apps/node/src/main.ts` (`set-server`)
- Test: `apps/server/test/compose.test.ts`, `apps/server/test/install-script.test.ts`,
  `apps/node/test/commands.test.ts`

**Interfaces:**
- Consumes: the join answer (Tasks 2 and 5); `workerConfig`'s variables (Task 4); `updater.sh` worker mode (Task 5);
  plan 2's port registry functions.
- `compose.yaml`: no profile anywhere; every `${HORNHOOF_SECRET:?...}` and
  `${NODE_KEY:?...}` becomes `${HORNHOOF_SECRET:-}` and `${NODE_KEY:-}`; the keeper's `depends_on.db` gains `required:
  false`; the keeper's `environment` gains `HORNHOOF_ROLE: ${HORNHOOF_ROLE:-data}`, `HORNHOOF_JOIN_SERVER:
  ${HORNHOOF_JOIN_SERVER:-}`, `HORNHOOF_JOIN_TICKET: ${HORNHOOF_JOIN_TICKET:-}`, `HORNHOOF_ADDRESSES:
  ${HORNHOOF_ADDRESSES:-}`, `HORNHOOF_HOSTNAME: ${HORNHOOF_HOSTNAME:-}` and `HORNHOOF_OWNER_KEY:
  ${HORNHOOF_OWNER_KEY:-}`; the updater's gains `HORNHOOF_ROLE:
  ${HORNHOOF_ROLE:-data}`, `HORNHOOF_HOST_OS: ${HORNHOOF_HOST_OS:-}` and `HORNHOOF_HEALTH_URL:
  ${HORNHOOF_HEALTH_URL:-http://app:8080/api/health}`. Each with a short comment in the file's own voice.
- `compose.worker.yaml`: `db`, `migrate`, `app` and `node`, each with `profiles: ["data"]` and nothing else, under a
  comment saying a worker's `.env` names this file in `COMPOSE_FILE` so its data services never start.
- The web and peer ports stay published with no host address (`"${HORNHOOF_PORT:-8080}:..."`), on every interface;
  ruling 16's lines rest on that, on Docker Desktop and on Colima alike.
- `install.sh`:
  - `server` mode, run by hand, writes `HORNHOOF_HOSTNAME` (`hostname`, as `join_machine` cleans it),
    `HORNHOOF_HOST_OS` (`linux` or `darwin`) and on a Mac `HORNHOOF_ADDRESSES` (`ipconfig getifaddr en0` and `en1`,
    those that answer, comma separated); from the updater it keeps those lines. A server's `.env` never gets
    `COMPOSE_FILE`.
  - `compose_from_image` takes `$APP_REF` when it is set, else `$APP_IMAGE:${PIN:-latest}`, pulls it only without
    `HORNHOOF_PULLED`, and copies `compose.yaml` and, for a worker, `compose.worker.yaml`; `pull_image` downloads
    nothing with `HORNHOOF_PULLED` and uses the local image.
  - `join_machine` sends `"core":true`. A line that starts with `build `, `core ` or `core-here ` is read before the
    node lines' character check, each field checked: `build <tag> <app> <node> <updater>`, the tag
    `[A-Za-z0-9._-]{1,128}` and the refs exactly `$APP_IMAGE@sha256:`, `$APP_IMAGE-node@sha256:` and
    `$APP_IMAGE-updater@sha256:`, each with 64 hex; `core <folder> <ticket> <port> <company>`, the folder
    `hornhoof-[a-z0-9-]{1,64}`, the ticket 43 of `[A-Za-z0-9_-]`, the port 1024 to 65535 and the company a uuid;
    `core-here <port>`. A line that fails its check: `fail "Hornhoof sent a line this installer cannot read. Update
    Hornhoof and get a new command."`. A join that brought `core` or `core-here` and no node line succeeds (a `CORE`
    flag beside `JOINED`, which today's final check alone would want). With `build`, the node image is its node ref,
    pulled after the join.
  - `core <folder> <ticket> <port> <company>`: the worker's core (`worker_core`) in `~/<folder>`, or the first of
    `~/hornhoof-*` whose `.env` says `HORNHOOF_COMPANY=<company>`; a folder that exists naming another company or none
    takes the suffix `-2` to `-9` (else `fail "There are 9 Hornhoof folders here already. Remove one you do not use."`).
    A new folder gets `.env` (umask 077) with `COMPOSE_PROJECT_NAME` (the folder's name),
    `COMPOSE_FILE=compose.yaml:compose.worker.yaml`, `HORNHOOF_SERVER_DIR`,
    `HORNHOOF_ROLE=worker`, `HORNHOOF_COMPANY`, `HORNHOOF_JOIN_SERVER=$SERVER`, `HORNHOOF_MACHINE_ID` (`host_id`),
    `HORNHOOF_HOSTNAME`, `HORNHOOF_HOST_OS`, `HORNHOOF_ADDRESSES` on a Mac,
    `HORNHOOF_HEALTH_URL=http://keeper:7080/api/keeper`, `HORNHOOF_VERSION`, the three refs (the `build` line's, else as
    `server` mode names them), and the ports: under the registry's lock, `<port>` when no registry line, bound port or
    `.env` holds it, else the web range's next; the peer range's next; one registry line for the folder. A folder that
    exists keeps its lines. Either way `HORNHOOF_JOIN_TICKET=<ticket>` is written, `compose.yaml` and
    `compose.worker.yaml` come from the image by `compose_from_image`, then `docker compose pull` (unless
    `HORNHOOF_PULLED`) and `docker compose up -d --no-build`, then up to `HORNHOOF_CORE_WAIT` seconds (120 when unset)
    of `curl -fsS http://localhost:<web port>/api/keeper` until its `certificate` is true;
    past that, `say "This machine's core started, and keeps trying to reach the company server. See docker compose logs
    keeper in <folder>."` and go on. The `.env` of a worker never gets `HORNHOOF_SECRET`, `NODE_KEY`,
    `POSTGRES_PASSWORD`, `PUBLIC_URL` or `COMPOSE_PROFILES`.
  - After `core` or `core-here <port>`, `NODE_SERVER` is `http://host.docker.internal:<that web port>` with
    `LOCAL_SERVER=1`, so nodes started now get it by `set-key`; nodes keep `--label hornhoof.server=$SERVER`, the
    company's address, so `existing_nodes` still finds them.
  - Restarting an existing node (no code, or `worker` mode) whose `/data/node.json` server is not `NODE_SERVER` first
    runs `set-server` with `NODE_SERVER` on its volume, as `set-key` runs.
  - A new mode `install.sh worker`, for the updater on a worker: `.env` from `HORNHOOF_SERVER_DIR`, `SERVER` from its
    `HORNHOOF_JOIN_SERVER`; `compose.yaml` from `HORNHOOF_COMPOSE_FILE` and `compose.worker.yaml` from beside it;
    `docker compose up -d --no-build keeper front`, never the updater, which `swap_updater` replaces after health (Task
    5), and no certificate wait; then this company's existing nodes onto the node ref, each restarted only when its
    image changes.
  - `--owner-key <key>` beside `--join` (ruling 18): the key 80 to 200 of `[A-Za-z0-9_-]`, else `fail "This command's
    owner key cannot be read. Get a new command in Hornhoof."`. With a `core` line, `HORNHOOF_OWNER_KEY=<key>` goes
    into that core's `.env` with the ticket, replacing an older line; without `--owner-key`, or without a `core` line,
    no such line is written or changed. It is never sent to the server.
  - `--uninstall` also takes down each folder whose `.env` has `HORNHOOF_ROLE=worker` and `HORNHOOF_JOIN_SERVER=$SERVER`
    (`docker compose down -v` there), removes it and its registry line.
  - `USAGE` gains `worker`.
- The node: `hornhoof-node set-server` reads one line, an `http` or `https` URL, and rewrites `server` in its saved
  state, keeping the rest; with no saved state, or a line that is not such a URL, it prints `set-server expects one
  line: <server>` and exits 1. `USAGE` names it.

- [ ] **Step 1: Write failing tests.**
  - `compose.test.ts`: `keeps every service for a server, and the data services out on a worker`: `compose.yaml` has
    no `profiles`; `compose.worker.yaml` names exactly `db`, `migrate`, `app` and `node`, each with only `profiles:
    ['data']`; no `:?` anywhere in `compose.yaml`; the keeper's `depends_on.db` is `{ condition: 'service_healthy',
    required: false }`; the keeper's exact environment keys and the updater's gain the names above; where plan 2's
    `loads with a .env from before this build` runs `docker compose config`, `--services` with both files and an empty
    `.env` lists `front`, `keeper` and `updater`, and with `compose.yaml` alone all seven. Plan 2's case becomes "every
    `${...}` has `:-`". The `Dockerfile` copies `compose.worker.yaml` to `/app/`. `publishes on every interface`: each
    published port in `compose.yaml` is `<host port>:<container port>` with no host address.
  - `install-script.test.ts` (its stubs):
    - `keeps a server's data services`: `server` by hand writes `HORNHOOF_HOSTNAME` and `HORNHOOF_HOST_OS` and no
      `COMPOSE_FILE`; from the updater an existing `.env` keeps them.
    - `starts a worker's core alone`: a join whose stubbed answer is `core hornhoof-qwerty <43 chars> 8080 <uuid>` and
      one machine line, the curl stub's `/api/keeper` answering `{"certificate":true}`, makes `~/hornhoof-qwerty/.env`
      with the worker lines, `COMPOSE_FILE=compose.yaml:compose.worker.yaml` and the ticket, both compose files there,
      a registry line, `docker compose up -d --no-build` in that folder and never `up` naming `db`, `app` or `node`,
      and starts the machine node with `set-key` whose server is `http://host.docker.internal:8080` and `--add-host
      host.docker.internal:host-gateway`.
    - `takes a core line alone`: a stubbed answer with only a `core` line ends 0 and starts no node; a `build` and a
      `core` line, the same; a `core` line whose ticket has 42 characters fails with the line above.
    - `takes compose from the build it starts`: with `HORNHOOF_APP_REF` set, `docker create` names that ref and never
      `:latest`; with `HORNHOOF_PULLED=1` there is no `docker pull` call at all.
    - `goes on when the certificate is late`: the curl stub's `/api/keeper` answering `{"certificate":false}` with
      `HORNHOOF_CORE_WAIT=2` prints the line above and ends 0.
    - `writes a worker's settings without a company secret`: that `.env` has none of `HORNHOOF_SECRET`, `NODE_KEY`,
      `POSTGRES_PASSWORD`, `PUBLIC_URL`, `COMPOSE_PROFILES`.
    - `takes the next port when the server's is taken here`: with 8080 in the registry, the web port is 8081.
    - `finds this company's folder again`: a second join with another ticket writes the new ticket into the same
      folder's `.env` and makes no second folder; a folder `hornhoof-qwerty` of another company makes
      `hornhoof-qwerty-2`.
    - `points nodes at the server's own front on its computer`: `core-here 8090` starts nodes with
      `http://host.docker.internal:8090` and makes no folder.
    - `takes the build the server runs`: a `build` line makes the worker's `.env` refs those, and pulls the node ref;
      a ref of another image fails with the line above.
    - `moves an old node to its machine's front when it restarts it anyway`: an update without a code, with a core
      folder for this server, runs `set-server` with the local front before restarting each node.
    - `updates a worker from the updater`: `install.sh worker` with `HORNHOOF_FROM_UPDATER` runs `up -d --no-build
      keeper front`, never naming `updater`, and restarts a node only when its image changed.
    - `takes a worker's core down on uninstall`.
    - `carries the owner's key into the core`: a join with `--owner-key` of 122 characters and a `core` answer writes
      `HORNHOOF_OWNER_KEY` into the core's `.env`; a second join without it keeps the line, one with another key
      replaces it, and one whose answer has no `core` line writes none; a key with `$` fails with the line above before
      any request; the curl stub's join request never holds the key.
  - `commands.test.ts` (node): `set-server` keeps id, provider and key and changes the server; no state, exit 1 with
    the line above.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Install the small core on a joined machine, keep the data services in a profile, and point
  nodes at their own machine".

### Task 7: The owner's key

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/owner-keys.test.ts test/people.test.ts
test/worker-keeper.test.ts test/network-routes.test.ts` passes; from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx
vitest run test/owner-key.test.ts test/PasswordPrompt.test.tsx test/Machines.test.tsx test/Setup.test.tsx
test/Subscriptions.test.tsx test/Orchestrator.test.tsx test/Shell.test.tsx test/i18n.test.tsx` passes; then both whole
suites; `npx tsc -p apps/server/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` print nothing.

**Files:**
- Create: `apps/server/src/modules/computer/owner-key.ts`, `apps/server/src/modules/computer/keys.ts`,
  `apps/server/src/modules/keeper/owner-pin.ts`, `apps/web/src/owner-key.ts`, `apps/web/src/ui/PasswordPrompt.tsx`
- Modify: `apps/server/src/app.ts` (`keyRoutes`), `apps/server/src/errors.ts` (`key_exists`),
  `apps/server/src/modules/people/routes.ts` (`reinvite`), `apps/server/src/modules/keeper/worker.ts` (the pin, the
  report's `pin`), `apps/server/src/modules/network/routes.ts` (the report's `pin`), `apps/web/src/ui/CommandBox.tsx`,
  `apps/web/src/screens/Setup.tsx` (passes its password), `apps/web/src/api.ts` (a 401 `signed_out` forgets the key),
  `apps/web/src/screens/Shell.tsx` (sign-out forgets it), `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`
- Test: `apps/server/test/owner-keys.test.ts` (new), `apps/server/test/people.test.ts`,
  `apps/server/test/worker-keeper.test.ts`, `apps/server/test/network-routes.test.ts`, `apps/web/test/owner-key.test.ts`
  (new), `apps/web/test/PasswordPrompt.test.tsx` (new), `apps/web/test/setup.ts` (the test defaults below),
  `apps/web/test/api-mock.ts` (`GET /api/me/key` answers `TEST_KEY` unless a test sets `null`; `PUT` takes it),
  `apps/web/test/Machines.test.tsx`, `apps/web/test/Setup.test.tsx`, `apps/web/test/Subscriptions.test.tsx`,
  `apps/web/test/Orchestrator.test.tsx` (each join command they read now ends with ` --owner-key <TEST_KEY's
  publicKey>`), `apps/web/test/Shell.test.tsx`

**Interfaces:**
- Consumes: Task 1's `person_keys` and `owner_pin`; Task 4's `WorkerConfig.ownerKey`, the ticket redeem and the report;
  Task 6's `--owner-key`; `verifyPassword` and the login limiter; `reinvite`.
- Produces, on the server and in the keeper:
  ```ts
  // modules/computer/owner-key.ts, node:crypto only, so the keeper imports it too
  export const KEY_ITERATIONS = 600_000;
  export function keyPrint(publicKey: string): string;   // base64url of the SHA-256 of the SPKI DER: 43 characters
  export function isP256(publicKey: string): boolean;     // a P-256 SPKI that node:crypto reads
  // modules/computer/keys.ts
  export function keyRoutes(app: FastifyInstance, ctx: Ctx): void;
  // modules/keeper/owner-pin.ts
  export const PIN_FILE = 'owner.json';                   // { key, at } in the keeper's own volume, 0600
  export function readPin(dir: string): string | null;
  export function pinKey(dir: string, key: string): void; // written whole, then moved
  // errors.ts: ErrorReason gains 'key_exists'
  // POST /api/network/report takes also an optional pin: 43 base64url characters or null (else 400), written on the
  //   asker's row as owner_pin when present; a report without it keeps owner_pin
  ```
- `keys.ts`, on the person's own session only (`me.via` 403 `forbidden`):
  - `GET /api/me/key`: `{ key: { publicKey, wrapped, salt, iv, iterations } | null }` from `person_keys`.
  - `PUT /api/me/key`, body `{ password, publicKey, wrapped, salt, iv, iterations }` (each string at most 4096,
    `iterations` >= `KEY_ITERATIONS`, `isP256(publicKey)`, else 400): the password is checked as `POST
    /api/auth/login` checks it, with its limiter and its 401 `wrong_password`; with a row already there, 409
    `key_exists` "You have a key already."; else the row is written. 204.
- `reinvite` deletes the person's `person_keys` row in its transaction (ruling 19).
- The worker keeper: when its join with a ticket succeeds and it saves that ticket's hash (Task 4), it calls
  `pinKey(config.dir, config.ownerKey)` when `ownerKey` is set; a failed join pins nothing, and nothing else writes the
  pin. Its report sends `pin: keyPrint(readPin(config.dir))`, or null without one. The data keeper sends no `pin`.
- Produces, in the browser:
  ```ts
  // apps/web/src/owner-key.ts
  export const KEY_ITERATIONS = 600_000;
  export type StoredKey = { publicKey: string; wrapped: string; salt: string; iv: string; iterations: number };
  export type DeviceKey = { publicKey: string; privateKey: CryptoKey };   // privateKey non-extractable, ['sign']
  export type KeyStore = { get(): Promise<DeviceKey | null>; put(k: DeviceKey): Promise<void>; clear(): Promise<void> };
  export const browserKeyStore: KeyStore;
  //   IndexedDB database 'hornhoof', object store 'owner-key', one entry; any IndexedDB failure reads as empty and
  //   writes nothing, with one console line
  export type KeyDeps = { store: KeyStore; subtle: SubtleCrypto; iterations: number };
  export const keyDefaults: KeyDeps;   // browserKeyStore, globalThis.crypto.subtle, KEY_ITERATIONS; test/setup.ts sets a
                                       //   Map store, node:crypto's webcrypto.subtle and 1000, and clears the store after
                                       //   each test
  export function serverKey(): Promise<StoredKey | null>;                       // GET /api/me/key
  export function deviceKey(server: StoredKey | null, deps?: Partial<KeyDeps>): Promise<CryptoKey | null>;
  //   the store's key when its publicKey is the server's; else the store is cleared and null
  export function makeKey(password: string, deps?: Partial<KeyDeps>): Promise<DeviceKey>;
  //   an ECDSA P-256 pair, extractable only to be wrapped; PBKDF2-SHA256 over 16 random bytes of salt with
  //   deps.iterations to an AES-GCM 256 key; wrapKey('pkcs8', a 12-byte random IV); PUT /api/me/key with the password
  //   (its ApiFailure, 401 wrong_password or 409 key_exists, goes to the caller); then unwrapped once more as
  //   non-extractable ['sign'] and put in the store; the extractable key is dropped
  export function withOwnerKey(command: string, publicKey: string): string;
  //   command + ' --owner-key ' + publicKey when it has ' --join ' and no '--owner-key'; else the command
  export function forgetOwnerKey(deps?: Partial<KeyDeps>): Promise<void>;
  // apps/web/src/ui/PasswordPrompt.tsx
  export function PasswordPrompt(props: { purpose: 'make'; onPassword(password: string): Promise<boolean>;
    onCancel(): void }): JSX.Element;   // onPassword false: "Wrong password." under the field
  export function useOwnerKey(): {
    publicKey(password?: string): Promise<string | null>;
    //   the server's public key (deviceKey runs with it, so a stored key of another drops); with none, made first,
    //   with the password given or else asked; null on Cancel
    prompt: ReactNode;   // the PasswordPrompt while one is asked, else null; the caller renders it
  };
  ```
- `CommandBox({ command, trust, password? })`: a command with ` --join ` shows only as `withOwnerKey(command,
  publicKey(password))`; until then `ownerKeyMaking` or the prompt; after Cancel, `ownerKeyNeeded` and a button
  `ownerKeyEnter` that asks again; never the command without the key. Any other command shows as today. Every screen
  that shows a join command goes through `CommandBox` (`Machines`, `Setup`, `Subscriptions`, `ConnectPanel`,
  `CommandCard`), and each such command is made for the viewer, who asked for it. `Setup` passes the password its form
  holds, so the first command asks nothing (the setup's session is open by then).
- `api.ts`'s `request`: on a 401 whose reason is `signed_out`, `forgetOwnerKey()` before it throws; a 401
  `wrong_password` forgets nothing. `Shell`'s sign-out awaits `forgetOwnerKey()` before `onSignOut`.
- Strings, EN / RU:
  - `ownerKeyMake`: "Hornhoof makes your own key now, once. The command carries it to your machine, so that only you
    can open that machine to the orchestrator. Enter your password." / «Hornhoof сейчас один раз создаст ваш личный
    ключ. Команда отнесет его на вашу машину, чтобы открыть эту машину оркестратору могли только вы. Введите пароль.»
  - `ownerKeyWrong`: "Wrong password." / «Неверный пароль.»; `ownerKeyMaking`: "Making your key" / «Создаем ваш ключ»
  - `ownerKeyNeeded`: "This command carries your key, so it shows once you enter your password." / «Эта команда
    содержит ваш ключ, поэтому она появится, когда вы введете пароль.»; `ownerKeyEnter`: "Enter password" / «Ввести
    пароль»

- [ ] **Step 1: Write failing tests.**
  - `owner-keys.test.ts`:
    - `keeps a person's key only wrapped, and only with their password`: with a key made in the test by
      `globalThis.crypto.subtle` as the browser makes it, `GET /api/me/key` is `{ key: null }`; `PUT` with the wrong
      password is 401 and writes nothing, with `iterations` 1000 or a key of another curve 400, with the right one 204
      and then `GET` answers it; a second `PUT` is 409 `key_exists`; the orchestrator's token gets 403 on both.
    - `prints a key`: `keyPrint` is 43 characters and the same for the same key; `isP256` is false for an Ed25519
      SPKI and for text that is no key.
  - `people.test.ts`, `takes the key away on a reset`: after `POST /api/people/<Marat>/invite` his `person_keys` row is
    gone; after he accepts with a new password, `PUT` with it makes a new one.
  - `worker-keeper.test.ts`, `pins only from a redeemed ticket`: a join with `HORNHOOF_OWNER_KEY` writes `owner.json`
    with it once the ticket is redeemed; a second ticket of another person for the same computer (409
    `machine_taken`) with another key leaves the pin as it was; nothing in any answer of the server changes it; a new
    ticket of the owner with a new key replaces it; its report's `pin` is the key's print and lands as `owner_pin`.
  - `network-routes.test.ts` (plan 5's): a report's `pin` sets `owner_pin`, null clears it, a missing one keeps it,
    and one of 42 characters is 400.
  - `owner-key.test.ts`, with `keyDefaults` as `test/setup.ts` sets them and `fetch` stubbed:
    - `makes a key the server keeps only wrapped`: `makeKey` PUTs a `publicKey` that `node:crypto` reads as a P-256
      SPKI, a 16-byte salt, a 12-byte IV and `iterations` 1000, and nothing else of the key; the `wrapped` key unwraps
      with that password and not with another; the stored key has `extractable` false and `usages` `['sign']`.
    - `drops a key that is not the server's`: with key A in the store, `deviceKey` with the server's key B is null and
      the store is empty; with A it is A's key.
    - `forgets the key when the session ends`: a request answered 401 `signed_out` empties the store; one answered 401
      `wrong_password` does not.
    - `adds the key to a join command only`: `withOwnerKey('curl -fsSL https://corp.hornhoof.test/install.sh | bash -s
      -- --join abc', k)` ends with ` --owner-key <k>`; a command without ` --join `, or with `--owner-key` already,
      comes back the same.
  - `PasswordPrompt.test.tsx`, `shows a join command only with the viewer's key`: with a key on the server,
    `CommandBox` shows the command with its ` --owner-key` and asks nothing; with `{ key: null }`, the prompt and no
    command; a `PUT` answered 401 `wrong_password` shows "Wrong password." and no command; the right password PUTs once
    and shows the command with the new key; Cancel shows `ownerKeyNeeded` and "Enter password", never the command;
    each in Russian too.
  - `Setup.test.tsx`: the setup's join command shows with ` --owner-key`, made from the password typed in its form,
    with no prompt.
  - `Shell.test.tsx`: `forgets the key at sign-out`: after Sign out the store is empty.
  - The tests in the Test list that read a join command's text expect the ` --owner-key` ending.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. `browserKeyStore` has no test here: jsdom has no IndexedDB, and
  `fake-indexeddb` would be a new package; plan 6's rehearsal checks it.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Make each person's key in their browser, carry it in their join commands, and pin it on the
  worker".

### Task 8: The Machines tab

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/nodes.test.ts test/machine-load.test.ts` passes;
from `apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Machines.test.tsx test/i18n.test.tsx` passes;
`npx tsc -p apps/server/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` print nothing.

**Files:**
- Modify: `apps/server/src/modules/nodes/routes.ts` (`GET /api/machines`), `apps/server/src/modules/nodes/nodes.ts`
  (`builtinMachine`), `apps/web/src/screens/Machines.tsx`, `apps/web/src/types.ts`, `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`
- Test: `apps/server/test/nodes.test.ts`, `apps/web/test/Machines.test.tsx`

**Interfaces:**
- The commands this tab shows, "Make <host> a full machine of the company" included, go through `CommandBox`, so they
  carry the viewer's key (Task 7).
- `builtinMachine(db, hostId, companyId, networkId?: string | null)`: also the machine whose key hashes to `networkId`
  (the server passes `config.machineId`), so the badge follows the computer the server's keeper runs on.
- `GET /api/machines`: each machine gains `core: { webPort: number | null; path: LinkPath | null } | null` (its row's,
  when it has a `network_id`) and `needsCore: boolean` (ruling 14's condition, by `nodes.last_seen_at`, for its owner
  only); `builtin` gains `webPort` (the `server:` row's) and `refusedBy: string[]`, the hostnames of live workers with
  `direct_fails`.
- The card: "Open here" / «Открыть здесь» with `localhost:<webPort>` in the owner and system part, for a machine with a
  core and for the server's card; on the server's card, per name in `refusedBy`, "<server> does not take connections
  from <name>. If <server> is a Mac with its firewall on, allow incoming connections there for Docker
  (com.docker.backend), or for ssh when it runs Colima." / «<server> не принимает подключения от <name>. Если на машине
  <server> стоит macOS с включенным файрволом, разрешите на ней входящие подключения для Docker (com.docker.backend)
  или, если там Colima, для ssh.», `<server>` being the card's name; with `needsCore`, the action "Make <host> a full
  machine of the company" / «Сделать <host> полной машиной компании», which posts `/api/machines/<id>/core` and shows
  the command as "Add a plan" does, under "Run this in a terminal on <host>. It adds the company's core there: the
  company opens on its localhost, and updates come by themselves." / «Выполните это в терминале на <host>. Команда
  добавит туда ядро компании: компания откроется на localhost этой машины, а обновления будут приходить сами.» The
  Disconnect question gains, for a machine with a Claude plan, "If it was stolen, its owner should also revoke its
  Claude sign-in at claude.ai, which stays valid for a year." / «Если ее украли, владельцу нужно еще отозвать вход
  Claude на claude.ai: он действует год.» The Connect a machine panel gains "If the company server runs on a Mac with
  its firewall on, the Mac may ask once whether Docker (com.docker.backend, or ssh with Colima) may take incoming
  connections: allow it, or this machine reaches the server only through hornhoof.org." / «Если на машине сервера
  компании стоит macOS с включенным файрволом, macOS может один раз спросить, можно ли Docker (com.docker.backend, а с
  Colima ssh) принимать входящие подключения: разрешите, иначе эта машина будет связываться с сервером только через
  hornhoof.org.»

- [ ] **Step 1: Write failing tests.**
  - `nodes.test.ts`: `shows each machine's core and the server's`: a joined worker that reported `web_port` 8081 and
    `path` `relay` has `core` with both, and still has it two days after its last report; a machine without a
    `network_id` whose node was seen an hour ago has `core: null` and, for its owner, `needsCore` true, for another
    person false, and with its nodes last seen two days ago false; the computer whose key hashes to
    `HORNHOOF_MACHINE_ID` is `builtin.machine` without `HORNHOOF_HOST_ID`; a worker with `direct_fails` puts its
    hostname in `refusedBy`.
  - `Machines.test.tsx`: the badge "Company server here" on the server's card; "Open here" with `localhost:8081`; the
    refusal line names both machines; "Make Mac a full machine of the company" posts and shows the command; the
    Disconnect question has the Claude line only for a machine with a Claude plan; each in Russian too.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show on the Machines tab where the server runs, each machine's local address, and offer the
  core to machines joined before".

### Task 9: The lab's Docker-in-Docker machines

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Task 8 committed. **Done when:** from the
worktree root `npm run test:lab` passes (it needs Docker that may run privileged containers); `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/machine.Dockerfile`, `apps/server/test/lab/lab.ts`,
  `apps/server/test/lab/join.test.ts`, `apps/server/vitest.lab.config.ts`
- Modify: `package.json` and `apps/server/package.json` (`test:lab`), `apps/server/test/pins.test.ts` (the lab's pins)

**Interfaces:**
- `machine.Dockerfile`: `FROM docker:<version>-dind@sha256:<digest>` (the agent pins the current 28.x digest), adding
  `bash`, `curl`, `jq`, `coreutils` and `iptables` with `apk add --no-cache`; `pins.test.ts` asserts the digest pin.
- `lab.ts`:
  ```ts
  export type LabMachine = { name: string; exec(cmd: string, opts?: { env?: Record<string, string>; input?: string }): Promise<{ code: number; out: string }> };
  export class Lab {
    static start(opts: { machines: number }): Promise<Lab>;
    //   builds hornhoof-lab/app:dev (the Dockerfile at the root), hornhoof-lab/node:dev and hornhoof-lab/updater:dev
    //   (their Dockerfiles) and the machine image; a network hh-lab-<random>; machines hh-lab-<random>-m1.. on it,
    //   privileged, hostnames m1.., each waiting for its Docker; the three images loaded into each by docker save and
    //   docker load; every container, network and volume labelled hornhoof.lab=<random>
    machine(i: number): LabMachine;
    stop(): Promise<void>;   // removes exactly what carries its label
  }
  ```
- `join.test.ts`, one scenario, 15 minutes at most:
  1. On m1: `install.sh server` with `HORNHOOF_APP_REF`, `HORNHOOF_NODE_REF`, `HORNHOOF_UPDATER_REF` the lab's images
     and `HORNHOOF_PULLED=1`, over a whole `.env` the lab writes first: fresh `HORNHOOF_SECRET`, `NODE_KEY` and
     `POSTGRES_PASSWORD` as `install.sh` makes them, `HORNHOOF_PORT`, and `PUBLIC_URL=http://<m1's address on the lab
     network>:<web port>`, an address because nested containers on m2 may not resolve the name `m1`; the company set
     up through `setup-link`'s link; the owner's session from it.
  2. The owner's key, made in the test with `globalThis.crypto.subtle` as the browser makes it (the test keeps the
     private key), stored by `PUT /api/me/key`; `POST /api/machines/command`; on m2 the command's `curl ... | bash -s
     -- --join <code>` with ` --owner-key <its public key>`, the lab's refs and `HORNHOOF_PULLED=1`: it ends 0; m2 has
     `~/hornhoof-<six letters>` with that key in its `.env`, and a running machine node.
  3. Within 120 s: m2's `curl localhost:<its web port>/api/health` gives the server's commit; its `/api/keeper` names a
     leader on `direct`; the server's database has m2's row with role `worker`, a network id, `addresses` and
     `owner_pin` the key's print; `GET
     /api/machines` gives m2's `core.webPort`, and m2's machine node is online, which proves the nested node reaches
     m2's front through m2's own Docker's host-gateway; `docker compose ps` in m2's folder lists `front`, `keeper` and
     `updater` only.
  4. From m2's keeper container, a TLS client with m2's certificate asking `CONNECT db:5432` on m1's peer port gets
     403; m2's keeper's `HORNHOOF_SECRET` and `NODE_KEY` are empty, and m2's `.env` has neither.
  5. Disconnect m2: within 30 s m2's `/api/keeper` says `disconnected`, a page request to its web port gets the
     disconnected page, and m1's `revoked` lists m2's serial.

- [ ] **Step 1: Write the failing test** `join.test.ts` and `lab.ts`'s outline; `npm run test:lab` fails at step 1.
- [ ] **Step 2: Implement** `lab.ts` and the machine image until the scenario passes. A step that fails for a reason
  of the product, not the lab, is reported as a finding with the failing step, never worked around in the lab.
- [ ] **Step 3: Check the disk, then run Done when.** Before each run: `df -h` on the Mac and `docker system df`.
  Each DinD machine loads the three images, so the run needs their sizes (`docker image inspect --format '{{.Size}}'`)
  times the machines plus one, and 5 GB more. When space is short, clean only build cache (`docker builder prune -f`)
  and `hornhoof-lab/*` images, never a volume and never another image; still short: stop and report. Then Done when.
  Expected: PASS.
- [ ] **Step 4: Commit** "Add the lab: Docker-in-Docker machines that install a server, join a worker and disconnect
  it".

### Task 10: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `machines-join`. **Starts from:** Tasks 1 to 9 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Updates and
any join on Ivan's machines are Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` → pass; the `tsc` commands → no output; `bash -n` and `shellcheck` on both scripts → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 5's Task 7 Step 2: `git diff main --stat` lists no key or
  certificate file; `git grep -nE "BEGIN (EC |ENCRYPTED )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` prints nothing
  and exits 1; `git diff main | grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` shows only `127.0.0.1`, `0.0.0.0`, the
  private ranges' bounds in `isPrivate` and its tests, and the documentation ranges.
- [ ] **Step 3: Review.** The team lead reads the branch against spec sections 2, 3.1, 3.2, 3.9, 6, 9 and 10, the
  overview's plan 5 entry and this plan's rulings; the CLI agent that did not write a task reviews it too (Gemini for
  Codex's tasks, Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on the team lead's stand on Ivan's Mac, as in plan 5. First the disk, as in Task
  9 Step 3: `df -h` and `docker system df`, and when space is short only build cache and `hornhoof-lab/*` images go,
  never a volume. `iptables` runs only inside `hh-rehearsal-m2`, never on the Mac's Docker. Then install the current
  release (plan 5's) as `install.sh server --name rehearsal` with a random link. Build two branch builds with `gh
  workflow run images.yml --ref machines-join`: B1 from Task 8's commit and B2 from the branch's head (both carry all of
  this plan's product code; Task 9 changes only tests) and read their digests; each update a `request.json` through a
  short updater container, as in plan 2. The worker is a lab machine on the same Mac: `docker build -t
  hornhoof-lab/machine -f apps/server/test/lab/machine.Dockerfile apps/server/test/lab`, then `docker run -d
  --privileged --name hh-rehearsal-m2 --label hornhoof.rehearsal=1 hornhoof-lab/machine`, which joins with the real
  command over the real link. The checks, from `~/hornhoof-rehearsal`: plan 5's checks, and for the worker `docker exec
  hh-rehearsal-m2 sh -c 'curl -fsS localhost:<its web port>/api/keeper'` (its leader, path and commit) and `docker
  compose exec -T db psql -U hornhoof -d hornhoof -tAc "SELECT role, path, direct_fails, commit, report_at > now() -
  interval '1 minute' FROM machines WHERE role = 'worker' AND revoked_at IS NULL"`. Plan 5's probe from outside runs
  too, by its rule (another machine only when Ivan names one and gives access; else the Mac's LAN address with
  `openssl@3`, or the `alpine` container on `--network host`), and the step names which it used. In this order:
  1. Forward, from the release to B2: it ends `done`, plan 5's checks and probe pass, and `.env` has no `COMPOSE_FILE`.
     Then `HORNHOOF_VERSION=<B2's tag> install.sh server --name rehearsal` by hand once, which records the Mac's address
     (ruling 11): the `server:` row's `addresses` holds it.
  2. Join the worker with the command from Machines (the browser asks the password once and makes the key; the command
     ends with `--owner-key`): it ends 0; within two minutes its `/api/keeper` has a leader on `direct`, `curl
     localhost:<its port>/api/health` inside it gives B2's commit, the row says `worker|direct|f|<B2 commit>|t`,
     `SELECT length(owner_pin) FROM machines WHERE role = 'worker' AND revoked_at IS NULL` gives 43, and `docker
     compose ps` in its folder lists `front`, `keeper` and `updater` only.
  3. Inside the worker, `iptables -I DOCKER-USER -p tcp -d <the Mac's LAN address> --dport <peer port> -j REJECT
     --reject-with tcp-reset` (its keeper is a container inside it): within 2 minutes its path is `relay` and its
     health still answers; `direct_fails` stays `f`, since the lab machine shares no `/24` with the Mac (Task 8's test
     covers the card line); then the rule removed, and within 2 minutes `direct` again.
  4. Back to B1 on the server: it ends `done`; within 15 minutes the worker's `/api/keeper` gives B1's commit, and its
     updater's `status.json` went through `wait`.
  5. Forward to B2 on the server: the same with B2's commit.
  6. Back to the release, the worker joined: it ends `done`, the company leads, a change on localhost works, and plan
     5's checks pass; within 2 minutes the worker's `/api/keeper` has a leader on `direct` and is not `disconnected`,
     its `curl localhost:<its port>/api/health` gives the release's commit, and its updater got no request.
  7. Forward again to B2: it ends `done`, the checks of step 1 pass, and the worker's health gives B2's commit with no
     update of its own.
  8. Disconnect the worker in Machines: within 30 s its `/api/keeper` says `disconnected`; `SELECT kind FROM
     peer_secrets WHERE created_at > <the moment of Disconnect>` gives `app`, `data` and `visit` within a minute, and
     `docker compose logs keeper` shows the stand's peer frpc started again.
  Then remove the worker (`docker rm -f -v hh-rehearsal-m2`), the link in Share access, `docker compose down -v` in
  `~/hornhoof-rehearsal` only, that folder, and its registry line by hand. Any step that fails: stop and report, and
  Ivan is not asked to update.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from, so the
  team lead writes the merge commit into main with exactly this subject (no double quote):
  ```text
  Let machines join the company with its small core, reach its server, and follow its build
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** As plan 5's Task 7 Step 6: the team lead compares, reading only,
  the node image digest and tells Ivan in one line whether running turns will end; Ivan presses Update on his own
  companies himself, one at a time; the team lead never runs an install, an update, a join or a `request.json` on
  them. After each, the team lead runs the checks above, reading only, and of the probe only `P` without a
  certificate and `P` with another authority's, from the machine the probe's rule picks, and names which it used.
  When Ivan joins a machine of his (Machines, Connect a machine, or "Make Mac a full machine of the company" on a
  machine joined before), the team lead reads that machine's row (its `owner_pin` set) and, on that machine only when
  Ivan gives access,
  its `/api/keeper`. When a check fails, or the Update does not end within 20 minutes, the team lead tells Ivan which
  release to go back to, the one before, and how: in Versions, that release's Install button, or, when the app does
  not answer or only reads, `HORNHOOF_VERSION=<that release> install.sh server` (with `--name <name>` for a named
  company) on that machine. A worker already joined keeps working against the release before (it reaches the app as
  plan 5 serves it) and comes back to the server's build once the server is forward again.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/machines-join` and `git branch
  -d machines-join` once main has the merge.
