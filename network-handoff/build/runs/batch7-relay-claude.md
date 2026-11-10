# Review: batch 7, slice relay (Plan 1 Task 10) and Plan 1's end

Reviewer: Claude (Fable 5.1), read only. Nothing was edited, staged or committed in either repository. No test was run;
the writer's check log (`runs/remote-p1t10-check-20261105-015752-1546682.log`: 311 tests OK under coverage, worst
changed CRAP 9.0, dryer none) is the evidence I used. The lead's batch 7 suite logs (`remote-batch7a-...`,
`remote-batch7b-...`) were still waiting for a slot on home-api when I read them.

What I read: the brief in full (both parts); the plan's top part, Global Constraints, planning rulings, the contract
table, Review Focus 1 to 5, Tasks 10, 11, 12 and 13's setup steps; `FROM-DAVID` rules as given in CLAUDE.md; the skills
`test-driven-development`, `systematic-debugging` and `verification-before-completion`; `hornhoof/AGENTS.md` and
`templates/skills/dev-engineering-rules.md`; spec 3.4 and 3.10; `parallel-map.md` section 3; the ledger's Plan 1
Task 7, 9, 10, 11 and 12 lines. Code: the package `batch7-relay.diff` line by line against the branch `batch-7` of
`hornhoof-edge` (`relay/relay.py`, `relay/frps.toml`, `relay/edge-frpc.toml`, `relay/hornhoof-relay`, the service
units, `relay/setup-relay.sh`, `Caddyfile`, `README.md`, `relay/test/harness.py`, `test_sni.py`, `test_peers.py`,
`test_edge_today.py`) and Hornhoof's `apps/server/src/modules/link/relay.ts`, `test/fake-relay.ts`,
`test/fake-relay.test.ts`, `test/relay-client.test.ts`, `src/modules/link/client.ts`.

## Critical

None found, in either part.

## Important

None found, in either part. What I checked for and did not find:

- Part 1, fail-open: `new_user_conn_reason` (relay.py:1416-1424) refuses a missing, non-string or unknown `proxy_name`,
  any `proxy_type` but `https` and `stcp`, a service name that `CLIENT` cannot parse, and the edge without its token;
  `link_refusal` (relay.py:1408-1413) reads as `freed` when the row is gone and `blocked` when `banned_at` is set; the
  exception path in `handle_plugin` (relay.py:1635-1644) rejects with the exception's type name only. Pinned by
  `ConnectionRuleTests` with 15 odd shapes.
- Part 1, http-mode companies: frps calls `NewUserConn` only for proxies with their own listeners (https, stcp), not for
  the http vhost on 8080, so today's tunnels are not touched by the new op. Evidence: `test_edge_today.py:195`
  (`test_http_mode_company`, a 200 through frps on 443 with the new `ops` line) is in the 311 that passed.
- Part 1, secrets and addresses: the trace line (relay.py:1041-1048) carries `op`, `proxy_name`, `run_id`, `client`, `ms`,
  `reject`; `remote_addr` and the owner's `metas.key` never leave `content`. `test_a_refused_visitor_leaves_no_address_on_the_droplet`
  checks all four processes at the droplet's log levels for both forms of the port. `relay/frps.toml:34` keeps
  `log.level = "error"`, so frp's warn line on a rejected visitor (`proxy.go:283`) stays out of the journal.
- Part 1, the two tests the plan named that could pass with the code wrong: `test_an_answer_is_one_select_by_the_binding_name`
  traces the thread's own connection, which `plugin()` uses, so an added write or scan fails it; `test_a_crowd_of_new_connections_fits_the_queue`
  fails with the old queue of 5 on Linux, since nothing accepts and the kernel drops the SYNs beyond the backlog until
  the 5 s timeout.
- Part 2, each answer Hornhoof reads against what the relay sends: `route_body` (relay.py:713-726) gives exactly
  `state, client, since, generation, relayStarted, evictionBound, sync`, `client` null on `empty`, `since` an int
  (`routes.since NOT NULL`, else `bindings.created_at NOT NULL`), `pending` read as `held`; `RouteBody` in relay.ts
  takes that and lets extra fields through. `sync_of` gives `{state, copy, epoch, generation, at}` and the missing record
  `{off, null, 0, 0, null}`; the fake's `NO_SYNC` is the same. The 409 of a sync post is `{error: not_holder|stale_epoch}`
  (relay.py:1596) and the fake sends the same shape, which `conflictOf` reads. Health 200 `{ok, frps, relayStarted,
  passthrough}` and 503 `{ok: false, frps: false}` match `Health` and `DOWN`. `{key}` and `{visitorKey}` are 43
  characters, over `KeyAnswer`'s 16. A POST with no body passes `declared_body_length` as 0 (relay.py:189-196), so
  Hornhoof's bodiless `changeKey` and `visitorKey` posts are taken.
- Part 2, a name's life: register (`NewProxy`, routes row, generation up one), renew (`Ping` and `touch`; a changed key
  keeps the live tunnel's heartbeat through `ping_keys` and is ignored by `NewUserConn`), block (`binding_state` refuses
  Login and registration, `ping_key_matches` and `NewUserConn` refuse, Caddy answers 410 once the tunnel is gone), free
  (`release_binding` drops the key hashes, visitor key and sync in one transaction, keeps the routes row so the generation
  only grows, `NewUserConn` says `freed` at once, R1.5 holds the name until frps shows the old route gone). The fake
  mirrors what it covers (no bans, no stcp, no TLS, as the table says).
- Part 2, edge against frps: `edge-frpc.toml` (client `edge`, one https proxy `edge`, `customDomains = ["hornhoof.org", "*"]`,
  PROXY v2 to 127.0.0.1:8443, heartbeat off, tcpMux keepalive 10) is exactly what `edge_proxy_reason` admits
  (`EDGE_DOMAINS = [DOMAIN, '*']`) and what `frps.toml` expects (`subDomainHost`, `tcpMuxKeepaliveInterval = 10`,
  `heartbeatTimeout = -1`); Caddy listens on 127.0.0.1:8443 with `proxy_protocol allow 127.0.0.1/32`, `protocols h1`,
  `strict_sni_host`, and sends `*.hornhoof.org` to frps's 8080 after the reserved and blocked lists.

## Minor

Part 1 (Task 10)

1. `relay/test/test_block_by_name.py:70-71`, the ruling on 10 of 200 trace lines over 50 ms. The reasoning holds as far
   as it goes: a trace line's `ms` is a wall clock inside one process on a shared core, a preemption lands on the calls in
   flight, and `NoWaitTests` pins without a clock every wait relay.py itself could add (one indexed SELECT, no write, no
   lock, no dashboard). But the number is not from a measurement: the worst the writer saw on the paced burst was 29.5 ms,
   under the plan's bound, and the 46 to 64 ms worst cases are from the at-once test, which asserts no time. So the plan's
   own assertion was never seen failing. Keep the allowance if the lead wants a test that survives a loaded home-api, but
   the ledger line should say the bound held in every run so far, and 2 of 200 would state the same intent with less room;
   the cost line (a slow path under 5 percent goes unseen) is right as written.
2. `relay/relay.py:1411`, the one read in `link_refusal` draws on the connection's `busy_timeout` of 10 s (relay.py:109),
   not on the call's 1 s budget (`call_deadline`). Under WAL a read waits for no writer, and relay.py runs no checkpoint or
   VACUUM, so the case is rare (recovery after a crash). It is the one wait in a plugin call the Global Constraints' 1 s
   rule does not bound; one line in the ledger would do.
3. `relay/test/test_block_by_name.py:769-776`, `test_a_crowd_of_new_connections_fits_the_queue` opens 200 connections that
   nobody accepts. The kernel caps the backlog at `somaxconn`: 4096 on Ubuntu 24.04 and Debian 13, but 128 on macOS by
   default (about 192 with BSD's 1.5 factor), so this test may fail on the Mac where the README promises the suite runs.
   Not reproduced here; worth one run on the Mac before the branch is called done.
4. `relay/relay.py:1791-1798`, `admin_ban` takes `args[1]` as the name without `check_name`, as before, but `--cut` makes a
   realistic slip: `hornhoof-relay ban --cut acme` stores a ban on a name `--cut` with reason `acme`, restarts nothing and
   prints done. A name that fails `LABEL` should be refused as `admin add` refuses it.
5. `README.md:57`, "frps asks the relay about every new connection to a company's https proxy or stcp service": it also asks
   about every connection to the edge, that is every visitor of hornhoof.org, the API and the tunnels' way in, and relay.py
   receives those addresses too (and keeps none). The frps.toml comment says "the edge's too"; the README's next sentence
   implies it. Say it plainly, since the README is the public word on what the relay sees.
6. `README.md:57` and `relay/hornhoof-relay:113`: a visitor of a blocked https name whose tunnel is still up gets a failed
   connection, not the 410 page; the page comes only once the tunnel is gone (`--cut`, or its next refused login). Both
   texts say "refused", which is true; one clause would spare an operator the surprise.
7. `README.md:59` names two of relay.py's five log lines (`bound`, `released`, with the address). The others, `new link key
   for`, `new visitor key for` and `route of <name> is online outside the relay record`, carry no address or key; the TRACE
   lines appear only with `RELAY_TRACE` set, which `setup-relay.sh` does not set. Nothing false, one line incomplete.
8. `relay/test/test_block_by_name.py:750-767`, `test_an_answer_leaves_at_once_on_a_kept_connection` asserts the socket
   option (`TCP_NODELAY`), not the behaviour (an answer in one round trip). The writer's reason for no clock is sound; a
   comment line saying it is a stand-in for the measured 44 ms would keep the next reader from calling it an
   implementation test.
9. TDD evidence: the package carries no red run. The writer's report says every wrong version tried turned its test red
   (a write, a lock, a dashboard read, a scan, a sleep, the address in the trace, the owner's key, the edge by the link
   rule), and I can see each of those would fail a named test. The claim stands unverified by me.
10. Design cost, stated for the record: before Task 10 a relay.py restart cost new logins; now (`RestartSec=2` in
    `hornhoof-relay.service`) it closes port 443 to every new connection for the restart's length, hornhoof.org, the API
    and the tunnels' way in included. The plan took this cost and pinned 3 s; the README and frps.toml say it. No change
    asked.

Part 2 (Plan 1's end)

11. Global Constraint "every relay commit is signed off": the last nine commits on `batch-7` (Task 7's `dce89a9` through
    Task 10's `8c2090d`) carry no `Signed-off-by` line; the first four (Tasks 1 to 6) do. History is not rewritten, so
    this needs a ruling in the ledger and a sign-off on what the lead lands from here (`lane.sh commit` or the landing
    step is where it was lost).
12. For Task 13, not a finding against Tasks 1 to 12: `relay/setup-relay.sh:44-52` writes `/etc/hornhoof-relay.env` with
    `RELAY_FRPS_API`, `RELAY_FRPS_USER`, `RELAY_FRPS_BIND`, `RELAY_FRPS_STARTED` and the password, and nothing in the repo
    writes `/etc/hornhoof-relay/edge.env` or puts `RELAY_EDGE_TOKEN` and `RELAY_FRPS_HTTPS` beside them. As the branch
    stands, a deploy would start relay.py with `EDGE_TOKEN` empty, so the edge's login and every `NewUserConn` to it would
    be refused and nothing would reach Caddy. The plan puts this in Task 13's setup order (plan lines 943-957), which is
    the one task not yet written and mostly the lead's; flagged so it is not lost with the skipped steps.
13. Freed names and stcp: R7.4 refuses a freed name's https connections and a blocked name's stcp services, as the table
    says. A freed name's lingering `-peer` services keep taking connections from a visitor already logged in until that
    peer reconnects and is refused; only the old owner's own secret opens them, so nothing crosses companies. Within the
    contract; noted for plan 5b, which gives machines their peer settings.
14. The fake's `DELETE /bindings/:name` and `POST /links/:name/key` take a blocked name (the fake has no bans), where the
    relay answers 403 and 404. Hornhoof's `unbind` treats both as gone, so no code path differs; recorded with Task 12's
    deferred minors.

## Rulings checked (ledger lines "Plan 1 Task 10: Ruling")

- 10 of 200 over 50 ms: holds as reasoning, number unmeasured (Minor 1).
- `TCP_NODELAY` and queue 1024: both real waits, both pinned without a clock, loopback only; the macOS cap is Minor 3.
- At-once crowd test and the fake's queue of 512: right, the overflow was the fake's.
- A proxy named `edge` without the token refused outright: right, fail closed; pinned by
  `test_a_binding_named_edge_opens_nothing_without_the_token`.
- A service's link is `CLIENT` on `<name without its service>-peer`: right, `CLIENT` needs a kind; the derivation is the
  inverse of `peer_proxy_reason`'s `f'{name}-{m8}-{service}'`, and the table test pins hyphenated links and `data-app`.
- Trace keeps `run_id` and `client`: both are the proxy owner's, never the visitor's.
- `admin()` split: behaviour unchanged line by line (`add` still needs exactly two args, `unban` and `release` ignore extra
  words, usage goes to stderr with exit 2).
- `start_relay` wraps `_start_relay`: fine.
