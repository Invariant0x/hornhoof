# Task 6 report: client ids, two companies on one machine, peer services (R1.3, R1.4, R5.1, R6.2)

## Files changed
- `relay/relay.py`
  - `CLIENT` regex, `PEER_SERVICES`, `visitor_keys` table (name, key_hash, created_at; hash only, compared with `hmac.compare_digest`).
  - `POST /api/v1/links/<name>/visitor-key`: 200 `{visitorKey}` (32 bytes, base64url), hash stored in place of the one before, 401/404 via `authorize_link`, write through `write()`.
  - Login: `authenticate` (binding as today, or no `metas.key` + matching visitor key), `client_id_reason` (client id must match `CLIENT` with `link == metas.name`, equal `metas.client`, kind `link|peer` with the link key, `visit` with the visitor key; empty id only for a today's tunnel), `run_id_conflict` (`GET /api/clients?runId=` on the call's 1 s budget via `_dash_get`; an online entry with a different `clientID` refuses `this run id belongs to another client`; any dashboard error refuses `relay error: frps does not answer`). New parse step `dash_client_records`: anything that is not a list of `{clientID: str, online: bool}` reads as unknown.
  - NewProxy: visitor-key sessions `visitors may not offer services`; a `-peer` session only stcp `<name>-<m8>-data|app` with its own m8, `sk` >= 32 chars, `allow_users` empty or `["*"]` (`this client may not offer <proxy_name>` otherwise); link/legacy sessions keep Task 2's checks; stcp services get no `routes` row and no generation.
  - `plugin_decide` restructured around `call_metas`/`authenticate`; `binding_ok` removed (its logic lives in `authenticate`/`binding_state`); module docstring lists the new route.
- `relay/test/test_peers.py` (new, 10 tests): R1.4 side-by-side companies; R1.3 second login same id refused by frps and back in 6.3-6.7 s after the drop; R1.3 run id of another client (foreign refused, own allowed, dashboard shape pinned against real frps 0.71.1 first); R1.3 foreign client ids (6 cases) and blocked binding; run-id check fails closed with frps down; R5.1 peer services end-to-end (peer offers data+app, visitor with the `-app` secret echoes through its bind port, wrong secret closes with no answer); R5.1 peer limits (5 refusals + allowed control, link client no stcp, visitor no proxies, R6.2 rotation); R6.2 endpoint (format, hash-only storage, 401/404, rotation).
- `README.md`: "What it does" (client ids, peer services, bytes passed as they come, link to Hornhoof's SECURITY.md) and "What it stores" (hash of the visitor key).
- `relay/test/test_route.py`: **deviation, see below** — only the client-id strings in 4 fixture lines.

## How the new tests failed before the code
- 6 of 7 failed as expected: `visitor-key` answered 404 (route missing); foreign run id got `reject: false` (no run-id check); peer NewProxy limits hit Task 2's `only http proxies are allowed`. Two test-side bugs I fixed (not relay facts): frpc v1 TOML wants `secretKey` (not `sk`) for stcp and a `[[visitors]]` section (not `[[proxies]] role=`), and the wrong-secret visitor needed its own client id while the first visitor was online.
- `test_r1_3_second_login_same_id_refused` exercises frps's own refusal and would pass even without my change; the relay-level run-id and client-id refusals are covered by the direct-plugin tests.

## Test commands and results
- `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test` — 84 tests OK (run 3 times, incl. once under the gate's coverage).
- `python3 -m unittest discover -s relay/test` — 84 tests OK (run 2 times).
- Gates (`gates-relay.sh 75e8a3d`): worst CRAP among this task's new/changed functions is **8.0** (`client_id_reason`, `key_kind`; authenticate 5.0, dash_client_records 7.0, offer_reason 7.0, peer_proxy_reason 7.0, plugin_decide 6.0, login_reason 6.0, run_id_conflict 5.0, binding_state 3.0, dash_clients 2.0, visitor_key_answer 2.0, call_metas 4.0); old `admin` 285.4 and `create_binding` 26.2 unchanged; **dryer: no duplicate candidates**.
- No frps/frpc/relay processes left running; nothing committed or staged.

## Deviations from the plan
1. **`relay/test/test_route.py` touched (fixture strings only).** After implementing, 5 earlier-task tests failed: `DashboardContractTests` posts NewProxy directly with synthetic ids `acme-c1-link`/`acme-c2-link`, which violate the `CLIENT` grammar this task introduces (`m8` must be 8 hex chars), so the relay now refuses them before the scenario under test. I changed only those id strings to valid ones (`acme-a1b2c3d4-link`, `acme-d4c3b2a1-link`); no assertion or logic changed, and the scenarios they pin (1 s budget, pending rows, generation guard) are intact. The alternative, accepting malformed client ids at NewProxy, would have weakened the fail-closed rule.
2. **CRAP-driven split:** `authenticate` split into `authenticate`/`binding_state`/`key_kind`, and `dash_clients` into `dash_clients`/`dash_client_records`, plus three added tests (blocked binding, fail-closed run-id check with frps down, `dash_client_records` shape) to pin the fail-closed branches through behavior.
3. Step 5 (commit) skipped per the build lead's note; changes are uncommitted for review.
