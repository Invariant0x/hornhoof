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
