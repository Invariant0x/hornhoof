# Review: batch 5, slice sni (Plan 1 Task 9), reader Claude

Read: the package `runs/batch5-sni.diff` (commit a35f81f on batch-5), the files on the branch, the plan's top part and
Task 9, the overview's "Our own TLS on the public link", the Task 9 ledger lines, the lead's check log (251 tests OK,
worst changed CRAP 8.0, dryer none). No test run of my own: every doubt settled from the code and from tests that
already ran. No file in either repository touched.

Counts: Critical 0, Important 1, Minor 6.

## Critical

None found.

## Important

1. `README.md:156` (also `Caddyfile:53-54`, `relay/frps.toml:289-290`). "For a company whose link uses https,
   hornhoof.org sees only encrypted bytes, the name being reached and the visitor's address" is not true while that
   company's tunnel is down. frps routes an SNI with no live `https` proxy to the catch-all `*` of client `edge`
   (`relay/edge-frpc.toml:255`), the edge carries it to Caddy, Caddy answers the handshake with the wildcard
   certificate (`Caddyfile:*.hornhoof.org`, `tls /etc/caddy/certs/wildcard.*`), decrypts the request and passes it to
   frps on 8080, which answers its 404 (`Caddyfile`, the closing `handle` block). Browsers trust the wildcard for
   `acme.hornhoof.org`, so every cookie the company's app set for that name, its session cookie included, reaches
   Caddy and frps in clear text during each company update, restart or network blip, and before the company first
   connects. Caddy logs no requests and frps at `error` logs nothing, so nothing is kept, but "sees only encrypted
   bytes" is false and the Global Constraint says the README states what is true at each commit.
   How checked: the path is the one `test_noindex` proves for `nobody.hornhoof.org` (404 from Caddy, its header set,
   under the test's wildcard), and an https-mode name whose proxy is absent is exactly such an unknown name to frps.
   What would make it right: one honest sentence in `What it sees`: while a company in https mode has no live
   tunnel, hornhoof.org answers its name under the wildcard certificate with a 404 and so reads that request. Refusing
   such names at the TLS layer needs an SNI-aware front the overview ruled out, so the design residue (a visitor's
   cookie during the company's downtime; plan 1b's `__Host-` cookie does not help, the wildcard is a valid certificate
   for the name) belongs in QUESTIONS.md for the lead, not in this task's code.

## Minor

- Ledger ruling "HTTP-01 ... seen at the deploy": it will not be. Caddy keeps the certificates it already has and
  orders nothing at a reload, so a broken HTTP-01 shows only at the next renewal, weeks later. Task 13 should check
  Caddy's log at the first renewal or force one against the staging CA. Not a code fault.
- `relay/test/harness.py:617-621` `render_caddyfile` is now used for `relay/edge-frpc.toml` too, but a missed
  replacement still says "The Caddyfile no longer holds", which would mislead whoever next edits the frpc file.
- `relay/test/test_sni.py:1339-1340` `test_caddy_https_on_loopback_only` passes because the harness sets
  `default_bind 127.0.0.1`; it would still pass with every `bind 127.0.0.1` removed from the repo's Caddyfile. The adapt
  test right below (`test_droplet_caddy_listens_as_the_plan_says`) is the one that proves the file; the first test is
  redundant rather than wrong.
- `relay/test/test_sni.py:1271` and `:1495` assert only `reject` is true; a refusal for the wrong reason (an
  exception turned into `relay error: ...`) would pass. Fail closed either way, so no harm reaches a person.
- `relay/test/test_edge_today.py:1048`: one line added to a Task 8 test the plan says stays unchanged. The ruling is
  sound (frps now holds the port, only the handshake can fail), the assertions are the same.
- `relay/frps.toml:298` `proxyBindAddr = "0.0.0.0"` makes 443 IPv4 only where Caddy listened on both. The plan's
  value, already in QUESTIONS.md; `"::"` would give both families on Linux if an AAAA record exists.

## Checked and found right

- Routing: exact SNI match wins, `*` is the catch-all, no SNI goes to the edge (`test_r7_2`); an http-mode name's
  SNI goes to Caddy and on to frps 8080 with the Host header, so no company's bytes can reach another name.
- A stranger cannot take `hornhoof.org` or a catch-all: `custom_domains` refused for every non-edge session
  (`relay.py:891`), `subdomain` must equal the bound name, `*` and `.` are impossible in a bound name; the edge path
  needs the token (`hmac.compare_digest`, `relay.py:1343`), `client_id == 'edge'` at login, and exactly
  `['hornhoof.org', '*']`; with no `RELAY_EDGE_TOKEN` nothing matches. A `metas.edge` session never falls back to
  binding checks (fail closed).
- The token reaches no log: `trace_plugin` writes only `client` from the metas; the harness scrubs it from every
  process log; the tracked toml carries `{{ .Envs.EDGE_TOKEN }}`.
- The visitor's address: PROXY v2 from frps's frpc to the company and to Caddy, believed from 127.0.0.1/32 only
  (`test_proxy_header_is_believed_from_127_0_0_1_only`); frps at `error`, edge frpc, Caddy and relay logs hold no
  visitor address (`test_the_droplet_logs_no_visitor_address`). The `log.level = "error"` ruling is right: the
  README's "which it does not keep" needs it.
- Today's tunnels: wss to 443 now goes frps, edge, Caddy, frps bind port (`test_tunnels_through_the_edge`,
  `test_edge_today.py` through the same path); X-Forwarded-For to an http-mode company is as before Task 9.
- One route across types: `frps_route` reads both types and raises on two; `register_locked` refuses a held name
  whatever the type; `routes.type` constrained to http/https (`test_r1_1_one_route_across_types`).
- Health `passthrough`: the probe handles an unset or malformed address as false, runs inside the watcher, and 503
  carries no `passthrough`.
- `frps.service` gets `AmbientCapabilities` and `CapabilityBoundingSet` CAP_NET_BIND_SERVICE as the plan says;
  `edge-frpc.service` matches the Interfaces. Writing `/etc/hornhoof-relay/edge.env` and the relay's own
  `RELAY_EDGE_TOKEN`/`RELAY_FRPS_HTTPS` are Task 13's by the plan (lines 955-957), so their absence here is no gap.
- No em dash and no "ё" in the diff; Python syntax within 3.12; `Stack.close` stops the edge and the passthrough
  echoes (`test_close_ends_the_edge`).
- Not verifiable here: that each new test was seen red first (the lead's log is the green run; the writer's report
  names three red reasons that fit the code).
