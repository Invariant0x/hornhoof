# Batch 5, plan 1 Task 9: what the lead accepted from its one review

Readers: Claude fable (`runs/batch5-sni-claude.md`), Antigravity Argon high (`runs/batch5-sni-agy.md`). Check: 269 tests on 3.12 and 3.14. One fix round.

## Critical

A. **Anyone with a binding's key can take the name `edge`, and cut hornhoof.org off.** (Antigravity, reproduced on real frps 0.71.1) A legacy login with `run_id='edge'` is registered by frps under clientID `edge`, since Task 6's rule refuses only CLIENT-shaped run ids; then `edge-frpc`, on restart, fails with `client_id [edge] for user [] is already online`, and hornhoof.org, the API, the tunnels' wss and every http-mode company are gone. Refuse run id `edge` for every login that is not the edge. `login_reason` is at CRAP 9.0, so a small helper, say `reserved_run_id(run_id, client_id)`. Unit and wire tests in `relay/test/test_sni.py`, including on the real frps wire: the squatter refused, the edge still comes back after a restart.

B. **A browser's HTTP/2 connection to Caddy swallows a live https company.** (Antigravity, by RFC 9113 9.1.1 and a real frps and Caddy) All names share one IP, and Caddy serves `*.hornhoof.org` with a trusted wildcard certificate over h2. A browser with an open connection to any http-mode, reserved or unknown name reuses it for `acme`, an https company whose tunnel is up, so Caddy decrypts its cookies and answers 404. And a tab polling across a leader switch stays stuck on a kept-alive 404 after the tunnel is back. The lead's ruling, as Antigravity proposes: `protocols h1` in the Caddyfile, so browsers never coalesce; add `strict_sni_host`, so a mismatched Host gets 421 and `test_edge_today`'s case changes to it with this ruling; and `Connection: close` on `*.hornhoof.org`'s 404 and 410 answers, so a polling tab opens a fresh connection that frps can route once the tunnel is up. wss tunnels and http-mode companies work on h1. Tests on the real Caddy: ALPN offers no h2; a 404 closes its connection; a mismatched Host is 421, and that today's edge tests stay right. Cost, accepted: http-mode companies lose HTTP/2 until they move to https.

## Important

1. **The README says something false.** (Claude) `README.md:156` and the Caddyfile and frps.toml header comments say hornhoof.org "sees only encrypted bytes" for an https-mode company. While that company's tunnel is down, frps sends its name to the edge's catch-all, and Caddy answers under the wildcard certificate, decrypts the request, cookies included, and passes it on for the 404. Nothing is kept. Say so, plainly and in the project's plain voice, in "What it sees", `README.md:15` and `:46`, and the two comments: a live https tunnel ends at the company under its own certificate and never reaches Caddy; a name with no tunnel falls back to Caddy's 404 or 410, which reads that request and keeps nothing. The design choice is with Ivan and David AI (QUESTIONS.md item 13), not for this fix.
2. **A test proves the harness, not the file.** (Antigravity, both) `test_caddy_https_on_loopback_only` passes with `bind 127.0.0.1` removed from the Caddyfile, because the harness's global `default_bind 127.0.0.1` binds everything. Harm: Caddy's https port open to the internet on the droplet, with no test seeing it. Bind only test Caddy's http site to loopback with a targeted replacement, so that https rests on the Caddyfile's own lines. See it fail by removing the Caddyfile's bind, in a copy.

## Minor: while you are there

- `watch_frps` probes the https port, up to 1 s, before stamping `ok_at`, and even when frps does not answer: a slow probe can flip /api/v1/health to 503 past `HEALTH_MAX_AGE_S`, which reads as the relay being down. Stamp when `frps_answers()` succeeds, and skip the probe when it does not. A test first; this one a person would feel.
- `edge_token_matches` raises on a lone surrogate: refuse it with `edge login refused`, using `LONE_SURROGATE`.
- `edge-frpc.service`: add `Wants=frps.service`, as frps.service does.
- `_PassthroughEcho` picks its port by `_free_port()`, as the other echo now does, and `Stack.close` joins its thread: that is the same lost-port failure as batch 3's.
- `trace_client` says `edge` for the edge.
- `render_caddyfile`'s error names the right file.

## Deferred (ledger)

The HTTP-01 ruling's "seen at the deploy" is optimistic: Caddy reuses its certificates, and a broken renewal shows weeks later, so the deploy's checklist should test it (QUESTIONS.md item 12). Two tests assert only `reject`, not the reason. One line was added to a Task 8 test, ruled sound.
