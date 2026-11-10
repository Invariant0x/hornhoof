Task 2 complete. Report:

## Files changed
- `relay/relay.py` — the routes table in `init_db`; `FrpsUnknown`; `frps_route` + `_dash_get` (dashboard reads, basic auth, 0.5 s timeout each, fail-closed); `route_of` + `check_route_holder` + `straighten_route` + `route_body` (R2.1 body with `relayStarted`, `evictionBound: 30`, `sync: None` until Task 5); `register_route` under a per-name lock (R1.1, upsert `generation+1`, `client = metas.client or 'legacy'`, `state pending`); `shared_route_fields` (R1.2: `locations`/`route_by_http_user`/`group`); `proxy_check` holding today's checks plus the new rules; `GET /api/v1/links/<name>/route` with 404/401 (counted in `bad_keys`)/503 `unknown`; `RELAY_TRACE=1` one-line JSON trace per plugin call (`TRACE {...}`, no key, no metas beyond `client`).
- `relay/test/test_route.py` — new, the 7 tests from the brief (held-then-empty, second registration refused, 10 racing clients, shared routes refused, errors-are-not-empty including `dashboard=False`, plugin calls under 1000 ms, route body has no key).
- `README.md` — "What it stores" now says which client holds each link's route, with run id, since when and in which registration.
- `relay/test/test_frp_facts.py` — one assertion, see deviations.

## Test commands and results
- `python3 -m unittest relay/test/test_route.py -v`: failed first with 404 on the route path (expected), then 7/7 OK.
- `python3 -m unittest discover -s relay/test` (3.14): 20 tests, OK (run twice, before and after the CRAP refactor).
- `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test`: 20 tests, OK (twice, including after the refactor).
- Gates `gates-relay.sh 9c83be0`: crapper — worst CRAP among this task's new/changed functions is `proxy_check` 9.2 and `register_route` 9.0, all under 10; `plugin` fell from 16.4 to 8.0 (new rules live in new small functions it calls); `do_DELETE` fell from 96.4 to 47.4 via a shared `wrong_key` helper; `admin` 285.4 and `create_binding` 26.2 untouched. Dryer: no duplicate candidates at 0.8. `harness.Stack.plugin_calls` now has callers from every test in `test_route.py`.
- No frps/frpc/relay process left running; no commit, no `git add` (per your note).

## Deviations from the plan, with why
1. **`straighten_route`: `offline` empties even a young `pending` row.** The brief says a younger pending row reads held without qualification, but taken literally that refused a legitimate new registration for up to 10 s after the old route died, which broke Task 1's `test_fact_dashboard_shows_the_route` (legacy client must register as soon as frps shows the old route offline). The pending window's stated purpose is "frps has not shown the route yet", which at read time means `absent`; `offline` provably means frps took the registration and it is gone. So: `absent` + young pending reads held (racing registrations still refused, R1.1 intact); `offline` + pending of any age becomes empty. Verified by the racing test (exactly one of 10 let through, generation matches) and the fact test.
2. **`relay/test/test_frp_facts.py` line 25.** Task 2's R1.1 requires the plugin to refuse the duplicate with `router config conflict: acme is held` before frps ever sees it, so frps's `proxy [acme] already exists` can no longer appear in the client's log. I changed that one assertion to the plugin's refusal message, with a comment; the fact the test pins (one route per name, the second client starts only after the first stops, and frps then accepts it through the plugin) is still fully exercised. This was the only way to satisfy both the brief's Done when and R1.1.

## Log
- Read Task 1 code (relay.py, harness, tests, frps.toml, README), fetched frp v0.71.1 `msg.go`/`types.go` to confirm plugin content field names, and `client/proxy/proxy_wrapper.go` to learn frpc retries a refused NewProxy after 30 s (this drove deviation 1's design).
- Tests first: saw them fail with 404; implemented; fixed one harness-usage bug in my own test (`enterContext` returns the entered value); iterated.
- Refactored three functions (`do_GET`, `handle_plugin`, `trace_plugin`) into smaller methods to bring every new/changed function under CRAP 10. Step 5's commit is yours, as instructed.
