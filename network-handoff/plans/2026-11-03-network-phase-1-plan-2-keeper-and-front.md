# Network Phase 1, Plan 2: Keeper and Front on One Machine, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every install runs two new containers from the app image: `front`, which serves the company's web port and
passes every request and socket on, and `keeper`, which sets the app's mode, runs the public link's frpc as its child
with the network's client id and transport, ends the link's TLS, and passes what comes in to the app. The `tunnel`
container goes, `db` starts with the settings logical copies need, migrations run once in a `migrate` container
before the app starts, and the app answers in `lead`, `read`, `maintenance` or `off`. A host-wide port registry gives
each company its web and peer ports. One Update moves today's installs in, and back if the new build fails.

**Architecture:** Three new entry points in `apps/server/src`, built by the same `tsc` into `dist/`: `front.ts`,
`keeper.ts` and `migrate.ts`. A small pass-through on `node:http` (`net/proxy.ts`) carries requests, streams and
WebSockets for both `front` and the keeper. The keeper (`modules/keeper/`) reads the link and its certificate from the
database every 3 s, feeds plan 1b's TLS listener and today's `TunnelKeeper` (now fed by a function, not a file),
derives maintenance from the updater's `status.json`, and gives the app its word in `keeper.json` in the control
folder every second. The app's `AppMode` reads that file, starts and stops the work only a leader does, and an
`onRequest` gate refuses what the mode does not allow. The updater (revision 2) stops the app for the database copy,
removes the services a build does not name before it installs that build, limits how long an install may take, and
checks health where that build answers. `install.sh` gets the start order, the machine id, the port registry, and
hands an update to the new build's updater when an older one runs it.

**Tech Stack:** TypeScript on Node 22 (`node:http`, `node:net`, `node:tls`), Fastify 5 with `@fastify/websocket`,
drizzle on node-postgres, vitest with PGlite, `ws` in tests; bash (macOS 3.2 for the tests, Alpine in the updater) for
`install.sh` and `updater.sh` with their stub tests; Docker Compose v2 (`depends_on` with
`service_completed_successfully`, `up --wait`); frpc 0.71.1; Postgres 17.11.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.1 (what runs where), 3.9 "Modes", 3.10 (the link ends at
the keeper), section 6 (ports and several companies per machine) and section 9 ("Move in by Update", "The maintenance
state"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 2's entry. Plan 1
`notes/plans/2026-11-03-network-phase-1-plan-1-relay-contract.md` and plan 1b
`notes/plans/2026-11-03-network-phase-1-plan-1b-company-certificate.md` (see "Handed over by plans 1 and 1b").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/keeper-and-front` on a new branch `keeper-and-front` from main
(`git worktree add`, then `npm ci` there once), after plan 1b is merged into main.

**Handed over by plans 1 and 1b** (merged, and plan 1 deployed, before this plan starts):
- Plan 1, on hornhoof.org: an frpc may log in with `clientID = "<link>-<machine8>-link"` and the same value in
  `metadatas.client` (R1), with `transport.heartbeatInterval = -1`, `transport.tcpMuxKeepaliveInterval = 10` and no
  `heartbeatTimeout` (R3). A name with a live route refuses a second registration, and frpc sends a refused proxy again
  every 30 s (`client/proxy/proxy_wrapper.go:50`), so an frpc started again may wait up to about 40 s for its route.
- Plan 1b, in `apps/server/src/modules/tls/`: `listener.ts` with `LINK_TLS_PORT = 8443`, `linkVisitor(socket)` and
  `class LinkListener { constructor({ app, config, log }); listen(port, host?); use(host, cert); close(graceMs?) }`;
  `proxy-header.ts` with `readProxyV2`; `x509.ts` with `certInfo` and `selfSigned`; `store.ts` with `tlsOf(db,
  companyId)` and `linkMode(db, config): Promise<'http' | 'https'>`; `manager.ts` with `LinkTls` (`serveOn(listener:
  Served)`, `start()`, `stop()`, `kick()`) and `type Served = { use(host: string | null, cert: { certPem: string;
  keyPem: string } | null): Promise<void> }`, started by `main.ts` alone. `config.acmeDirectory` from `ACME_DIRECTORY`.
- Plan 1b, elsewhere: `modules/link/tunnel.ts` `Settings` with `mode`; `modules/link/client.ts` `configFor` with the
  `https` proxy block (`localIP = "app"`, `localPort = 8443`, `transport.proxyProtocolVersion = "v2"`);
  `modules/link/link.ts` `writeTunnelSettings` writing `mode`, and `PublicLinks.sync(): Promise<boolean>`;
  `auth/tunnel.ts` `overLink(req, config)`, with `cameOverHttps` and `clientAddress` taking `linkVisitor` first;
  `req.overLink`; `GET /api/health` answers `{ ok: true }` over the link; `test/helpers.ts` with `TUNNEL =
  '192.0.2.10'` and `viaLink(token?)`, and `testApp` defaulting to `ACME_DIRECTORY: 'off'`.
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges `192.0.2.0/24`
  and `203.0.113.0/24`, hosts under `hornhoof.test`, and keys made at run time.
- No new dependency. The pass-through is `node:http` and `node:net`.
- No migration in this plan. The keeper reads only tables and columns that exist before and after it, so a keeper of
  this build runs on the database of the build before while `migrate` has not run yet.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web`:
  `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from the worktree root:
  `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`. Types and shell, always from the worktree root:
  `npx tsc -p apps/server/tsconfig.json --noEmit` and, for web tasks, `npx tsc -p apps/web/tsconfig.json --noEmit`,
  both printing nothing; `bash -n scripts/install.sh apps/updater/updater.sh` and `shellcheck scripts/install.sh` (CI
  runs it, `.github/workflows/images.yml:38`). Never run prettier.
- Every variable the new `compose.yaml` reads has a default, or is one every `.env` has today (`HORNHOOF_SECRET`,
  `NODE_KEY`): the updater that runs the move-in loads the new compose file with the old `.env` before the new
  installer runs (`apps/updater/updater.sh:269-282`, `pull_images`).
- The built-in node runs agents and shares the default network with `front`, the keeper, the app and the updater.
  Nothing it can send makes the app or the keeper believe a forwarded header, change a mode, or reach the link key or a
  certificate key. The control folder, which carries `keeper.json`, is mounted by the app, the keeper and the updater
  only; the node mounts nothing of it.
- A private key (the link key, a certificate's key) never goes into a log line, `keeper.json` or an answer. The
  keeper writes frpc's config with mode 0600 in its own container.
- Fail toward a working company: what the keeper cannot read now (the database, the status file) keeps what it runs;
  the app keeps its mode while the keeper's word is stale.
- localhost, the link and the built-in node keep working as before: the same web port, now on `front`; the node still
  at `http://app:8080` (plan 4 moves it).

## Rulings made while planning

- **One Update moves an install, whatever updater runs it.** The move-in is driven by the updater already running, and
  its way back runs the old installer, whose `compose up` cannot start `app` while `front` still holds the web port:
  today `drop_orphans` runs only after an install that worked (`updater.sh:284-300`). So this build's updater (revision
  2) removes the containers of the services a build's compose file does not name before it runs that build's
  installer, and checks health at `front` when that build has one. This build's installer, run by an updater that does
  not say `HORNHOOF_UPDATER_REV=2`, changes nothing yet but `.env` and `compose.yaml`, which the old installer writes
  back on the way back, then starts a helper container of its own build's updater image (`updater.sh --take-over`).
  The helper starts this build's `updater` service, as `swap_updater` does (`updater.sh:318-324`), which stops the old
  updater; the new one finds the update in its note and goes on with it (`interrupted`, `updater.sh:450-474`, the path
  an updater restarted during an update takes today). Compose removes the old updater before it starts the new one,
  so the helper waits for the new one's word in `status.json`; without it, it marks the update `rollback` and starts
  the old updater image again, which goes back by itself. One release, one Update, also for an install that skipped
  builds, and a failed move-in goes back under the new updater. After a move-in that went back, the new updater stays
  and runs the next Update, since the old installer leaves the updater container as it is.
- **The database copy is taken with the app stopped.** Today the copy is taken while the old app works on, and the
  handover makes that window longer. Revision 2 stops `app` right before the dump, so every change the app confirmed is
  in the copy; `front` and the keeper answer maintenance meanwhile, and the app is stopped through the install anyway.
  An update an older updater began is copied again once the new updater takes over. A failed dump starts the app
  again. Each install also has a time limit, 15 minutes, after which the updater stops `migrate` and `app` and goes
  back, so a migration or a database start that hangs never keeps the company in maintenance.
- **Migrations run in a one-shot `migrate` service** that `app` waits for (`depends_on: migrate: condition:
  service_completed_successfully`), so every `compose up` that starts the app migrates first, as the owner, with
  application name `hornhoof-migrate` and no timeouts. The installer stops `app` before it, so the old build never runs
  on a schema it does not know, and starts `front` and the keeper before it, so the maintenance answer is up while it
  runs. Spec section 9 says the updater runs `migrate`; here the updater runs the build's installer, which runs it.
- **The maintenance state comes from the updater's own status file.** On one machine there is no copy to promise
  anything to, so the keeper derives it: `status.json` says `running` with step `backup`, `install`, `health` or
  `rollback`. Step `pull` is not maintenance, since the old build works on while images download (`updater.sh:371-372`).
  The file outlives every container, so a restart of the keeper, the app or the updater keeps the state, and it ends
  only when the updater records success, failure or a finished rollback, as spec section 9 asks. A status file the
  keeper cannot read or parse changes nothing; a missing one means no update runs, since nothing but a person removes
  it. The keeper writing the state into its control folder and `net_local.maintenance` comes with the plans that have
  `net_local` and copies (3 and 9).
- **The app takes its mode from `keeper.json`** in the control folder, which the keeper writes every second: no port
  and no token, since the node, where agents run, does not mount the folder. Before the first fresh word the app is
  `off`. A word older than 10 s changes nothing: the app keeps the mode it has, so a keeper restart does not stop work;
  plan 3, where commits need the keeper's lease, decides what a long-gone keeper means. An app with `HORNHOOF_KEEPER`
  unset (tests, `npm run dev`, a compose file of an older build) leads as today.
- **`maintenance` is `read` with its own reason** (spec 3.9): reads are served, so the Update panel shows its steps
  while the app is up; changes, sockets and lead work are not. While the app is down (migrations, restarts), the keeper
  answers `/api/*` with the same maintenance reason, which the Update panel shows as maintenance.
- **Read mode here is the spec's, less three parts left to the plans that need them:** every `/mcp` call is refused
  (a POST, so no read tools yet); a new sign-in is refused (the short-lived signed cookie and the recovery API belong
  to plans 9 and 10); nodes are refused, not let in for status (plan 4 gives them outboxes that keep their messages).
  On one machine the keeper never asks for `read` in this plan; plan 3 does. Leaving `lead` closes every open
  WebSocket, so a node or a terminal already connected sends nothing more until the app leads again; node messages
  still queued then are dropped, and a session is handed over to the link's cookie only in `lead`. A change admitted
  while leading ends as it would: in this plan the app leaves `lead` only for an update, which stops it before the
  copy. Plan 3, which asks for `read` while the app runs on, drains those changes.
- **Ports inside the containers.** `front` listens on 8080 and publishes `HORNHOOF_PORT`. The keeper listens on 7080
  for `front` (default network), on `127.0.0.1:7081` for the link's `http` mode and on `127.0.0.1:8443` for its
  `https` mode, both reached only by its own frpc child. 7070 is the peer link's (spec section 6, "keeper 7070"),
  published as `HORNHOOF_PEER_PORT` with nothing listening until the peer link's plan, so the port is held from now on.
- **Who believes which header.** `front` replaces `x-forwarded-for` with the socket's address and drops
  `x-forwarded-proto` and every `x-hornhoof-*` header. The keeper drops the same, and sends the app exactly one
  `x-forwarded-for`: on 7080 the one `front` wrote, only when the socket is `front`'s address (looked up by name each
  time, as `fromTunnel` does), else the socket's; in `http` mode the first entry of what frps wrote; in `https` mode
  the PROXY header's source. It adds `x-forwarded-proto: https` for link traffic only. The app keeps `TUNNEL_HOST`
  (no rename, so the tests keep their names), now `keeper` in compose, so `cameOverHttps`, `overLink` and
  `clientAddress` work unchanged, and 1b's `linkVisitor` leaves the app. `x-forwarded-host` passes untouched, since
  `origin.ts` reads it for an owner's own proxy in front of localhost.
- **The keeper reads the link from the database**, as spec 3.10 says a standby will: `public_links` for name, key and
  tunnel, `link_tls` for the certificate, and 1b's `linkMode` for the mode, every 3 s, through its own pool
  (application name `hornhoof-keeper`, `statement_timeout` 2 s). A failed read keeps the frpc and the certificate it
  has. The app still writes `tunnel.json`: the updater keeps a copy of it with each backup (`updater.sh:227-236`) and
  the installer reads the link's address from it (`install.sh:715-722`). `LinkTls` stays in the app, since only a
  leader orders certificates; its `Served` becomes the keeper's word in `keeper.json` that it serves that certificate.
  The keeper starts frpc again only when the settings change, since each start may cost the link up to 40 s.
- **The machine id is `HORNHOOF_MACHINE_ID` in `.env`**, which `install.sh` writes once and never changes: run by hand,
  the machine's host id (`host_id`, the hash the server already knows the machine by, so the machine's own key never
  leaves it); from the updater, whose container cannot read that key, 32 random hex digits. machine8 is its first 8
  characters. The plans that give machines certificates take this value.
- **The port registry** is a text file `registry` in the Docker volume `hornhoof-ports`, read and written through a
  short container of the app image, run by hand and from the updater alike, so no compose file mounts it yet and none
  declares it `external`; the updater's mount (spec section 6) comes with the first updater job that needs it. One
  line per company folder: `<folder> <web port> <peer port>`. Nothing removes a line, since there is no server
  uninstall today.
- **Folders stay as today**: `~/hornhoof`, and `~/hornhoof-<name>` with `--name`. `~/hornhoof-<company>` for a
  joined machine comes with joining (plan 5).
- **`front` holds nothing yet.** It answers 502 with `Retry-After: 5` while the keeper does not answer; holding
  requests up to 60 s is plan 4's.
- **Every hop opens a new connection per request** (no keep-alive pool), so a connection the next hop closed while
  idle never takes a request. Inside a compose network that costs nothing that shows.

## Review Focus

1. A move-in whose new build never answers, whose installer fails or hangs, or whose handover fails, run by the old
   updater or the new one: the install is back in today's shape, `app` on the web port answering with the old commit
   and `tunnel` carrying the link, with no `front`, `keeper` or `migrate` container left, and nothing the old app
   confirmed lost. Tests in Task 1 (`moves in by handing over, and goes back to the old build when the new one fails`,
   `stays on the old build, working, when the new installer cannot start the hand-over helper`, `brings the older
   updater back to go back when this build's updater does not start`, `stops an installer that does not end, and goes
   back`) and Task 8 (`hands an update to this build's updater when an older updater runs it`, `stops when the
   hand-over helper does not start`).
2. Four companies installed on one computer, one of them stopped and pruned between installs: each keeps its own web
   and peer ports, and no port is handed out twice. Tests in Task 9.
3. A terminal WebSocket and an event stream through `front` and the keeper that stay quiet a while, and a large
   upload: nothing buffers or cuts them, and closing either end closes the other. Tests in Task 4.
4. A request to localhost, or from the built-in node straight to the keeper or the app, with a forged
   `x-forwarded-for` or `x-forwarded-proto: https`: the app sees the true address and does not take it as over the
   link. Tests in Tasks 4 and 5.
5. The keeper restarting while the app leads: the app stays in `lead`, and the link comes back under the same client
   id. Tests in Tasks 3 and 6.

---

### Task 1: The updater, revision 2

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts` passes, and from the worktree root
`bash -n apps/updater/updater.sh apps/server/test/updater-rev1.sh` prints nothing.

**Files:**
- Create: `apps/server/test/updater-rev1.sh`, main's `apps/updater/updater.sh` (`git show main:apps/updater/updater.sh`)
  unchanged but for a second line, the comment `# The updater from before revision 2, kept so the tests run a move-in
  under it.`
- Modify: `apps/updater/updater.sh` (`note`, `recall`, `backup`, `install`, `healthy`, `interrupted`, the start, the
  header comment), `apps/server/test/updater-stubs/docker`
- Test: `apps/server/test/updater.test.ts`

**Interfaces:**
- Produces, in `updater.sh`:
  - `HORNHOOF_UPDATER_REV=2` goes to every installer it runs, beside the variables it passes today. The note gains
    `rev: "2"`; `recall` reads it, empty in a note an older updater wrote.
  - `backup()`: the app's container id (`compose ps -q app`), then `compose stop app`, then the dump as today. A failed
    dump starts that container again (`docker start <id>`, its failure ignored) before today's `Could not save the
    database, so nothing changed.`
  - `remove_unnamed <compose file>`, called by `install()` after `unpack` and before the installer: when the file names
    the service `updater`, every container of this compose project whose service the file does not name is removed
    with `docker rm -f <id>`, never one of service `updater`; when the file names no `updater`, nothing is removed (as
    `drop_orphans`). Services the file names: `docker compose --project-directory "$SERVER_DIR" -f <file> config
    --services`. Containers: `docker ps -a --filter "label=com.docker.compose.project=<project>" --format '{{.ID}}
    {{.Label "com.docker.compose.service"}}'`, the project being `.env`'s `COMPOSE_PROJECT_NAME`, else the updater's
    own `COMPOSE_PROJECT_NAME`, else `hornhoof`. A failed removal is one `say` line and the install goes on.
  - `install()` runs the installer in the background and waits for it. When it has not ended after
    `${HORNHOOF_INSTALL_WAIT:-900}` seconds: `compose stop migrate app` (ignored), the installer's process is killed,
    `say "The installer of <tag> did not end within <n> seconds, so it was stopped."`, and `install()` fails, so
    `install_new` goes back, and a hung install on the way back ends in today's `Could not go back` line. Then
    `drop_orphans` as today.
  - `health_url`: `HORNHOOF_HEALTH_URL` when set; else `http://front:8080/api/health` when `$SERVER_DIR/compose.yaml`
    (the file the build's installer just copied there) names the service `front`; else
    `http://app:8080/api/health`. `healthy` asks it on every try.
  - `interrupted()` at step `install` with a note whose `rev` is empty (an older updater ran this build's installer,
    which handed the update over, Task 8): `say "This build's updater goes on with the update."`; when `applied` still
    equals the note's `before` (nothing of the new build ran yet), `step backup "Saving the database again, now that
    the app is stopped."` and `backup`, whose failure goes to `go_back`, since this build's installer wrote `.env` and
    `compose.yaml` already; then `note`, `step install` and `install_new`. When `applied` differs, it goes on with the
    copy it has. Every other step, and a note with `rev` 2, as today.
  - `take_over()`, run as `updater.sh --take-over`, which the script checks first, before `interrupted` and the loops:
    the helper container this build's installer starts (Task 8). Unless `status.json` says `running` at step `install`
    and `recall` finds the note, it exits 0. Then `compose up -d --no-build --wait updater`, which replaces the older
    updater, and the installer waiting in it, with this build's. It exits 0 once `status.json`'s `log` has `This
    build's updater goes on with the update.`, within `${HORNHOOF_TAKE_OVER_WAIT:-60}` seconds. Otherwise (the compose
    command failed, or the line never came): `say "This build's updater did not start, so the build from before goes
    back."`, `write_status running rollback`, and `HORNHOOF_UPDATER_REF=<the note's back.updater> compose up -d
    --no-build updater`, so the older updater starts again, finds step `rollback` and goes back (`interrupted`,
    `go_back`). When that compose command fails too: `stop_with failed "No updater could start. Hornhoof still runs the
    build from before; run install.sh server in $SERVER_DIR." finished`.
  - The header comment says what revision 2 does, in the file's own voice.
- The stub's contract (`updater-stubs/docker`), for the tests:
  - `STUB_BUILD_SERVICES` words `<tag>=<svc>,<svc>,...` answer `config --services` for a compose file of that build
    (the unpacked one under `$WORK/<tag>/`, and the one in the server folder, which the fake installer copies from
    `HORNHOOF_COMPOSE_FILE` as the real one does); unpacking writes the tag into the file as a comment so the stub can
    tell; `STUB_SERVICES` stays the answer for any other file.
  - `STUB_PROJECT_CONTAINERS` words `<id>=<service>` answer `ps -a --filter`. `rm -f` is logged; `rm -f` of a
    container of service `front` also removes `$STUB_STATE/port-holder`.
  - The fake installer logs `HORNHOOF_UPDATER_REV=<value>`. For a build whose services name `front` it writes
    `$STUB_STATE/port-holder`, since `front` then holds the web port; for a build without `front` it fails with
    `Bind for 0.0.0.0:8080 failed: port is already allocated` while that file exists.
  - `STUB_HANDS_OVER` names builds whose installer, run without `HORNHOOF_UPDATER_REV`, copies its compose file into
    the server folder, logs `installer hands over`, and stops the updater running it (`kill -9 $PPID`), as compose
    replacing that updater does; with `STUB_HANDOVER=fail` it exits 1 with `Could not start the updater of this build,
    so nothing changed.` instead. `STUB_HANG` names builds whose installer sleeps 60 s, its output in the install log.
  - Each `pg_dump` writes `-- copy <n>`, `n` counting the dumps in `$STUB_STATE/copies`, and a restore keeps the copy
    it loaded in `$STUB_STATE/restored-copy`; `STUB_DUMP=fail` makes `pg_dump` fail. `start <id>` of a container other
    than the computer's is logged and does nothing else.
  - Each `compose up` naming `updater` logs `updater up HORNHOOF_UPDATER_REF=<value or empty>`; with
    `STUB_UPDATER_UP=fail` it fails unless `HORNHOOF_UPDATER_REF` is set in its environment.

- [ ] **Step 1: Write failing tests** in `updater.test.ts`. In these new tests `STUB_BUILD_SERVICES` has `0.4.1` name
  `db, app, front, keeper, migrate, node, updater` and `0.4.0` name `db, app, node, tunnel, updater`, unless a test
  says otherwise; the tests there today keep their stubs. `runRev1` runs `updater-rev1.sh --once` as `runOnce` runs the
  updater, on the same stand and stubs.
  - `tells each build's installer that this updater is revision 2`: the `installer server` line carries
    `HORNHOOF_UPDATER_REV=2`.
  - `stops the app before it saves the database, and starts it again when the copy fails`: `docker compose stop app`
    comes before `docker exec dbcid pg_dump`; with `STUB_DUMP=fail` the state is `failed` with `Could not save the
    database, so nothing changed.`, `docker start appcid` comes after the dump, and no installer ran.
  - `removes the containers of services the new build does not name, before its installer runs`: with
    `STUB_PROJECT_CONTAINERS='c-db=db c-app=app c-tunnel=tunnel c-up=updater'`, the log has `docker rm -f c-tunnel`
    before the new build's `installer server` line, and no `docker rm -f c-db`, `c-app` or `c-up`.
  - `goes back to a build from before front even though front held the web port`: the new build is broken
    (`STUB_BROKEN='0.4.1'`) and the project has `c-front=front c-keeper=keeper c-migrate=migrate` besides; after the
    failed health check the log has `docker rm -f c-front`, `c-keeper` and `c-migrate` before the old build's
    `installer server` line, that installer succeeds, and the state ends `rolled_back`.
  - `removes nothing when the build's compose file names no updater`: no `docker rm -f` line.
  - `checks health at front for a build that has it, and at the app for one that does not`: the curl lines name
    `http://front:8080/api/health` after installing a build with `front`, and `http://app:8080/api/health` after going
    back to one without it.
  - `stops an installer that does not end, and goes back`: `STUB_HANG='0.4.1'`, `HORNHOOF_INSTALL_WAIT: '2'`: the
    state ends `rolled_back`, its log has `The installer of 0.4.1 did not end within 2 seconds, so it was stopped.`,
    and `docker compose stop migrate app` comes before the old build's `installer server` line.
  - `moves in by handing over, and goes back to the old build when the new one fails`: `runRev1` with
    `STUB_HANDS_OVER='0.4.1'`, `STUB_BROKEN='0.4.1'`, `STUB_MIGRATIONS='0.4.0=20 0.4.1=21'` and the containers
    `c-db=db c-app=app c-tunnel=tunnel c-up=updater` stops at `running`/`install` after `installer hands over`. Then
    `runOnce(s, null, ...)`, as the new updater's container starts, with `c-front=front c-keeper=keeper
    c-migrate=migrate` added: the status log has `This build's updater goes on with the update.`; `docker compose stop
    app` comes before its `pg_dump` (copy 2); the 0.4.1 installer runs with `HORNHOOF_UPDATER_REV=2`; after the failed
    check at `http://front:8080/api/health`, `restored-copy` is 2, `docker rm -f c-front`, `c-keeper` and `c-migrate`
    come before the 0.4.0 `installer server` line, which succeeds; the state ends `rolled_back`, the last curl asks
    `http://app:8080/api/health` and gets commit `aaa`, and `.env` has `HORNHOOF_VERSION=0.4.0`.
  - `stays on the old build, working, when the new installer cannot start the hand-over helper`: `runRev1` with
    `STUB_HANDS_OVER='0.4.1'` and `STUB_HANDOVER=fail` ends `rolled_back` in that one run; its log has `Could not start
    the updater of this build, so nothing changed.`; there is no `docker rm -f` call and no call naming
    `hornhoof_restore`; the last curl gets commit `aaa`; `.env` has `HORNHOOF_VERSION=0.4.0`.
  - `brings the older updater back to go back when this build's updater does not start`: after `runRev1` stopped at
    `running`/`install` as above, `updater.sh --take-over` with `STUB_UPDATER_UP=fail` and `HORNHOOF_TAKE_OVER_WAIT:
    '1'` leaves `status.json` `running`/`rollback` with `This build's updater did not start, so the build from before
    goes back.`, and the calls have `updater up HORNHOOF_UPDATER_REF=<0.4.0's updater by digest>`; then `runRev1` ends
    `rolled_back` and the last curl gets commit `aaa`. With the line already in `status.json`, `--take-over` makes one
    `compose up -d --no-build --wait updater` call and changes `status.json` in nothing; with state `done` it makes no
    call.
  - The test at line 101 (`http://app:8080/api/health`) keeps passing, since `STUB_SERVICES` names no `front`, and
    the restore test's `at(r.calls, 'docker compose stop app')` now finds the stop before the copy, still before the
    swap.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts`. Expected: FAIL (no
  revision, no stop before the copy, no removal, no time limit, no take-over, health always at the app).
- [ ] **Step 3: Implement** the interfaces above in `apps/updater/updater.sh`, the fixture, and the stub's contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Stop the app before the database copy, remove the services a build does not name, and take
  over an update an older updater began".

### Task 2: Migrations leave the app's start

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/db-pool.test.ts test/migrate.test.ts
test/cli.test.ts` passes, and from the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/migrate.ts`
- Modify: `apps/server/src/db/client.ts`, `apps/server/src/main.ts`, `apps/server/src/cli.ts`,
  `apps/server/package.json` (`dev`: `tsx src/migrate.ts && tsx watch src/main.ts`; `start`: `node dist/migrate.js &&
  node dist/main.js`)
- Test: `apps/server/test/db-pool.test.ts`, `apps/server/test/migrate.test.ts` (new)

**Interfaces:**
- Produces, in `db/client.ts` (`createDb` goes):
  ```ts
  export const APP_NAME = 'hornhoof-app';
  export const MIGRATE_NAME = 'hornhoof-migrate';
  export const KEEPER_NAME = 'hornhoof-keeper';
  export function openPool(url: string, onDropped: (err: Error) => void, name: string, opts?: { statementTimeoutMs?: number }): pg.Pool;
  //   pg.Pool with application_name = name, and statement_timeout only when given
  export function openDb(url: string, name: string, opts?: { statementTimeoutMs?: number }): Db;  // no migrations
  export async function migrateDb(url: string): Promise<number>;
  //   drizzle's migrate on a pool named MIGRATE_NAME with no timeouts; answers SELECT count(*) FROM
  //   drizzle.__drizzle_migrations afterwards, and ends its pool in every case
  ```
- Produces, in `migrate.ts`:
  ```ts
  export async function runMigrate(env: NodeJS.ProcessEnv, print: (line: string) => void): Promise<number>;
  //   no DATABASE_URL: prints 'DATABASE_URL is not set.' and gives 1; success: prints
  //   'The database is up to this build: <n> migrations.' and gives 0; a failure: prints
  //   'Could not bring the database up to this build: <loggable(err).message>' and gives 1
  ```
  run as an entry point the way `cli.ts` is (`realpathSync(process.argv[1])` against `import.meta.url`), exiting with
  its number.
- `main.ts` opens `openDb(url, APP_NAME)`; `cli.ts` opens `openDb(url, APP_NAME)`. Neither migrates any more.
  `openAgentSql` is unchanged.

- [ ] **Step 1: Write failing tests.**
  - `db-pool.test.ts`, `names each pool to Postgres`: `openPool(url, () => {}, 'hornhoof-keeper', {
    statementTimeoutMs: 2000 }).options` has `application_name: 'hornhoof-keeper'` and `statement_timeout: 2000`;
    `openPool(url, () => {}, 'hornhoof-app').options` has `application_name: 'hornhoof-app'` and no
    `statement_timeout`. The existing test changes only its call to the new signature.
  - `migrate.test.ts`: `says what is missing without a database address`: `runMigrate({}, print)` gives 1 and prints
    `DATABASE_URL is not set.`; `fails plainly when the database does not answer, and hides the password`:
    `runMigrate({ DATABASE_URL: 'postgres://hornhoof:s3cret@127.0.0.1:1/hornhoof' }, print)` gives 1, its one line
    starts with `Could not bring the database up to this build:` and does not contain `s3cret`.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (`runMigrate` and the new `openPool` do not exist).
- [ ] **Step 3: Implement** the interfaces above. A real run of the migrations is Task 7's compose and Task 11's
  rehearsal; plan 3 brings a real Postgres to the tests.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run migrations from their own entry point, not from the app's start".

### Task 3: The app's modes

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/app-mode.test.ts test/version.test.ts
test/health.test.ts test/config.test.ts test/socket.test.ts` passes, and from the worktree root `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/state.ts`, `apps/server/src/modules/keeper/app-mode.ts`
- Modify: `apps/server/src/config.ts` (`keeper`), `apps/server/src/errors.ts` (three reasons), `apps/server/src/app.ts`
  (`ctx.mode`, the gate, `/api/health`, lead work), `apps/server/src/modules/agents/timers.ts` (`startTimers`)
- Test: `apps/server/test/app-mode.test.ts` (new), `apps/server/test/version.test.ts` (its health equality, line 15,
  gains `mode: 'lead'`), `apps/server/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // modules/keeper/state.ts
  export const KEEPER_FILE = 'keeper.json';
  export type Mode = 'lead' | 'read' | 'maintenance' | 'off';
  export type KeeperState = { mode: Mode; at: string; link: { host: string | null; fingerprint256: string | null } | null };
  export function readKeeperState(dir: string): KeeperState | null;   // null when missing or not this shape (zod)
  export function writeKeeperState(dir: string, state: KeeperState): void;  // written whole, then renamed; mode 0644
  export function freshState(dir: string, now: number, staleMs?: number): KeeperState | null;  // null unless at is within staleMs (10000)
  // modules/keeper/app-mode.ts
  export class AppMode {
    constructor(opts: { dir: string; fromKeeper: boolean; everyMs?: number; staleMs?: number; now?: () => number; log: (line: string) => void });
    current(): Mode;
    start(): void;          // without a keeper: lead at once; with one: check() now and every everyMs (1000)
    stop(): Promise<void>;  // stops reading, and runs the leave hooks when in lead
    check(): Promise<void>; // reads keeper.json once; a fresh word sets the mode; awaits the hooks of a change
    whenLead(enter: () => unknown, leave: () => unknown): void;  // enter on every change into lead, leave on every change out
  }
  export function modeGate(mode: AppMode): (req: FastifyRequest) => Promise<void>;
  export function whileLeading<A extends unknown[]>(mode: AppMode, work: (...args: A) => Promise<void>): (...args: A) => Promise<void>;
  //   runs work only while mode.current() is 'lead', checked when the call runs; else resolves and does nothing
  // config.ts: keeper: boolean, from HORNHOOF_KEEPER: 'on' gives true, unset or empty false, anything else throws
  //   'HORNHOOF_KEEPER must be on, or not set.'
  // errors.ts: ErrorReason gains 'maintenance' | 'read_only' | 'starting'
  // app.ts: Ctx gains mode: AppMode
  ```
- `AppMode`: before its first fresh word the mode is `off`; a stale, missing or unreadable `keeper.json` changes
  nothing. Hooks run in the order they were registered; a hook registered while in `lead` is entered at once; a
  throwing hook is one log line and stops neither the others nor the change. Each change logs `Hornhoof now runs in
  <mode> mode.`
- `modeGate`, an `onRequest` hook added right before `fromOwnPages` (after the socket plugin, so a refused socket is
  closed by it). `lead`: nothing. `read` and `maintenance`: `GET`, `HEAD` and `OPTIONS` pass unless the request carries
  `Upgrade: websocket`; anything else throws `new ApiError(503, 'unavailable', <message>, <reason>)`, reason
  `read_only` or `maintenance`. `off`: only `GET /api/health` passes; the rest throws with reason `starting`. Messages:
  `read_only` 'Hornhoof only reads on this machine now, so nothing was changed.'; `maintenance` 'Hornhoof is installing
  an update and takes no changes until it ends.'; `starting` 'Hornhoof is starting.'
- `GET /api/health`: in `off` the status is 503 and `ok` is false; elsewhere 200 and `ok: true`. Over the link the body
  stays `{ ok }` (1b); elsewhere it is `{ ok, version, commit, mode }`.
- In `app.ts`: `ctx.mode = new AppMode({ dir: config.controlDir, fromKeeper: config.keeper, log })`, started in
  `onReady` and stopped in `onClose`, in place of today's three hooks at lines 98-100. Lead work goes through
  `whenLead`: `ctx.updates.start()`/`stop()`, `ctx.links.sync()` on the way in, and `startTimers`, whose
  `wakeLeftBehind` and `dropOldFiles` run on the way in and whose minute timer runs only while leading; its leave
  hook clears the timer and waits for a minute round that runs. Leaving `lead` closes every open WebSocket:
  `app.websocketServer.clients`, each with `close(1012, 'Hornhoof takes no changes now.')`. `NodeHub`'s `onMessage` and
  `onClose` are `whileLeading(ctx.mode, ...)` of today's handlers, so a message still queued when the app leaves `lead`
  writes nothing. 1b's `handOverSession` hook does nothing unless `ctx.mode.current()` is `lead`. Without a keeper
  every test sees what it saw before: lead from `onReady`.

- [ ] **Step 1: Write failing tests** in `app-mode.test.ts`:
  - `leads at once without a keeper`.
  - `is off until the keeper writes, then takes its mode`: no file, `check()` leaves `off`; a state `lead` with `at`
    now, `check()` gives `lead`; one `maintenance`, `maintenance`.
  - `keeps its mode when the keeper's word is stale or unreadable`: in `lead`, a state `maintenance` with `at` 11 s ago
    and then a file `{"mode":"nope"}` each leave `lead`.
  - `runs lead work on the way in and out`: enters and leaves counted over `lead`, `maintenance`, `lead`, `stop()`
    (2 and 2); a hook registered while leading is entered at once; a throwing enter hook still lets the next run; a
    leave hook that resolves after 200 ms is awaited by the `check()` that leaves.
  - `does lead work only while leading`: a `whileLeading` wrapper calls its work in `lead`, and in `maintenance` and
    `off` resolves without calling it; a call made in `lead` that runs after the change to `maintenance` (queued behind
    a slower one, as `NodeHub` queues messages) does not call it.
  - With `testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir })`, `dir` a fresh temp folder:
    - `answers only health while off`: from `127.0.0.1`, `GET /api/health` is 503 with `{ ok: false, version, commit,
      mode: 'off' }`; `GET /api/me` is 503 with reason `starting`.
    - `serves reads and refuses changes in maintenance`: written `lead` before `testApp`, `setUpCompany`, then
      `maintenance` written and `until` health says `maintenance`; `GET /api/me` with the session is 200; `POST
      /mcp` and a sign-in (`POST /api/auth/login`) are 503 with reason `maintenance`; an `inject` with `upgrade:
      websocket` headers on `/api/nodes/socket` is 503.
    - `answers read_only in read`: the same with `read` and reason `read_only`.
    - `hands over no session outside lead`: in `maintenance`, a `GET /api/me` over the link (`viaLink()` with only an
      `hh_session` cookie, of a session row set to `before_host_cookie` true) sets no `__Host-hh_session`, and the
      row's `expires_at` and the count of session rows stay as they were.
    - `closes open sockets when it leaves lead`: a built-in node connected as `socket.test.ts` does (`listen`,
      `connectNode`) is closed with code 1012 within 2 s of `maintenance` being written, and a new connection is
      refused while it holds.
  - `config.test.ts`: `HORNHOOF_KEEPER` `on` gives `keeper: true`; unset `false`; `yes` throws the message above.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (no `AppMode`, no gate, no `mode` in health).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when**, then the whole server suite once (`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run`
  from `apps/server`), since lead work moved. Expected: PASS.
- [ ] **Step 5: Commit** "Run the app in the mode the keeper gives it: lead, read, maintenance or off".

### Task 4: The pass-through and `front`

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** main with plan 1b merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/proxy.test.ts test/front.test.ts` passes, and from
the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/net/proxy.ts`, `apps/server/src/net/front.ts`, `apps/server/src/front.ts`
- Test: `apps/server/test/proxy.test.ts`, `apps/server/test/front.test.ts` (both new)

**Interfaces:**
- Produces:
  ```ts
  // net/proxy.ts
  export type Target = { host: string; port: number };
  export type Refusal = { status: number; headers: Record<string, string>; body: string };
  export type PassOptions = {
    target: Target;
    /* What this hop adds, read from the request as it came in. */
    headers: (req: http.IncomingMessage) => Promise<Record<string, string>> | Record<string, string>;
    /* The answer to a request or an upgrade the target did not take: refused, reset before an answer, or not
       connected within connectMs. */
    unreachable: (req: http.IncomingMessage) => Refusal;
    connectMs?: number;  // 5000
  };
  export function passThrough(opts: PassOptions): {
    request: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  };
  export function socketAddress(req: http.IncomingMessage): string;  // remoteAddress without ::ffff:
  export function firstForwarded(req: http.IncomingMessage): string;  // first entry of x-forwarded-for, trimmed, or ''
  export function startingAnswer(req: http.IncomingMessage): Refusal;  // the 502 below
  export function serve(handlers: ReturnType<typeof passThrough>): http.Server;
  //   http.createServer({ requestTimeout: 0, headersTimeout: 60_000 }), both given, since requestTimeout 0 alone also
  //   turns headersTimeout off on Node 22; request and upgrade wired
  // net/front.ts
  export function startFront(opts: { port: number; host?: string; keeper: Target }): Promise<http.Server>;
  //   listens (host default 0.0.0.0); headers(): { 'x-forwarded-for': socketAddress(req) }; unreachable: startingAnswer
  ```
- `passThrough` drops, from what came in, the hop-by-hop headers (`connection` and the names it lists, `keep-alive`,
  `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade` except on an upgrade), every `x-forwarded-for`,
  `x-forwarded-proto` and `x-hornhoof-*` header, then adds `headers(req)`. `host`, `x-forwarded-host` and every other
  header pass as they came. Each request opens its own connection (`agent: false`). Bodies stream both ways as they
  come, with no timeout once the answer has begun; when either side closes, the other is destroyed. An upgrade is sent
  with its `Upgrade` and `Connection` headers; a 101 answer is written back to the client's socket as it came and the
  two sockets are piped both ways (with `head` written first); any other answer is written back and the socket ended.
  Node takes its own `error` handler off a socket it hands to `upgrade`, so `upgrade` puts one on the client's socket
  first, before anything is awaited, and one on the target's socket as it is made: an error or a close on either
  destroys both and goes no further.
- `startingAnswer`: 502, `Retry-After: 5`; for a path under `/api/` or `/mcp`, `application/json`
  `{"error":{"code":"unavailable","message":"Hornhoof is starting.","reason":"starting"}}`; otherwise `text/plain;
  charset=utf-8` with the two lines `Hornhoof is starting. Try again in a few seconds.` and `Hornhoof запускается.
  Попробуйте еще раз через несколько секунд.` An upgrade gets the same status line and body, then the socket ends.
- `front.ts`: `startFront({ port: 8080, keeper: { host: 'keeper', port: 7080 } })`, and on SIGINT or SIGTERM the server
  closes and the process exits 0.

- [ ] **Step 1: Write failing tests.** `proxy.test.ts`, with a target on `127.0.0.1:0` (`http.createServer`, and a
  `ws` `WebSocketServer` on it) behind `serve(passThrough(...))` on `127.0.0.1:0`:
  - `passes a request, its body and its answer`: a 1 MiB POST arrives whole (same SHA-256); a 201 with a header of its
    own comes back as it was.
  - `streams an answer as it comes`: the target writes `data: 1\n\n`, waits 300 ms, writes `data: 2\n\n`; the client
    reads the first chunk before the target writes the second.
  - `keeps a quiet stream open`: a stream that sends nothing for 3 s still delivers its next chunk.
  - `passes WebSockets both ways and closes them together`: a message goes each way; closing the client closes the
    target's socket within 1 s, and the reverse.
  - `drops forwarding headers that came in and adds its own`: a request with `x-forwarded-for: 198.51.100.7`,
    `x-forwarded-proto: https` and `x-hornhoof-via: x` reaches the target with only the headers `headers()` gave for
    those names; `host` and `x-forwarded-host: corp.hornhoof.test` arrive as sent.
  - `answers for a target that is down`: with the target closed, `GET /api/x` gets 502, `Retry-After: 5` and the JSON
    above; `GET /` gets the two text lines; a WebSocket gets `Unexpected server response: 502`.
  - `takes no request on a connection the target closed while idle`: two requests 6 s apart to a target with
    `keepAliveTimeout` 5000 both get 200.
  - `outlives a client that resets during an upgrade`: a raw socket that sends a WebSocket upgrade and calls
    `resetAndDestroy()` before the target answers (the target holds its 101 for 200 ms), and one that does so right
    after the 101: no error escapes (the test process sees no uncaught one), and a `GET` afterwards gets 200.
  - `front.test.ts`: `names the visitor by the socket and nothing else`: through `startFront` to a target that echoes
    headers, a request with a forged `x-forwarded-for` arrives with `x-forwarded-for: 127.0.0.1` and no
    `x-forwarded-proto`; `startFront`'s server has `requestTimeout` 0 and `headersTimeout` 60000.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (no modules).
- [ ] **Step 3: Implement** `net/proxy.ts`, `net/front.ts` and `front.ts`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add front, which serves the web port and passes everything to the keeper".

### Task 5: The keeper's mode and its doors to the app

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 2, 3 and 4 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper.test.ts test/config.test.ts` passes, and from
the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/updater-status.ts`, `apps/server/src/modules/keeper/keeper.ts`,
  `apps/server/src/keeper.ts`
- Modify: `apps/server/src/config.ts` (`machineId`; `TUNNEL_HOST`'s message becomes `TUNNEL_HOST must be the host name
  of the keeper container, like keeper.`)
- Test: `apps/server/test/keeper.test.ts` (new), `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: `passThrough`, `serve`, `socketAddress`, `firstForwarded`, `startingAnswer`, `Target` (Task 4);
  `writeKeeperState`, `Mode` (Task 3); `openDb`, `KEEPER_NAME` (Task 2).
- Produces:
  ```ts
  // modules/keeper/updater-status.ts
  export function updaterBusy(dir: string): boolean | null;
  //   true: status.json says state 'running' and step 'backup' | 'install' | 'health' | 'rollback'; false: any other
  //   state or step, or no file; null: a file it cannot read, or not JSON with a string state (not known now)
  // modules/keeper/keeper.ts
  export const KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 } as const;
  export type KeeperOptions = {
    config: Config;
    db: Db | null;              // Task 6 reads the link with it
    app: Target;                // { host: 'app', port: 8080 }
    frontHost: string | null;   // 'front'; null: no socket on the front port is front
    log: (line: string) => void;
    host?: string;              // where the front port listens, default '0.0.0.0'
    ports?: { front?: number; linkHttp?: number; linkTls?: number };  // 0 in tests
    everyMs?: number;           // 1000
  };
  export class Keeper {
    constructor(opts: KeeperOptions);
    start(): Promise<{ front: number; linkHttp: number; linkTls: number }>;  // the ports it got (linkTls 0 until Task 6)
    stop(): Promise<void>;
    mode(): Mode;               // 'maintenance' while updaterBusy(config.controlDir) is true, 'lead' when false,
                                //   what it was when null ('lead' at start)
  }
  // config.ts: machineId: string | null, from HORNHOOF_MACHINE_ID: 32 or 64 lowercase hex digits, unset or empty null,
  //   anything else throws 'HORNHOOF_MACHINE_ID must be the hex install.sh writes. Remove the line from .env, or run
  //   the install command again.'
  ```
- The keeper writes `keeper.json` at start, every `everyMs` and at once on a change of mode, with `link: null` until
  Task 6 fills it. It serves two doors with `serve(passThrough(...))` to `opts.app`:
  - the front port (7080 on `host`): `x-forwarded-for` is `firstForwarded(req)` when the socket's address is one of
    `lookup(frontHost, { all: true })` and that entry is not empty, else `socketAddress(req)`; no `x-forwarded-proto`.
  - the link's `http` door (7081 on `127.0.0.1` only): `x-forwarded-for` is `firstForwarded(req)` or else the socket's;
    `x-forwarded-proto: https`.
  - `unreachable`: in `maintenance`, 503 with `Retry-After: 10`, the JSON body `{"error":{"code":"unavailable",
    "message":"Hornhoof is installing an update and takes no changes until it ends.","reason":"maintenance"}}` under
    `/api/` and `/mcp`, else `text/plain` `Hornhoof is installing an update. Try again in a few minutes.` and
    `Hornhoof ставит обновление. Попробуйте через несколько минут.`; otherwise `startingAnswer`.
- `keeper.ts`, the entry point: `loadConfig(process.env)`; `openDb(url, KEEPER_NAME, { statementTimeoutMs: 2000 })`
  when `DATABASE_URL` is set, else `null`; `new Keeper({ config, db, app: { host: 'app', port: 8080 }, frontHost:
  'front', log: line => console.log(line) })`; `start()`; on SIGINT or SIGTERM `stop()`, then exit 0.

- [ ] **Step 1: Write failing tests** in `keeper.test.ts`, each keeper with ports 0, `host: '127.0.0.1'`, a temp
  `HORNHOOF_CONTROL_DIR` and a target that echoes the request's headers as JSON:
  - `updaterBusy` cases: `running` with each of the four steps is true; `running` with `pull`, and `done`, `failed`,
    `rolled_back` and a missing file are false; `{` and `[]` are null.
  - `writes its mode every second, maintenance while the updater installs`: `keeper.json` says `lead` with `at`
    within 2 s of now; `status.json` `running`/`install` gives `maintenance` within 2 s; `done` gives `lead` again.
  - `keeps maintenance through a status file it cannot read`: after `running`/`install` gave `maintenance`, `{`
    written over `status.json` leaves `maintenance` for 3 s; `failed` then gives `lead`.
  - `takes the visitor from front and from nobody else`: on the front port with `x-forwarded-for: 203.0.113.5`,
    `frontHost: 'localhost'` passes `203.0.113.5`; `frontHost: 'front.invalid'` passes `127.0.0.1`.
  - `marks the link's http traffic as https, and only that`: on the link door the target gets `x-forwarded-proto:
    https` and the first entry of the `x-forwarded-for` sent; on the front port a sent `x-forwarded-proto: https`
    does not arrive.
  - `answers maintenance while the app is down during an update, and starting otherwise`.
  - `takes link traffic through the keeper as over the link, and front's as local`: a `testApp({ TUNNEL_HOST:
    'localhost' })` listening on `127.0.0.1:0` as the target, a company set up through `inject`; through the link door
    `GET /api/health` is exactly `{ ok: true }` and a sign-in sets `__Host-hh_session`; through the front port health
    carries `version` and a sign-in sets `hh_session`.
  - `config.test.ts`: `HORNHOOF_MACHINE_ID` of 32 and of 64 hex is kept; `XYZ` throws the message above; unset is
    `null`; the `TUNNEL_HOST` message test (line 56) takes the new message.
  - `config.test.ts`, `loads the keeper's environment and nothing more`: `loadConfig` of exactly `{ DATABASE_URL:
    'postgres://hornhoof:hornhoof@db:5432/hornhoof', HORNHOOF_SECRET: <32 random bytes, base64>, ACME_DIRECTORY: '',
    HORNHOOF_MACHINE_ID: '', RELAY_URL: '' }`, the keys Task 7's compose gives the keeper, as compose hands empty
    values over, does not throw; its `controlDir` is `/control`, `machineId` null, `acmeDirectory` Let's Encrypt's
    and `relayUrl` `https://hornhoof.org`, as the app's are for the same values.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL (no keeper).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the keeper: the app's mode, and the doors from front and the link to the app".

### Task 6: The link moves into the keeper

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 5 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/client.test.ts test/tunnel.test.ts
test/link-listener.test.ts test/keeper-link.test.ts test/link-tls.test.ts test/link.test.ts test/auth.test.ts` passes,
and from the worktree root `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/served.ts`
- Modify: `apps/server/src/modules/link/client.ts`, `apps/server/src/modules/link/tunnel.ts`,
  `apps/server/src/modules/link/link.ts`, `apps/server/src/modules/tls/listener.ts`,
  `apps/server/src/modules/tls/store.ts`, `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/auth/tunnel.ts`
  (no `linkVisitor`), `apps/server/src/main.ts`
- Delete: `apps/server/src/tunnel.ts`
- Test: `apps/server/test/client.test.ts`, `apps/server/test/tunnel.test.ts`, `apps/server/test/link-listener.test.ts`,
  `apps/server/test/keeper-link.test.ts` (new), `apps/server/test/auth.test.ts` (1b's cases on the listener's sockets
  go; Task 5 and this task's keeper tests cover that path)

**Interfaces:**
- Consumes: `Keeper`, `KEEPER_PORTS` (Task 5); `KEEPER_FILE`, `freshState` (Task 3); 1b's `LinkListener`,
  `linkVisitor`, `LINK_TLS_PORT`, `tlsOf`, `linkMode`, `certInfo`, `Served`, `LinkTls`.
- Produces:
  ```ts
  // modules/link/client.ts
  export type FrpcLocal = { http: { ip: string; port: number }; https: { ip: string; port: number } };
  export const linkClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-link`;
  export function configFor(settings: TunnelSettings, opts: { clientId: string; local: FrpcLocal }): string;
  export function clientFor(settings: TunnelSettings, opts: { clientId: string; local: FrpcLocal; dir?: string }): Client;
  // modules/link/tunnel.ts: TunnelKeeper's options lose `file` and gain
  //   read: () => Promise<TunnelSettings | null | undefined>   (undefined: not known now, the running client stays;
  //   null: no link, the client stops); a change is a change of JSON.stringify(settings)
  // modules/link/link.ts
  export async function tunnelSettings(db: Db, config: Config): Promise<TunnelSettings | null>;  // what writeTunnelSettings writes
  //   with its mode from readLinkMode, so a failed read of any table throws and never reads as a change
  // modules/tls/store.ts
  export async function readLinkMode(db: Db, config: Config): Promise<'http' | 'https'>;
  //   1b's rule, except that a failed database read throws; certificate data that does not pass still gives http.
  //   linkMode becomes readLinkMode(db, config).catch(() => 'http'), as 1b has it
  export async function servedCertificate(db: Db, config: Config): Promise<{ host: string; cert: { certPem: string; keyPem: string } | null } | null>;
  //   null without a link; cert: the link_tls row's certificate when its name is the link's, with its key decrypted
  // modules/tls/listener.ts: constructor(opts: { server: http.Server; log: FastifyBaseLogger | { warn(o: unknown, m?: string): void } })
  //   listen(port, host?) defaults host to 127.0.0.1, and every PROXY header is believed: only the keeper's frpc
  //   reaches that address
  // modules/keeper/served.ts
  export class KeeperServed implements Served {
    constructor(opts: { dir: string; timeoutMs?: number; everyMs?: number; now?: () => number });  // 20000, 500
    use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void>;
    //   resolves once a fresh keeper.json says link { host, fingerprint256 } with that host and
    //   cert ? certInfo(cert.certPem).fingerprint256 : null; throws 'The keeper does not serve this certificate yet.'
    //   after timeoutMs
  }
  // KeeperOptions gains clientFor?: (settings: TunnelSettings, clientId: string, local: FrpcLocal) => Client,
  //   and linkEveryMs?: number (3000), how often the link and its certificate are read
  ```
- `configFor`, `http` mode, exactly (with `https` mode's proxy block `type = "https"`, `localIP = "127.0.0.1"`,
  `localPort = <local.https.port>`, `transport.proxyProtocolVersion = "v2"` and no `requestHeaders` line):
  ```toml
  serverAddr = "<serverAddr>"
  serverPort = <serverPort>
  loginFailExit = false
  log.to = "console"
  log.level = "info"
  log.disablePrintColor = true
  clientID = "<clientId>"
  transport.protocol = "wss"
  transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
  transport.heartbeatInterval = -1
  transport.tcpMuxKeepaliveInterval = 10
  metadatas.name = "<name>"
  metadatas.key = "<key>"
  metadatas.client = "<clientId>"

  [[proxies]]
  name = "<name>"
  type = "http"
  subdomain = "<name>"
  localIP = "127.0.0.1"
  localPort = <local.http.port>
  ```
  `configFor` throws when `clientId` does not match `^[a-z0-9-]{1,63}-[0-9a-f]{8}-link$` or does not start with the
  link's name and a dash.
- The keeper, added to Task 5's: with `db` and `config.machineId`, a `TunnelKeeper` (`everyMs` `linkEveryMs`,
  `restartMs` 2000) whose `read` is `tunnelSettings(db, config)` with a throw read as `undefined`, and whose `clientFor`
  is `opts.clientFor` or `clientFor(settings, { clientId: linkClientId(settings.name, machineId), local })`, `local`
  being `127.0.0.1` with the link door's port and the TLS listener's. Without a machine id: no frpc, and once `The
  keeper carries no public link: HORNHOOF_MACHINE_ID is not set. Run the install command again.` A `LinkListener`
  handing its connections to a third `serve(passThrough(...))` server whose `x-forwarded-for` is
  `linkVisitor(req.socket)` or else the socket's, with `x-forwarded-proto: https`, listening on
  `127.0.0.1:<LINK_TLS_PORT>`. Every `linkEveryMs` `servedCertificate(db, config)`; a throw keeps what the listener has;
  a change of host or certificate is given to `use(host, cert)`, awaited, and only then `keeper.json`'s `link` becomes
  `{ host, fingerprint256 }` (null fingerprint for a stand-in, `{ host: null, fingerprint256: null }` without a link).
  `stop()` ends frpc and closes the listener.
- `main.ts` drops 1b's `LinkListener`. With `config.keeper`: `void ctx.tls.serveOn(new KeeperServed({ dir:
  config.controlDir })).catch(<one warning line>)`, and `ctx.mode.whenLead(() => ctx.tls.start(), () =>
  ctx.tls.stop())`; without a keeper nothing serves the link's TLS, so `LinkTls` is not started. The setup link is
  printed once, on the first way into `lead`. SIGINT and SIGTERM close the app and exit 0.
- `apps/server/src/tunnel.ts` goes; Task 7 removes its compose service.

- [ ] **Step 1: Write failing tests.**
  - `client.test.ts`: the exact `CONFIG` for `http` and for `https` mode as above, with `clientId
    'acme-ab12cd34-link'` and `local` `7081`/`8443`; `linkClientId('acme', 'ab12cd34' + '0'.repeat(24))` is
    `'acme-ab12cd34-link'`; a client id for another name throws; `clientFor` writes the file with mode 0600.
  - `tunnel.test.ts`: every case reads through `read` (the test sets what it answers); new: `keeps the client running
    while read answers undefined`, and `stops it when read answers null`.
  - `link-listener.test.ts`: the listener hands its connections to a plain `http.Server` that answers
    `linkVisitor(req.socket)`; a PROXY header from `127.0.0.1` with source `203.0.113.9` gives `203.0.113.9`;
    `listen(0)` listens on `127.0.0.1`. 1b's case that the header is believed only from the tunnel container goes.
  - `keeper-link.test.ts`, with `testApp`'s PGlite database, a link saved with `saveLink` and a fake frpc (an injected
    `clientFor` that writes `configFor(...)` to a file and starts a sleeping `node -e` child):
    - `runs frpc with the link's client id and the network transport, pointed at itself`: the config has `clientID =
      "acme-ab12cd34-link"`, `transport.heartbeatInterval = -1` and `localPort = <the link door's port>`.
    - `runs https when linkMode says so`: with `ACME_DIRECTORY` an https address in the keeper's config (with `off`,
      1b's `linkMode` always says `http`), a `link_tls` row in `https` with a `selfSigned` certificate for the host
      (as 1b's `linkMode` tests make one) gives the `https` block at the TLS listener's port.
    - `keeps frpc in https when only the certificate's read fails`: in `https` mode as above, a `db` that answers the
      `public_links` read and throws on the `link_tls` one makes `tunnelSettings` throw, and the keeper keeps the
      same child, the `https` block and the served certificate for 10 reads.
    - `keeps frpc and the certificate when the database does not answer`: with `linkEveryMs` 50, after the first read
      a `db` whose queries throw leaves the same child running and the same certificate served for 10 reads.
    - `uses the same client id after the keeper starts again`: a second keeper with the same machine id, started
      after the first stopped, writes the same `clientID`.
    - `stops frpc when the link goes`.
    - `serves the link's stored certificate and names it in keeper.json`: a TLS client with servername the host, sent
      a PROXY v2 header first, sees a peer certificate whose `fingerprint256` is the stored one's, and `keeper.json`
      says the same; a `link_tls` row for another name gives a stand-in and `fingerprint256: null`.
    - `passes link TLS traffic to the app with the visitor from the PROXY header`: the echoing target gets
      `x-forwarded-for: 203.0.113.9` and `x-forwarded-proto: https`.
    - `runs no link without a machine id`: no child, and the line above once.
    - `KeeperServed`: resolves once `keeper.json` names that host and fingerprint; throws after `timeoutMs` (100 in the
      test) otherwise; does not take a `keeper.json` whose `at` is 11 s old.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. 1b's `link-tls.test.ts` passes as it is, since it gives `LinkTls` a
  fake `Served`.
- [ ] **Step 4: Run Done when**, then the whole server suite once. Expected: PASS.
- [ ] **Step 5: Commit** "Carry the public link from the keeper, with the network's client id, and end its TLS there".

### Task 7: Compose, the image and the database's settings

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 2, 4, 5 and 6 committed. **Done when:**
from `apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/compose.test.ts test/pins.test.ts` passes, and
`npm run build` from the worktree root leaves `apps/server/dist/front.js`, `keeper.js` and `migrate.js` and no
`tunnel.js` (after `rm -rf apps/server/dist` first).

**Files:**
- Modify: `compose.yaml`, `Dockerfile` (the frpc comment at line 40: the keeper runs frpc as its child)
- Test: `apps/server/test/compose.test.ts`, `apps/server/test/pins.test.ts` (its ordered `image:` list, lines 51-61)

**Interfaces:**
- Consumes: the three entry points (Tasks 2, 4, 5).
- `compose.yaml`, in this order: `front`, `keeper`, `migrate`, `app`, `db`, `node`, `updater`. The `tunnel` service
  goes. New and changed parts, each with a short comment in the file's own voice:
  ```yaml
  front:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/front.js"]
    restart: unless-stopped
    ports:
      - "${HORNHOOF_PORT:-8080}:8080"
    depends_on:
      - keeper
    networks:
      - default
  keeper:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/keeper.js"]
    restart: unless-stopped
    ports:
      - "${HORNHOOF_PEER_PORT:-8180}:7070"
    environment:
      DATABASE_URL: postgres://hornhoof:${POSTGRES_PASSWORD:-hornhoof}@db:5432/hornhoof
      HORNHOOF_SECRET: ${HORNHOOF_SECRET:?Set HORNHOOF_SECRET in .env}
      ACME_DIRECTORY: ${ACME_DIRECTORY:-}
      RELAY_URL: ${RELAY_URL:-}
      HORNHOOF_MACHINE_ID: ${HORNHOOF_MACHINE_ID:-}
    volumes:
      - control:/control
    depends_on:
      db:
        condition: service_healthy
    networks:
      - default
      - internal
  migrate:
    build: .
    image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}
    command: ["node", "apps/server/dist/migrate.js"]
    restart: "no"
    environment:
      DATABASE_URL: postgres://hornhoof:${POSTGRES_PASSWORD:-hornhoof}@db:5432/hornhoof
    depends_on:
      db:
        condition: service_healthy
    networks:
      - internal
  ```
  `app` loses `ports`; its environment gains `HORNHOOF_KEEPER: "on"` and `TUNNEL_HOST: keeper` (with the comment: the
  one container whose word on https and on the visitor's address the app believes); its `depends_on` is `db`
  (`service_healthy`), `migrate` (`service_completed_successfully`) and `keeper` (`service_started`). `db` gains
  `command: ["postgres", "-c", "wal_level=logical", "-c", "max_replication_slots=10", "-c", "max_wal_senders=10",
  "-c", "max_prepared_transactions=0"]`. `node` and `updater` stay as they are.

- [ ] **Step 1: Write failing tests** in `compose.test.ts` (the "tunnel service" describe goes):
  - `has no tunnel, and front alone publishes the web port`: no `tunnel` service; `front.ports` is
    `['${HORNHOOF_PORT:-8080}:8080']`; `app` has no `ports`; no other service names `HORNHOOF_PORT`.
  - `runs front, keeper and migrate from the app's own image`: each `image` equals `app.image`, and each `command` is
    `['node', 'apps/server/dist/<name>.js']`, whose `apps/server/src/<name>.ts` exists.
  - `gives the keeper the peer port, the database, the control folder and nothing of Docker`: its port, its
    `environment` keys exactly `DATABASE_URL`, `HORNHOOF_SECRET`, `ACME_DIRECTORY`, `RELAY_URL`,
    `HORNHOOF_MACHINE_ID`, `volumes` exactly `['control:/control']`, no `docker.sock` anywhere in it, networks
    `default` and `internal`.
  - `gives the keeper the app's value of every setting the link is read with`: the app's and the keeper's
    `environment` from the file, each `${NAME:-default}` and `${NAME:?...}` filled from one sample `.env` (a random
    `HORNHOOF_SECRET`, `NODE_KEY`, `POSTGRES_PASSWORD` `pw`, `ACME_DIRECTORY` `https://acme.hornhoof.test/directory`,
    `RELAY_URL` `https://relay.hornhoof.test`, `HORNHOOF_MACHINE_ID` 32 hex) and then from one with only the two
    required lines; for each, `loadConfig` of both answers the same `databaseUrl`, `secret`, `acmeDirectory` and
    `relayUrl`, and the keeper's `controlDir` is `/control`. These are the `Config` fields `tunnelSettings`,
    `readLinkMode` and `servedCertificate` read, with `relayUrl` in case the link's host is taken from it; when the
    agent finds them reading another one, it joins the list, the keeper gets the app's line for it, and the exact key
    list above grows by it.
  - `starts the app only after migrate ended well, and the app believes only the keeper`: `app.depends_on.migrate` is
    `{ condition: 'service_completed_successfully' }`; `migrate.restart` is `'no'` and its network `internal` only;
    `app.environment.TUNNEL_HOST` is `'keeper'` and `HORNHOOF_KEEPER` is `'on'`.
  - `starts the database with what logical copies need`: `db.command` as above.
  - `loads with a .env from before this build`: every `${...}` in the file has `:-` or is `HORNHOOF_SECRET` or
    `NODE_KEY` with `:?`.
  - `pins.test.ts`: the ordered `image:` list is four times the app's line (`front`, `keeper`, `migrate`, `app`),
    then postgres, the node's and the updater's; the comment on the tunnel's line goes; the frpc pin test stays.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Change** `compose.yaml` and the Dockerfile comment.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Run front, keeper and migrate in place of the tunnel, and start the database for logical
  copies".

### Task 8: The installer: start order, the machine id, handing over to the new updater

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 1 and 7 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts` passes; from the worktree
root, `bash -n scripts/install.sh` and `shellcheck scripts/install.sh` print nothing.

**Files:**
- Modify: `scripts/install.sh` (`start_server_services`, `server_mode`), `apps/server/test/install-stubs/docker`
- Test: `apps/server/test/install-script.test.ts`

**Interfaces:**
- Consumes: `updater.sh --take-over` (Task 1), the helper's job.
- `start_server_services`, every step through the compose command it is given, in this order:
  1. `stop app` (its output and status ignored).
  2. `up -d --no-build --remove-orphans --wait db`; on failure `fail "The database did not start. Run docker compose
     logs db in $SERVER_DIR to see why."`
  3. `up -d --no-build keeper front` (Task 9 wraps this one in its port retry).
  4. As today's four cases, without `db` and `tunnel`: from the updater with the node unchanged `up -d --no-build app`;
     from the updater otherwise `up -d --no-build app node`, then `sweep_nodes`; by hand with the node unchanged `up -d
     --no-build app updater`; by hand otherwise `up -d --no-build`. compose runs `migrate` first, since `app` waits for
     it. When the output says `migrate` did not complete, `fail "Hornhoof could not bring its database up to this
     build. Run docker compose logs migrate in $SERVER_DIR to see why."`; any other failure fails as today.
- `HORNHOOF_MACHINE_ID` is written into `.env`, with its other lines and before `compose.yaml`, only when `.env` has
  none: by hand `host_id`'s value, from the updater `od -An -N16 -tx1 /dev/urandom | tr -d ' \n'`.
- The handover: when `HORNHOOF_FROM_UPDATER` is set and `${HORNHOOF_UPDATER_REV:-1}` is below 2, right after
  `compose.yaml` is in the server folder and before anything else starts or is downloaded: `say "This build's updater
  takes over the update first."`, then `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v
  "$SERVER_DIR:$SERVER_DIR" -v "<project>_control:/control" -e "HORNHOOF_SERVER_DIR=$SERVER_DIR" "$UPDATER_REF"
  --take-over`, `<project>` being the `COMPOSE_PROJECT_NAME` just written to `.env` (compose names the control volume
  so); its failure is `fail "Could not start the updater of this build, so nothing changed."` Then `sleep
  "${HORNHOOF_HANDOVER_WAIT:-300}"`, then `fail "The updater of this build did not take over, so nothing changed. Run
  install.sh server in $SERVER_DIR."` The helper replaces the updater this runs under, and with it this script; the
  new updater goes on with the update. Until then nothing but `.env` and `compose.yaml` has changed, and the old
  installer writes both back on the way back.
- The stub's contract (`install-stubs/docker`): `STUB_MIGRATE=fail` makes a `compose ... up` that names `app`, or
  names no service, fail with `service "migrate" didn't complete successfully: exit 1`; `run -d` is logged as it is,
  and with `STUB_RUN=fail` it fails with `docker: Error response from daemon: failed to create task`.

- [ ] **Step 1: Write failing tests** in `install-script.test.ts`. Every test that runs with `HORNHOOF_FROM_UPDATER`
  gains `HORNHOOF_UPDATER_REV: '2'`, and the exact `up` strings at lines 431, 576, 660, 675, 763 and 784 become the
  new step 4 strings (`db app node tunnel` is now `app node`, `db app tunnel` is `app`, `db app tunnel updater` is
  `app updater`; the two `up -d --no-build` lines stay). New:
  - `starts the database, then the keeper and front, then the app, which migrates first`: in `calls`, `docker compose
    stop app` < `docker compose up -d --no-build --remove-orphans --wait db` < `docker compose up -d --no-build keeper
    front` < `docker compose up -d --no-build`.
  - `says where to look when the database cannot be brought up to this build`: `STUB_MIGRATE=fail` exits 1 with the
    message above.
  - `writes the machine id once: the host id by hand, a random one from the updater`: by hand `.env` gets
    `HORNHOOF_MACHINE_ID` equal to its `HORNHOOF_HOST_ID`; from the updater with no id, 32 hex digits; an existing
    `HORNHOOF_MACHINE_ID=` line stays as it was in both cases, and there is one such line.
  - `hands an update to this build's updater when an older updater runs it`: with `HORNHOOF_FROM_UPDATER: '1'`, no
    `HORNHOOF_UPDATER_REV`, `HORNHOOF_HANDOVER_WAIT: '1'` and a pinned `HORNHOOF_UPDATER_REF`: `.env` and
    `compose.yaml` are written; the calls have `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v
    <dir>:<dir> -v <project>_control:/control -e HORNHOOF_SERVER_DIR=<dir> <the updater ref> --take-over`, `<project>`
    read from the `.env` it wrote, and no `docker compose stop`, `up` or `pull`; it exits 1 with `The updater of this
    build did not take over, so nothing changed.`
  - `stops when the hand-over helper does not start`: the same with `STUB_RUN=fail` exits 1 at once with `Could not
    start the updater of this build, so nothing changed.`; `.env` and `compose.yaml` are written, `.env` has no
    `HORNHOOF_PEER_PORT`, and there is no `docker compose stop`, `up` or `pull` call.
  - `goes on without a handover under an updater of revision 2`: no `--take-over` call.
  - The test `updates without questions or downloads from the updater` keeps its `docker create` assertion for now;
    Task 9 narrows it.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the start order, the machine id and the handover in `scripts/install.sh`, and the stub's
  contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Start the database, keeper and front before the app, and let the new updater run the move".

### Task 9: The host-wide port registry

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 8 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts` passes; from the worktree
root, `bash -n scripts/install.sh` and `shellcheck scripts/install.sh` print nothing.

**Files:**
- Modify: `scripts/install.sh` (`free_port` goes into the new functions; `server_mode` writes no port and no
  `PUBLIC_URL` when it makes `.env`), `apps/server/test/install-stubs/docker`
- Test: `apps/server/test/install-script.test.ts`

**Interfaces:**
- New functions in `install.sh`, all through `"${DOCKER[@]}"`:
  - `take_port_lock`: `docker volume create hornhoof-ports`, then `docker create --name hornhoof-port-lock --label
    io.hornhoof.since=<date +%s> "$APP_REF" true`, whose output is the lock's id. When the name is taken: `docker
    inspect --format '{{.Id}} {{index .Config.Labels "io.hornhoof.since"}}' hornhoof-port-lock`; a lock whose `since`
    is more than 120 s ago is removed by the id read (`docker rm <id>`, so a lock another caller made meanwhile
    stays), and it tries again; otherwise it waits 1 s and tries again, until `${HORNHOOF_PORT_LOCK_WAIT:-180}`
    seconds have passed, then `fail "Another Hornhoof install on this computer is choosing its ports. Wait a minute,
    then run this command again."`
  - `drop_port_lock <id>`: `docker rm <id>`.
  - `read_registry`: `docker run --rm --user 0 -v hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat
    /ports/registry 2> /dev/null || true'`; `write_registry`, from its input: `docker run --rm -i --user 0 -v
    hornhoof-ports:/ports --entrypoint sh "$APP_REF" -c 'cat > /ports/registry.new && mv /ports/registry.new
    /ports/registry'`.
  - `bound_ports`: the host ports every container publishes, running or stopped: `docker ps -aq`, then one `docker
    inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' <ids>`.
  - `reserve_ports [<port>]`: under the lock. Held: every port in the registry on another folder's line,
    `bound_ports`, the `HORNHOOF_PORT` and `HORNHOOF_PEER_PORT` of every readable `$BASE_DIR/.env` and
    `$BASE_DIR-*/.env` but this one, and, run by hand, a port that answers on localhost (`port_answers`).
    `server_mode` sets `ENV_BEFORE` when this folder's `.env` was there before this run. The web port is the first of:
    `.env`'s `HORNHOOF_PORT`; this folder's registry line's; 8080 with `ENV_BEFORE` (a company from before ports were
    kept runs on it); else the first free one from 8080 to 8179, which marks it new (`NEW_WEB`). The peer port: `.env`'s
    `HORNHOOF_PEER_PORT`; the registry line's; else the first free one from 8180 to 8279 (`NEW_PEER`). The marks stay
    for the whole run. Given `<port>` (the retry below), that port is held for the rest of the run, and the side it
    belongs to, new by then, goes straight to the free search; the other side keeps its port.
  - It writes this folder's registry line first, other lines kept, and only then the two ports into `.env`
    (`set_env`), with `PUBLIC_URL=http://localhost:<web port>` too when this run made `.env` and the web port is new. So
    a failed registry write fails before `.env` changes, and a failed `.env` write leaves a line that only holds the
    ports. Right before the registry write it reads the lock's id again (`docker inspect --format '{{.Id}}'
    hornhoof-port-lock`); when it is not this run's, another install took the lock over, and it fails with the lock
    message and writes nothing. No free port in a range fails with today's words (`No free port from <first> to
    <last> for Hornhoof. Stop what uses them, then run this command again.`). The lock goes in every case, a failure
    too.
- Order in `server_mode`: after the pull (or after `HORNHOOF_PULLED`) and before `start_server_services`; the address
  it prints and checks (`local_url`, `public`) is worked out after it.
- Step 3 of `start_server_services` (Task 8), `up -d --no-build keeper front`: when its output says `port is already
  allocated` or `address already in use` for a port marked new, `reserve_ports <that port>` takes the next one, and
  the step runs again, up to 5 times; then, or for a port not marked new, `fail "Port <port> is taken by a program
  outside Docker. Stop what uses it, then run this command again."`
- The stub's contract (`install-stubs/docker`): `STUB_PORTS_DIR` holds `registry` for `run` with `-v
  hornhoof-ports:/ports` (read for `cat /ports/registry`, written from stdin for `cat > /ports/registry.new`), so
  several installs share it; `create --name hornhoof-port-lock` fails with `Conflict. The container name is already in
  use` while `$STUB_PORTS_DIR/lock` exists, else makes that file and prints `lock-<n>`; `rm <id>` of the lock removes
  the file; `STUB_LOCK_SINCE` is the lock's `since` for `inspect`; `ps -aq` prints `STUB_BOUND_IDS` and the
  `PortBindings` `inspect` prints `STUB_BOUND_PORTS`; `STUB_BIND_FAIL` words are ports whose first `up` that binds
  them fails with `Bind for 0.0.0.0:<port> failed: port is already allocated`; `STUB_REGISTRY=fail` makes the
  registry write fail; with `STUB_LOCK_TAKEN=1`, `inspect --format '{{.Id}}' hornhoof-port-lock` answers
  `lock-other`.

- [ ] **Step 1: Write failing tests** in `install-script.test.ts`:
  - `keeps a host-wide list of ports, so four companies on one computer never share one`: `server`, then `--name b`,
    `--name c`, `--name d` with one `HOME` and one `STUB_PORTS_DIR`: web ports 8080 to 8083, peer ports 8180 to 8183,
    and four registry lines naming their folders.
  - `leaves the ports of a stopped and pruned company to it`: a registry line `<home>/hornhoof-old 8080 8180` with no
    folder and no container: a new install gets 8081 and 8181.
  - `skips ports any container publishes, running or stopped`: `STUB_BOUND_PORTS='8080 8180'` gives 8081 and 8181.
  - `gives an existing company a peer port and keeps its web port`: a `.env` with `HORNHOOF_PORT=8085` keeps it, gets
    `HORNHOOF_PEER_PORT=8180`, and the registry line `<dir> 8085 8180`; a `.env` with no `HORNHOOF_PORT`, whose
    company runs on 8080 with `STUB_BOUND_PORTS='8080'`, keeps 8080.
  - `chooses a new company's ports by the free search though its .env is there by then`: a fresh install with
    `STUB_BOUND_PORTS='8080'` gets `HORNHOOF_PORT=8081` and `PUBLIC_URL=http://localhost:8081`; its next run, with
    `STUB_BOUND_PORTS='8080 8081'` (its own `front` binds 8081 now), keeps 8081.
  - `takes the lock and gives it back`: `docker create --name hornhoof-port-lock` comes before the registry write and
    `docker rm lock-1` after it; with `STUB_REGISTRY=fail` the install fails, `.env` has no `HORNHOOF_PEER_PORT`, and
    the `docker rm` still comes.
  - `writes nothing when another install took its lock over`: `STUB_LOCK_TAKEN=1` exits 1 with the lock message, no
    registry write, `.env` without `HORNHOOF_PEER_PORT`, and no `docker rm lock-other`.
  - `takes over a lock older than two minutes by its id, and waits for a younger one`: `STUB_LOCK_SINCE` 200 s ago
    gives `docker rm <that id>` and the install goes on; 30 s ago with `HORNHOOF_PORT_LOCK_WAIT: '2'` exits 1 with the
    lock message.
  - `moves a new port that something outside Docker holds, and its address with it`: `STUB_BIND_FAIL='8180'` ends
    with `HORNHOOF_PEER_PORT=8181` in `.env` and the registry, and two `up -d --no-build keeper front` calls;
    `STUB_BIND_FAIL='8080'` on a fresh install ends with `HORNHOOF_PORT=8081`, `PUBLIC_URL=http://localhost:8081` and
    8081 on the registry line; six ports failing in a row exit 1 with the port message; a `.env` from before with
    `HORNHOOF_PORT=8085` and `STUB_BIND_FAIL='8085'` exits 1 with `Port 8085 is taken by a program outside Docker.`
    and keeps 8085.
  - Existing tests: `installs a named server in its own folder, compose project and free port`, `keeps the folder and
    port of a named server on the next run` and `leaves the port of another Hornhoof on this computer to it` pass
    unchanged; `updates without questions or downloads from the updater` narrows its `docker create` assertion (line
    657) to calls without `hornhoof-port-lock`, and `leaves the built-in node and this server's plan nodes running
    when the node image did not change` its `docker rm` check (line 765) to `docker rm -f hornhoof-`.
- [ ] **Step 2: Run** `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/install-script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above in `scripts/install.sh`, and the stub's contract.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep every company's web and peer ports in one list on the computer".

### Task 10: What people see and read

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Task 3 committed. **Done when:** from
`apps/web`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Updates.test.tsx test/i18n.test.tsx` passes, and from
the worktree root `npx tsc -p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/web/src/updates.ts` (`maintenance`), `apps/web/src/ui/UpdateProgress.tsx`,
  `apps/web/src/ui/UpdateBanner.tsx` and `apps/web/src/screens/Versions.tsx` (they pass `maintenance` beside `offline`),
  `apps/web/src/i18n/en.ts`,
  `apps/web/src/i18n/ru.ts`, `guide/install.md` (line 43), `guide/public-link.md` (line 23), `SECURITY.md` (the line
  "The tunnel carries traffic only to the Hornhoof app...")
- Test: `apps/web/test/Updates.test.tsx`, `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: reasons `maintenance`, `read_only`, `starting` (Task 3; the keeper and `front` send the same, Tasks 4
  and 5).
- `Updates` gains `maintenance: boolean`: true while the latest poll failed with an `ApiFailure` whose `reason` is
  `maintenance`, false once a poll answers (and `offline` stays false meanwhile). `UpdateProgress` takes `maintenance?:
  boolean` and shows `t.updates.maintenance` in place of `restarting`.
- Texts:
  - `updates.maintenance`: EN `Maintenance: Hornhoof is installing the update and takes no changes until it ends.`;
    RU `Обслуживание: Hornhoof ставит обновление и не принимает изменений, пока оно не закончится.`
  - `errors.maintenance`: EN `Hornhoof is installing an update and takes no changes until it ends. Try again in a few
    minutes.`; RU `Hornhoof ставит обновление и не принимает изменений, пока оно не закончится. Попробуйте через
    несколько минут.`
  - `errors.read_only`: EN `Hornhoof only reads on this machine now, so nothing was changed.`; RU `Сейчас Hornhoof на
    этой машине только читает, поэтому ничего не изменилось.`
  - `errors.starting`: EN `Hornhoof is starting. Try again in a few seconds.`; RU `Hornhoof запускается. Попробуйте
    еще раз через несколько секунд.`
- Docs, each in the file's own voice:
  - `guide/install.md` line 43 becomes: "It takes the first free web port from 8080 and peer port from 8180, and keeps
    them in `.env` as `HORNHOOF_PORT` and `HORNHOOF_PEER_PORT`. A list in the Docker volume `hornhoof-ports` keeps
    every company's ports on this computer, so no two companies get the same one, even while one is stopped."
  - `guide/public-link.md` line 23: the tunnel container becomes the keeper: "The keeper, a small container next to
    the server, keeps the connection to it, so nothing has to be opened on your router. It carries nothing while the
    company has no link."
  - `SECURITY.md`: "The tunnel carries traffic only to the Hornhoof app, never to anything else on your network,
    whatever hornhoof.org asks for." becomes "The tunnel ends in the keeper, a container next to the app, which passes
    its traffic to the Hornhoof app only, never to anything else on your network, whatever hornhoof.org asks for."

- [ ] **Step 1: Write failing tests.** `Updates.test.tsx`: `shows maintenance while the server answers with it`: a
  running update whose next `/api/updates` answers 503 with reason `maintenance` shows the progress bar's
  `aria-valuetext` `Maintenance: Hornhoof is installing the update and takes no changes until it ends.`, and a later
  200 answer shows the step again; the typed `idle` fixture at line 199 gains `maintenance: false`. `i18n.test.tsx`:
  the three reasons show their texts in both languages.
- [ ] **Step 2: Run** the Done when tests. Expected: FAIL.
- [ ] **Step 3: Implement** the texts, `maintenance` and the docs.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Say maintenance while an update keeps Hornhoof from taking changes".

### Task 11: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `keeper-and-front`. **Starts from:** Tasks 1 to 10 committed and reviewed. **Done
when:** Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Update is
Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npx tsc -p apps/server/tsconfig.json
  --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` → no output; `bash -n scripts/install.sh
  apps/updater/updater.sh` and `shellcheck scripts/install.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** `git diff main --stat` lists no key or certificate file; `git grep -nE
  "BEGIN (EC )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` prints nothing and exits with status 1 (no match); `git
  diff main | grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` shows only `127.0.0.1`, `0.0.0.0` and addresses in
  `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.1, 3.9, 3.10, sections 6 and 9, the overview's
  plan 2 entry and this plan's rulings; the CLI agent that did not write a task reviews it too (Gemini for Codex's
  tasks, Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse the move both ways** (team lead), on a throwaway company on a machine of Ivan's. It is the
  team lead's test stand, the one install the team lead makes, updates and removes; nothing in it touches Ivan's
  companies, their folders or their registry lines:
  - Build the branch's images by hand (`gh workflow run images.yml --ref keeper-and-front`), which pushes the commit's
    tag only and leaves `latest` alone (`images.yml:93-98`). Build a broken one the same way from a throwaway branch
    `keeper-and-front-broken`: one commit on `keeper-and-front` that adds an empty migration, made the way the repo
    makes them, and makes `apps/server/src/main.ts` exit 1 before it listens, so going back from it restores the
    database too; never merged, deleted afterwards. Read the index digests with `docker buildx imagetools inspect
    ghcr.io/invariant0x/<image>:<commit>`.
  - Install the current release as `install.sh server --name rehearsal`, set it up with a random link, and connect one
    plan node to it on localhost.
  - Each update below is a `request.json` (`{id, version: "rehearsal", tag: <commit>, digest, nodeDigest,
    updaterDigest}`) written into the volume `hornhoof-rehearsal_control` through a short container of the updater
    image run with `--entrypoint sh`, and each ends within 20 minutes.
  - The new shape's checks: `docker compose ps -a` in `~/hornhoof-rehearsal` shows `front`, `keeper`, `app`, `db`,
    `node` and `updater` running, `migrate` exited 0, and no `tunnel`; `http://localhost:<port>` opens and signs in;
    within 60 s `curl -s https://<link>/api/health` is `{"ok":true}`; the plan node is online; `.env` has
    `HORNHOOF_PEER_PORT` and `HORNHOOF_MACHINE_ID`; the registry (`docker run --rm -v hornhoof-ports:/p --entrypoint
    cat <updater image> /p/registry`) has the company's line. Today's shape's checks: `app` on the port and `tunnel`,
    no `front`, `keeper` or `migrate` container in `ps -a`, localhost signs in, the link answers within 60 s, and the
    plan node is online.
  - In this order:
    1. Forward, under the release's updater, to the branch build: `status.json`'s log has `This build's updater goes
       on with the update.`, it ends `done`, and the new shape's checks pass.
    2. A failed update between two builds of the new shape, to the broken build: it ends `rolled_back`, its log says
       the database went back to the copy, and the new shape's checks pass on the branch build's commit.
    3. Back, a downgrade to the release build: it ends `done`, today's shape's checks pass, and the updater runs the
       release's image again.
    4. A failed move-in under the release's updater, to the broken build: the handover comes, the new updater installs
       it, and it ends `rolled_back`; today's shape's checks pass, with the app answering the release's commit.
    5. Forward again, under the branch's updater that stayed, to the branch build: it ends `done`, and the new shape's
       checks pass.
  - Then remove the link in Share access, `docker compose down -v` in `~/hornhoof-rehearsal` only, remove that
    folder, and remove its registry line by hand. Any step that fails: stop and report, and Ivan is not asked to
    update.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from
  (`.github/workflows/images.yml:62`), so the team lead writes the merge commit into main with exactly this subject
  (94 characters, no double quote):
  ```text
  Run each company through front and keeper containers, migrate before the app, keep ports apart
  ```
  Then `git push origin main`, and wait for CI green and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** Ivan presses Update on his own companies himself, one at a time;
  the team lead never runs an install, an update or a `request.json` on them. After each, the team lead runs the
  rehearsal's new shape checks, reading only (`docker compose ps -a`, `curl`, the registry, the Machines tab, where
  every machine connected through the link is online again), and reports. When one fails, or does not answer within
  20 minutes of the Update (the updater has gone back by itself, or Versions says what failed), the team lead tells
  Ivan which release to go back to, the one before, and how: in Versions, that release's Install button, or, when the
  app does not answer, `HORNHOOF_VERSION=<that release> install.sh server` (with `--name <name>` for a named company)
  on that machine. Ivan does it; then stop and report.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/keeper-and-front` once main
  has the branch.
