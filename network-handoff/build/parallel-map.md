# Parallel map: plans 1 (Tasks 8 to 12), 1b, 2, 3, 4

Date 2026-11-04. Read at: Hornhoof clone 73d086ba on branch `network` plus the real tree's uncommitted plan 1 Task 11; relay
repo bd24cc1 plus the uncommitted plan 1 Task 7. Built from each task's Files, Starts from and Consumes lines, grep and the
code. No plan and no code changed. The only thing run: `drizzle-kit generate` on a scratch copy of `schema.ts` and
`drizzle/`, since removed.

Short names: `m/` = `apps/server/src/modules/`, `s/` = `apps/server/src/`, `t/` = `apps/server/test/`, `w/` = `apps/web/src/`,
`wt/` = `apps/web/test/`, `n/` = `apps/node/src/`, `nt/` = `apps/node/test/`, `pp/` = `packages/protocol/`. C = creates,
M = modifies. "Paper" is what a task's Starts from line says; "real" is what it consumes or shares.

## 0. In short

- **The chain is paper for most of plan 2.** Plan 2's Tasks 1, 2, 4, 8, 9 and 10 need nothing of plan 1b. Plan 1b's Tasks 4 and
  6 need nothing of Tasks 1 to 3 or 5. Plan 4's node side needs nothing of plans 2 and 3 but one protocol file.
- **Nine lanes can run at once now:** the two running (p1 T8, p1 T12) and seven new: 1b T1, 1b T4, 2 T1, 2 T2, 2 T4, 2 T8 then T9,
  2 T10. A tenth (4 T4's protocol part, then 4 T5) needs a split and ruling 6.
- **At Ivan's five writers, start next:** 1b T1, 1b T4, 2 T4. They open the most: 1b T2, T3, T5, T6 and half of 2 T5.
- **One thing stays serial whatever the writers:** the migration chain 1b T1, 1b T3, 1b T7, 3 T2, 4 T1 (rulings 1 and 2).
- **No blocker now.** Three things to settle first: ruling 3 before 2 T2, ruling 7 before 1b T4, ruling 1 before plan 3.

## 1. Tasks

Collisions name only what is really shared. HARD means same lines or one generated chain; SOFT means one file, other places,
which `lane.sh refresh` and a 3-way landing carry.

### Plan 1, Tasks 8 to 12 (relay repo, then Hornhoof)

| Task | Creates, changes | Consumes (from) | Collides |
|---|---|---|---|
| T8 | C `relay/test/caddy.sh`, `test_edge_today.py`; M `relay/test/harness.py` | `Stack`, `Client` (T1); `admin ban`, `banned-caddy` (T7; both in relay.py today, :1335, :1356) | HARD `harness.py` with T9 |
| T9 | C `relay/edge-frpc.toml`, `edge-frpc.service`, `test_sni.py`; M `frps.toml`, `Caddyfile`, `relay.py`, `frps.service`, `README.md`, `harness.py` | lock, `routes`, `frps_route` (T2); watcher (T4); `Stack` with Caddy (T8) | HARD with T8, T10 |
| T10 | C `test_block_by_name.py`; M `frps.toml` (`ops`), `relay.py`, `hornhoof-relay` | bans (T7), `CLIENT` (T6), `Stack` with passthrough (T9) | HARD with T9 |
| T11 | M `t/fake-relay.ts`; C `t/fake-relay.test.ts` (in the real tree, in review) | the contract table only | none |
| T12 | M `m/link/relay.ts`; C `t/relay-client.test.ts` (lane `p1t12`) | fake relay (T11) | none; 1b T8 consumes `Relay.health` |

### Plan 1b

| Task | Creates, changes | Consumes (from); paper start | Collides |
|---|---|---|---|
| T1 | C migration `session_handover`; M `s/db/schema.ts`, `s/auth/tunnel.ts`, `s/auth/session.ts`, `s/app.ts`, `t/helpers.ts`, `t/auth.test.ts`, `t/migrations.test.ts` | today's code; paper: plan 1 | HARD migration chain, schema. SOFT `app.ts` |
| T2 | M `s/app.ts`, `s/web.ts`; C `t/before-sign-in.test.ts`; M `t/static.test.ts` | `req.overLink`, `viaLink`, `TUNNEL` (T1) | SOFT `app.ts`; `/api/health` lines with 2 T3 |
| T3 | C `s/auth/sign-in-limit.ts`, migration `sign_in_attempts`; M `s/db/schema.ts`, `m/auth/routes.ts`, `s/db/agent-sql.ts` (`HIDDEN`), `t/orchestrator-control.test.ts` | `clientAddress`, `hashToken` (today). Paper T2; real: only after T1 in the chain | HARD chain, `HIDDEN` line |
| T4 | C `m/tls/x509.ts`, `t/x509.test.ts`; M `apps/server/package.json`, `package-lock.json` by `npm install` | nothing. Paper T3 | HARD lock with 3 T3; SOFT `package.json` |
| T5 | C `m/tls/proxy-header.ts`, `m/tls/listener.ts`, tests; M `s/auth/tunnel.ts`, `s/main.ts` | `selfSigned` (T4), `overLink` (T1), address limit (T3, a test only) | SOFT `main.ts` with 2 T2 |
| T6 | C `m/tls/challenges.ts`, `acme.ts`, `ari.ts`, `t/real/run.sh`, `apps/server/vitest.real.config.ts`, tests; M `s/app.ts`, `apps/server/vitest.config.ts`, both `package.json`, `.github/workflows/images.yml`, `CONTRIBUTING.md` | `selfSigned`, `certInfo` (T4). Paper T5; real T4. Pebble: home-api | SOFT `app.ts` |
| T7 | C `m/tls/store.ts`, migration `link_tls`; M `s/db/schema.ts`, `s/db/agent-sql.ts`, `m/link/tunnel.ts`, `client.ts`, `link.ts`, `s/config.ts`, `compose.yaml`, `t/helpers.ts`, and tests | `LINK_TLS_PORT` (T5), `LETS_ENCRYPT` (T6), `certInfo` (T4) | HARD chain, `HIDDEN`; SOFT `config.ts`, `compose.yaml` with 2 T3, T5, T7 |
| T8 | C `m/tls/checks.ts`, `manager.ts`, tests; M `s/app.ts`, `s/main.ts`, `m/link/link.ts`, `m/setup/routes.ts`, `m/link/routes.ts`, `t/link.test.ts` | T4, T5, T6, T7; `Relay.health` (p1 T12) | SOFT `app.ts`, `main.ts` |
| T9 | M `w/screens/Settings.tsx`, `Machines.tsx`, `Setup.tsx`, `w/ui/LinkName.tsx`, `w/i18n/en.ts`, `ru.ts`, `SECURITY.md`, `guide/public-link.md`, `README.md`, tests | `GET /api/link`'s `tls: TlsView \| null` (T8), `POST /api/setup`'s `link` | SOFT en, ru, guide with 2 T10; near lines in `SECURITY.md` |
| T10 | none; runs all. Merge, push, Update skipped (build ruling 2) | T1 to T9, plan 1 | none |

### Plan 2

| Task | Creates, changes | Consumes (from); paper start | Collides |
|---|---|---|---|
| T1 | C `t/updater-rev1.sh`; M `apps/updater/updater.sh`, `t/updater-stubs/docker`, `t/updater.test.ts` | nothing. Paper 1b | none |
| T2 | C `s/migrate.ts`, `t/migrate.test.ts`; M `s/db/client.ts`, `s/main.ts`, `s/cli.ts`, `apps/server/package.json` (`dev`, `start`), `t/db-pool.test.ts` | nothing. Paper 1b | SOFT `package.json` with 1b T4; `main.ts` with 1b T5 |
| T3 | C `m/keeper/state.ts`, `m/keeper/app-mode.ts`, `t/app-mode.test.ts`; M `s/config.ts`, `s/errors.ts`, `s/app.ts`, `m/agents/timers.ts`, `t/version.test.ts`, `t/config.test.ts` | `handOverSession` (1b T1), link's `{ ok }` health (1b T2). Paper 1b; real those two | SOFT `app.ts`; `/api/health` lines with 1b T2 |
| T4 | C `s/net/proxy.ts`, `s/net/front.ts`, `s/front.ts`, tests | nothing. Paper 1b | none |
| T5 | C `m/keeper/updater-status.ts`, `m/keeper/keeper.ts`, `s/keeper.ts`, `t/keeper.test.ts`; M `s/config.ts`, `t/config.test.ts` | T4's pass-through, T3's `writeKeeperState`, `Mode`, T2's `openDb`, `KEEPER_NAME` | SOFT `config.ts` |
| T6 | C `m/keeper/served.ts`, `t/keeper-link.test.ts`; M `m/link/client.ts`, `tunnel.ts`, `link.ts`, `m/tls/listener.ts`, `store.ts`, `m/keeper/keeper.ts`, `s/auth/tunnel.ts`, `s/main.ts`, and tests | T5, T3; 1b's `LinkListener`, `linkVisitor`, `tlsOf`, `linkMode`, `certInfo`, `Served`, `LinkTls` | needs 1b T5, T7, T8 landed |
| T7 | M `compose.yaml`, `Dockerfile`, `t/compose.test.ts`, `t/pins.test.ts` | entry points of T2, T4, T5. Paper T6 too | HARD `compose.yaml` with 1b T7 (one line), 4 T6 |
| T8 | M `scripts/install.sh`, `t/install-stubs/docker`, `t/install-script.test.ts` | `--take-over` (T1). Paper T1, T7; the tests run on stubs | HARD with T9 |
| T9 | M the same three | T8 | HARD with T8 |
| T10 | M `w/updates.ts`, `w/ui/UpdateProgress.tsx`, `UpdateBanner.tsx`, `w/screens/Versions.tsx`, en, ru, `guide/install.md`, `guide/public-link.md`, `SECURITY.md`, `wt/Updates.test.tsx`, `wt/i18n.test.tsx` | the words of T3's reasons, fixed in the plan | see 1b T9 |
| T11 | none; runs all. Rehearsal, push, Update skipped | T1 to T10 | none |

### Plan 3

| Task | Creates, changes | Consumes (from) | Collides |
|---|---|---|---|
| T1 | C `t/real/pg.ts`, `t/real/postgres.test.ts`; M `t/real/run.sh`, `CONTRIBUTING.md`, `t/compose.test.ts`. Home-api | `run.sh` (1b T6), `migrateDb`, `openDb`, `APP_NAME` (2 T2), `db`'s `command` (2 T7) | SOFT `CONTRIBUTING.md` |
| T2 | C `s/db/net.ts`, migrations `sources`, `net`; M `s/db/schema.ts`, `s/db/client.ts`, `s/db/agent-sql.ts`, `m/tools/database.ts`, `t/global-setup.ts`, `t/helpers.ts`, and tests. Home-api | `realDatabase` (T1), `migrateDb` (2 T2) | HARD chain, `client.ts` |
| T3 | C `s/db/sql-check.ts`, `s/db/confirm.ts`, tests; M both `package` files (`libpg-query`), `s/db/agent-sql.ts`, `s/db/client.ts`, `s/main.ts`, `s/cli.ts`, `m/tools/database.ts`, `s/errors.ts`, `m/keeper/app-mode.ts`, en, ru, `t/helpers.ts`. Home-api | `LEASE_REFUSED`, `isLeaseRefused`, `setLease` (T2), `realDatabase` (T1), `AppMode`'s message (2 T3) | HARD `client.ts` with T2 |
| T4 | C `m/keeper/lease.ts`, `lease-store.ts`, `t/fake-lease.ts`; M `m/keeper/keeper.ts`, `s/keeper.ts`, `m/keeper/app-mode.ts`, `t/helpers.ts`, keeper tests. Home-api | `Term`, `LeaseKind`, triggers (T2); `REFUSED_FUNCTIONS`, `keepErrors` (T3); plan 2's keeper | HARD `keeper.ts` with T5 |
| T5 | M `m/keeper/keeper.ts`, `t/keeper-link.test.ts` | `Keeper.term()` (T4), plan 2's link doors | HARD with T4 |
| T6 | none; runs all. Rehearsal skipped | T1 to T5 | none |

### Plan 4

| Task | Creates, changes | Consumes (from) | Collides |
|---|---|---|---|
| T1 | C `s/db/sources.ts`, migrations `steps`, `calls`; M `s/db/schema.ts`, `s/db/client.ts`, `t/helpers.ts`, `m/keeper/lease-store.ts`, tests. Home-api | `applied`, `toolCalls`, `setLease`, `realDatabase`, `LeaseStore.prune` (plan 3) | HARD chain |
| T2 | C `m/sources/requests.ts`; M `s/app.ts`, `s/errors.ts`, `m/conversation/routes.ts`, `m/updates/routes.ts`, route files it finds, `w/api.ts`, en, ru, tests | T1's sources | SOFT `app.ts`, en, ru |
| T3 | C `m/tools/calls.ts`; M `m/tools/mcp.ts`, `m/tools/database.ts`, `s/db/agent-sql.ts`, `t/helpers.ts`, `s/auth/tunnel.ts`. Home-api | T1's sources; `PRE_COMMIT`, `SqlAnswer`, `notConfirmed` (3 T3) | none inside plan 4 but `helpers.ts` |
| T4 | M `pp/src/index.ts`, `m/nodes/hub.ts`, `messages.ts`, `socket.ts`, `s/app.ts`, `t/helpers.ts`; C `t/node-messages.test.ts` | T1; `isLeaseRefused`, `notConfirmed` (plan 3); `whileLeading` (2 T3) | HARD `socket.ts` with T6 |
| T5 | C `n/outbox.ts`; M `n/main.ts`, `n/connection.ts`, `n/isolation.ts`, node tests | `NUMBERED`, `isNumbered`, `ack`, `ACKS_HEADER` (T4's protocol part only) | HARD `n/main.ts` with T6 |
| T6 | M `n/keys.ts`, `n/main.ts`, `m/nodes/socket.ts`, `compose.yaml`, tests | `http://front:8080` (2 T7). Paper T5 | see T4, T5 |
| T7 | C `s/net/front-calls.ts`; M `s/net/proxy.ts`, `s/net/front.ts`, `m/keeper/keeper.ts`, tests | `INVOCATION` (T3); plan 2's doors. Paper T3, T6; T6 is not real | none inside plan 4 |
| T8 | none; runs all. Rehearsal skipped | T1 to T7 | none |

### Hot files

| File | Tasks, in landing order |
|---|---|
| migrations and `meta/_journal.json`, `s/db/schema.ts` | 1b T1, T3, T7; 3 T2; 4 T1. Never two at once (ruling 2) |
| `s/db/agent-sql.ts` | 1b T3, T7; 3 T2, T3; 4 T3. `HIDDEN` is one line, edited by the first three |
| `s/app.ts` | 1b T1, T2; 1b T6; 2 T3; 1b T8; 4 T2, T4 |
| `s/main.ts` | 2 T2; 1b T5; 1b T8; 2 T6; 3 T3 |
| `s/db/client.ts` | 2 T2; 3 T2; 3 T3; 4 T1 |
| `s/config.ts` | 2 T3; 2 T5; 1b T7 |
| `compose.yaml` | 1b T7; 2 T7; 4 T6 |
| `scripts/install.sh` | 2 T8; 2 T9 |
| `apps/updater/updater.sh` | 2 T1 |
| `apps/server/package.json` | 1b T4; 2 T2; 1b T6; 3 T3. `package-lock.json`: 1b T4; 3 T3 |
| `w/i18n/en.ts`, `ru.ts` | 2 T10; 1b T9; 3 T3; 4 T2 |
| `SECURITY.md`, `guide/public-link.md` | 2 T10; 1b T9. Their lines lie 2 apart in `SECURITY.md` (:51, :53) |
| `t/helpers.ts` | 1b T1, T7; 3 T2, T3, T4; 4 T1, T3, T4 |
| `t/orchestrator-control.test.ts` | 1b T3, T7; 3 T2, T3 |
| `m/keeper/keeper.ts` | 2 T5, T6; 3 T4, T5; 4 T7 |

## 2. Lanes

### Now

| Lane | Tasks, in order | Status | Stacked on |
|---|---|---|---|
| R | p1 T8, then T9, then T10 | T8 in lane `p1t8`, on T7 uncommitted | T9 and T10 wait: same files |
| H1 | p1 T12 | in lane `p1t12`, on T11 uncommitted | nothing else |
| A | 1b T1 | start | nothing |
| B | 1b T4 | start, with ruling 7 | nothing |
| C | 2 T4 | start | nothing |
| D | 2 T1 | when a writer is free | nothing |
| E | 2 T2 | when a writer is free, with ruling 3 | nothing. SOFT with B on `package.json` |
| F | 2 T8, then T9 | when a writer is free | **stacked** on 2 T1's flag and 2 T7's service names. No stub: both are strings the stubbed `docker` logs |
| G | 2 T10 | when a writer is free | **stacked** on 2 T3's three reasons. No stub: the web reads `reason` as a string, and the test's mock answers it |
| H (needs a split, ruling 6) | 4 T4's protocol part, then 4 T5 | when capacity is left | **stacked**: no server of plan 4 needed, as `main.test.ts`'s fake server plays it |

### Next, as each lands

| When landed | Starts | Stacked on, and the check |
|---|---|---|
| 1b T1 | 1b T2 and 1b T3 side by side (no shared file) | none |
| 1b T4 | 1b T6 | none; SOFT with 1b T2 on `app.ts` |
| 1b T2 | 2 T3 | none |
| 1b T1, T3, T4 | 1b T5 | none. It may start before T3 lands, holding its one address-limit test |
| p1 T8 | p1 T9, then T10 | none |
| 2 T4, 2 T2 | 2 T5 | **stacked** on 2 T3 if that lane still runs: code against the plan's `state.ts` (`Mode`, `KeeperState`, `writeKeeperState`). Check at landing: 2 T3's `freshState` reads what T5 writes |
| 1b T5, T6 | 1b T7, after 1b T3 in the chain | may be **stacked** on T5 and T6 with two constants: `LINK_TLS_PORT = 8443`, `LETS_ENCRYPT = acme.directory.letsencrypt.production` |
| 1b T7 | 1b T8 | needs p1 T12 landed |
| 1b T7 | 1b T9, **stacked** on T8 | codes against `TlsView = { mode, certificate, expiresAt, failedAt }` in `api-mock`. Check: `GET /api/link` answers those four. Lands after 2 T10 |
| 2 T5, 1b T8 | 2 T6 | none |
| 1b T7, 2 T5 | 2 T7, **stacked** on T6 | compose text only. Lands after T6, so the tunnel never goes before the keeper can carry the link |
| 1b T6, 2 T2, 2 T7 | 3 T1 | may be **stacked** on 2 T7 but for `compose.test.ts`'s one case |
| 3 T1, 1b T7, 2 T2 | 3 T2, then T3 | serial |
| 3 T3, 2 T6 | 3 T4, then T5 | serial on `keeper.ts` |
| 3 T4 | 4 T1 | serial, in the chain |
| 4 T1, 3 T3 | 4 T2 and 4 T3 side by side; 4 T4's server part | SOFT `app.ts` between T2 and T4, `helpers.ts` between T3 and T4 |
| 4 T3, 3 T5 | 4 T7 | none |
| 2 T7, 4 T4, 4 T5 | 4 T6 | none |

Pure pieces that could go ahead of their tasks, only if capacity is idle (ruling 6): 3 T3's `sql-check.ts` with its test (no
shape beyond the parser's); 3 T4's `lease.ts` with its table (`Term`, `LeaseKind` fixed in 3 T2).

### Landing order, one at a time

1. p1 T7 (relay), 2. p1 T11, 3. p1 T8, 4. p1 T12, 5. 1b T1, 6. 1b T4, 7. 2 T4, 8. 2 T1, 9. 2 T2, 10. 1b T2, 11. 1b T3, 12. 2 T8,
13. 2 T9, 14. 2 T10, 15. p1 T9, 16. 1b T6, 17. 2 T3, 18. 1b T5, 19. p1 T10, 20. 2 T5, 21. 1b T7, 22. 1b T8, 23. 1b T9, 24. 2 T6,
25. 2 T7, 26. 3 T1, 27. 3 T2, 28. 3 T3, 29. 3 T4, 30. 3 T5, 31. 4 T1, 32. 4 T2, 33. 4 T3, 34. 4 T4, 35. 4 T5, 36. 4 T6, 37. 4 T7.

Only these orders are binding: the chain (5, 11, 21, 27, 31); 10 before 17; 8 and 25 before plan 2's end checks; 16 and 18 before
21; 4 before 22; 22 before 24; 24 before 25; 17 and 24 before 28 and 29. 14 before 23 only saves a merge in `SECURITY.md`. Relay and Hornhoof
landings do not wait for each other. Plan-end lines (1b T10, 2 T11, 3 T6, 4 T8)
follow their last landing.

## 3. Seams

What the lead checks when two lanes meet, one line each.

| Lanes | Check |
|---|---|
| R and H1 | `route`'s body keys `state, client, since, generation, relayStarted, evictionBound, sync`, in the relay's `route_of` and `FakeRelay` alike |
| R and H1 | `sync` is `{ state, copy, epoch, generation, at }`; `setSync`'s refusals `not_holder`, `stale_epoch` on the same status codes in both |
| R (T9) and H1 | `GET /api/v1/health`'s `passthrough` and `frps` match `Relay.health`'s `{ up, relayStarted, passthrough }` |
| R (T7) and H1 | `POST /api/v1/links/<name>/key` and R6.2's visitor call answer the shape `changeKey` and `visitorKey` parse |
| H1 and 1b T8 | `ctx.links.relay.health()` used as typed in `relay.ts`; `FakeRelay.passthrough`, `frpsDown` as plan 1b's Handed over says |
| 1b T1 and T2, T5 | `req.overLink`, `viaLink(token?)`, `TUNNEL` export from `t/helpers.ts` |
| 1b T1 and 2 T3 | `handOverSession` does nothing unless `ctx.mode.current()` is `lead`; the hook order stays socket plugin, `modeGate`, `fromOwnPages` |
| 1b T2 and 2 T3 | `/api/health`: `{ ok }` over the link, `{ ok, version, commit, mode }` elsewhere; 503 and `ok: false` in `off` |
| 1b T2 and T6 | `/.well-known/acme-challenge/:token` passes `before-sign-in.test.ts`: `PUBLIC` lists it if it answers 2xx; `:token` is in the parameter map |
| 1b T3 and T5 | `clientAddress` takes `linkVisitor` first, so the 30-an-hour limit counts the visitor, not the keeper |
| 1b T4 and T5, T6, T7 | `selfSigned` and `certInfo`'s signatures in `x509.ts`; `node_modules` of each later lane has both new packages |
| 1b T5 and T7 | `LINK_TLS_PORT` 8443 is `localPort` in `configFor`'s https block |
| 1b T5 and T8 | `LinkListener.use(host, cert)` fits `Served` |
| 1b T6 and T7 | `LETS_ENCRYPT` is `config.acmeDirectory`'s default; `testApp` and `appOn` give `ACME_DIRECTORY: 'off'` |
| 1b T7, T8 and 2 T6 | `Settings.mode`, `sync(): Promise<boolean>`, `tunnel.json` still written by the app; `localIP` moves from `app` to the keeper |
| 1b T7 and 2 T7 | `ACME_DIRECTORY` stays on `app` and reaches the keeper as 2 T7's compose block says; `MAX_RUNS_PER_HOST` stays on `app` |
| 1b T3, T7 and 3 T2 | `HIDDEN` holds `sign_in_attempts`, `link_tls`, `applied`, `tool_calls`; `orchestrator-control.test.ts`'s two lists |
| 2 T1 and T8 | `updater.sh --take-over`; `HORNHOOF_UPDATER_REV=2` read as `${HORNHOOF_UPDATER_REV:-1}`; control volume `<project>_control` |
| 2 T8 and T7 | service names in the `up` strings (`db keeper front app node updater`), `migrate`'s name in the failure text, with compose's |
| 2 T9 and T7 | `.env`'s `HORNHOOF_PEER_PORT`, and `"${HORNHOOF_PEER_PORT:-8180}:7070"` |
| 2 T2 and T7 | `dist/migrate.js`, `dist/front.js`, `dist/keeper.js` exist in the image; `apps/server/package.json`'s `start` |
| 2 T2 and 3 T2 | `migrateDb`: detach, drizzle's migrate, `applyMissingMigrations`, attach; the answer is the count |
| 2 T3 and T5 | `keeper.json`: `{ mode, at, link }`, `writeKeeperState` and `freshState` |
| 2 T3 and T10 | reasons `maintenance`, `read_only`, `starting`; `errors.*` in en and ru for each |
| 2 T3 and 3 T3 | `READ_ONLY_MESSAGE` export, the same words as `modeGate`'s and `errors.read_only` |
| 2 T4 and T5, 4 T7 | `PassOptions`, `Target`, `Refusal`, `startingAnswer` 502 with `Retry-After: 5`; `holdMs: 0` for plan 2's tests that expect 502 |
| 2 T5, T6 and 3 T4 | `KeeperOptions.lease`; every `keeper.test.ts` and `keeper-link.test.ts` keeper gets `fakeLease()` |
| 1b T6, 2 T7 and 3 T1 | `run.sh`'s Postgres has `compose.yaml`'s digest and each `-c` of `db`'s `command` |
| 3 T3 and 4 T3 | `run(text, mode, call)` through `database.ts`'s `runSql`, `PRE_COMMIT`, `SqlAnswer` |
| 3 T4 and 4 T1 | `LeaseStore.prune` signature, `PRUNE_BATCH` |
| 4 T3 and T7 | `x-hornhoof-invocation`, believed only from the keeper's address (`fromTunnel`) |
| 4 T4 and T5 | `NUMBERED`, `isNumbered`, `ACKS_HEADER` `hornhoof-acks`, `ack { upto }`, hello's `stream` |
| 4 T5 and `n/terminal/host.ts` | numbered messages the terminal host sends (ruling 5) go through the outbox |
| 2 T7 and 4 T6 | `node`'s `HORNHOOF_SERVER: http://front:8080`, `depends_on: front`; `HORNHOOF_MACHINE_ID` on `node` and `app` |
| en, ru (2 T10, 1b T9, 3 T3, 4 T2) | every key in both files; `i18n.test.tsx` |
| any lane with `npm install` | real tree and later lanes get `npm ci`; `lane.sh refresh` does not copy dependencies |
| every landing | `npm run typecheck:tests` and `npm run lint` on the result (ruling 9) |

## 4. Pre-flight of plans 1b, 2, 3, 4 at 73d086ba

467 commits since 04bec1d. Line numbers in plan 2 were mostly right already, so it was read later than 04bec1d. A row with "holds" has no
real drift. Every self check was by script and by reading the task: Consumes against the named task's text, Done when against Files. No task
contradicts itself but 3 T2 and 4 T1's numbers below.

### Migrations

- Main's newest: `0052_dismissed_command_blocks`, `when` 1793739121203 (2026-11-03 20:52 UTC). 52 entries; no idx 48; idx 45 is
  `0046_turn_failures` and idx 46 is `0045_task_lookup_indexes`. Snapshot chain has no fork. `drizzle-kit generate` on a scratch copy says "No
  schema changes", so the next generate holds only its task's change, as `0053`.
- Plans use: 1b `0042` to `0044` (by name; only plan 3's text prints them), 3 `0045`, `0046`, 4 `0047`, `0048`, 5 `0049`, 5b `0050`, 6 `0051`,
  7 `0052`, `0053`, 8 `0054`, 9 `0055`, 9b `0056`, 9c `0057`, 10 `0058`, 11 `0059`, 11b `0060`. Files `0045_*`, `0046_*`, `0047_*`, `0049_*` to
  `0052_*` exist already. **Each plan number becomes number + 11**: `0053_session_handover`, `0054_sign_in_attempts`, `0055_link_tls`,
  `0056_sources`, `0057_net`, `0058_steps`, `0059_calls`, on to `0071_go_on_here`. See ruling 1.
- New since the plans: `applyMissingMigrations` (`s/db/client.ts:27`, `t/global-setup.ts`, `t/migration-history.test.ts`) applies a migration whose
  `when` is below the newest. So the overview's "drizzle skips" no longer loses one, but only where that function runs (rulings 3, 4).

### Rows

| Task | Self | Against the code |
|---|---|---|
| 1b T1 | agrees | holds. `migrationsUpTo` is at `t/migrations.test.ts:61`; tag before is `0052_...` |
| 1b T2 | agrees | holds. `PUBLIC` is filled from one run, as it says; routes grew, and `/api/updates/current` needs a session |
| 1b T3 | agrees | holds. `helpers.ts:40` is :43; limiters at `routes.ts:27-28` |
| 1b T4 | agrees | holds. Package versions not checked here |
| 1b T5 | agrees | holds; `main.ts` and `auth/tunnel.ts` have no change since 04bec1d |
| 1b T6 | agrees | holds. `images` still `needs: test` (`images.yml:75`), so `[test, test-real]` fits. CI not run here. Pebble on home-api |
| 1b T7 | agrees | small: `testApp` now hands to `appOn` (`helpers.ts:83-94`); its `ACME_DIRECTORY: 'off'` default goes where `appOn` builds the config. `link.test.ts:67` holds |
| 1b T8 | agrees | holds; `link.test.ts:53`, `:75` hold; `m/link` and `m/setup/routes.ts` unchanged |
| 1b T9 | agrees | small: `Settings.tsx:23` is :24. `Machines.tsx` is much changed, but T9 places its line by what it does ("above the list"). `Setup.test.tsx:219` holds |
| 1b T10 | agrees | `images.yml:62` is :99, the label :124. Its merge steps are skipped anyway |
| 2 T1 | agrees | holds. `updater.sh` cites hold (`pull_images` :269, `swap_updater` :318, `interrupted` :452). `main` is local and is 73d086ba. `services_without_node` (:184) already runs `config --services`: `remove_unnamed` should share it, or the dryer gate will say so |
| 2 T2 | agrees | **drift:** `createDb` now also runs `applyMissingMigrations` (`client.ts:27`); `migrateDb`'s text says drizzle's migrate alone. Ruling 3. `createDb`'s callers `main.ts:15`, `cli.ts:93` hold |
| 2 T3 | agrees | **small drift:** `startTimers` also runs `checkExternalWaits` at start (`timers.ts:131`), which T3's list of what runs on the way in leaves out (ruling 8). `onMessage` is now `receiveNodeMessage` (`app.ts:82`), so that is what `whileLeading` wraps. Hooks are at `app.ts:99-101`. `version.test.ts:15` holds |
| 2 T4 | agrees | holds; new files |
| 2 T5 | agrees | holds; `config.test.ts:56` holds |
| 2 T6 | agrees | holds; rests on 1b, and `m/link`, `s/auth/tunnel.ts` are unchanged today |
| 2 T7 | agrees | holds. `pins.test.ts:51-61`, `Dockerfile:40` hold. `app` gained `MAX_RUNS_PER_HOST` (`compose.yaml:24`), which stays |
| 2 T8 | agrees | small: `start_server_services` is as it says; the `up` strings moved by +22 (453, 598, 682, 697, 785, 806). Its step 4 does not name `prepare_builtin_stop`, which stays before the two "otherwise" cases (test at :821-826) |
| 2 T9 | agrees | small: `free_port` holds (:673); the `docker rm` check of "line 765" is :787 |
| 2 T10 | agrees | small: the `idle` fixture is at `Updates.test.tsx:238`, not :199. `guide/install.md:43`, `guide/public-link.md:23` hold |
| 2 T11 | agrees | `images.yml` lines moved; only in skipped steps |
| 3 T1 | agrees | holds; the digest `3b0cda93` is `compose.yaml`'s. Home-api |
| 3 T2 | **numbers** | **drift:** `0045_sources`, `0046_net`, `0044_link_tls` (ruling 1). `tasks_turn_id` and `tasks_product_id` are already at `schema.ts:491-492`, from main's `0045_task_lookup_indexes`, so "tasks gains" goes (ruling 4); its `pg_indexes` test still passes. `global-setup.ts` now calls `applyMissingMigrations`. New table `map_returns` has a composite key, which "the primary key's columns" covers. `t/migration-history.test.ts` must pass with `0057_net`, and is not in its Done when |
| 3 T3 | agrees | small: the `database.ts` hunk goes in `runSql`, which replaced the inline call. Ruling 20's list starts from 41 `transaction(` sites, not 32. `withInputLock` is an in-process chain and holds no transaction |
| 3 T4 | agrees | holds. `grantsFor`, `readerGrantsFor`, `agentRole`, `readerRole` exist. Rests on plan 2's keeper |
| 3 T5 | agrees | holds |
| 3 T6 | agrees | steps past the review are skipped |
| 4 T1 | **numbers** | **drift:** `0047_steps`, `0048_calls` (ruling 1). `0047_requested_prompt` exists. `openTestDb` and `createTestDb` now give `TestDb`, which fits |
| 4 T2 | agrees | small: `api.ts` now has `failure()` carrying `details`, which the retry must keep. Its Step 1 grep finds the new routes (`nodes/command-routes.ts`, `programs.update`) |
| 4 T3 | agrees | **small drift:** "`ToolJob` gains `id`": it has it (`database.ts:7`). `call` goes through `runSql`. A write-mode tool may run in read mode by `modeNow` |
| 4 T4 | agrees | **drift:** `NUMBERED` misses new messages that write (ruling 5). `onFrame` (`hub.ts:91`) is new in shape but its chain is the one the task means; `keyOf` is private today, as it says |
| 4 T5 | agrees | small: `unconfirmed` holds (`n/main.ts:143`). `agent.unheard` and `agent.hook_rejected` are sent by `n/terminal/host.ts` through `opts.send`, a file T5 does not name (ruling 5) |
| 4 T6 | agrees | small: `identify` now answers `{ kind, nodeId, keyHash }`, unaffected. `node_unchanged` (`install.sh`) leaves a running built-in node on its old `http://app:8080` until the node image changes; the bare `NODE_KEY` still works, so this is safe |
| 4 T7 | agrees | holds. "Starts from Task 6" is paper |
| 4 T8 | agrees | steps past the review are skipped |

Docker tests run on home-api through `network-build/remote.sh`, 4 slots, inside `hnb-dind`, so the plans' `hornhoof-pebble-$$` and `hornhoof-pg-$$` are inner names
and meet nothing of Ivan's: 1b T6 and T10; 3 T1 to T4 and T6; 4 T1, T3 and T8. Build ruling 6's first sentence still says Docker is not used in this build.

## 5. Rulings needed

1. Migration numbers: replace build ruling 5. The number is what `drizzle-kit generate` gives, plan number + 11, and a plan's text and tests read so. **Recommend yes:** "as written" cannot happen, as the plans' own command picks `idx + 1`, and those file names are taken.
2. One migration lane at a time: 1b T1, T3, T7, 3 T2, 4 T1. Two at once fork the snapshot chain. **Recommend yes.** A lane that was overtaken deletes its own migration, snapshot and journal entry, and generates again after `lane.sh refresh`.
3. 2 T2: `migrateDb` keeps `applyMissingMigrations` after drizzle's migrate. **Recommend yes:** the app's start ran it, and `migrate` takes that job; a database short of a merged migration would stay short.
4. 3 T2: drop "tasks gains" the two indexes, keep its test, and add `t/migration-history.test.ts` to Done when. **Recommend yes.**
5. 4 T4: add `job.program`, `agent.hook_rejected` and `agent.unheard` to `NUMBERED`; `agent.restarted` (a live answer, as `agent.said`) and `node.stopping` stay out. 4 T5 then routes `n/terminal/host.ts`'s sends through the outbox, a file it adds. `agent.unheard` commits more than once, so its handler gets numbered steps or goes in one transaction. **Recommend yes:** ruling 4 of plan 4 numbers what changes data, and a person's unheard words matter most.
6. May a task be split for a lane: 4 T4's protocol part ahead of 4 T5; 3 T3's `sql-check.ts`; 3 T4's `lease.ts`? **Recommend yes for 4 T4's part once writers are idle, not otherwise:** each gives one more lane and one more seam.
7. A lane that runs `npm install` (1b T4, 3 T3) first drops its hard-linked `node_modules` and runs `npm ci`. `lane.sh` links them with `cp -al`, so npm's in-place writes could reach the real tree. Later lanes that import the new packages (1b T5, T6, T7, T8) get dependencies again too. **Recommend yes.**
8. 2 T3: `checkExternalWaits` runs on the way in, beside `wakeLeftBehind` and `dropOldFiles`. **Recommend yes:** it writes, so it belongs to lead work.
9. Landing checks: `npm run typecheck:tests` and `npm run lint`, as main's `npm test` and CI now run them and the plans' Done when lines predate them. **Recommend yes**, at landing, not in every writer's run.
10. 4 T3: strike "`ToolJob` gains `id`". **Recommend yes.**

## 6. Later plans, briefly

| Plan | Tasks | Migration (number + 11) | Real start | Note |
|---|---|---|---|---|
| 5 | 8, with A1 | `0049_network` to `0060` | plan 4 | keeper and peer link; serial |
| 5b | 10 | `0061` | plan 5 | installer, worker keeper; serial |
| 6 | 7 | `0062` | plan 5b | may run beside plan 7 but for the chain, `Machines.tsx`, `updater.sh` |
| 7 | 12, with A1 | `0063`, `0064` | plan 5b; its A1 needs p1 T9 | relay A1 is its own lane in the relay repo |
| 8 | 11 | `0065` | plan 7 | mostly new `m/merge/`, so a good second lane beside plan 9's early tasks once its tables land |
| 9 | 14, with A1 | `0066` | plan 8 | plan 1's A1 with its Task 3 |
| 9b | 9 | `0067` | plan 9 | `score.ts` is pure and may go ahead |
| 9c | 13 | `0068` | plan 9b | `switch-step.ts` is pure and may go ahead; relay A2 is its own lane |
| 10 | 12 | `0069` | plan 9c | `takeover-step` is pure and may go ahead |
| 11 | 11, with A1 | `0070` | plan 10 | `split-step` is pure and may go ahead |
| 11b | 9 | `0071` | plan 11 | node's `saved-work.ts` and `hh-git.cjs` touch little else |
| 13 | 8 here, 9 elsewhere | none | plan 11b | guide tasks last; each page may be a lane |

These need their own task-level scan when they come near. The migration chain stays serial through all of them.
