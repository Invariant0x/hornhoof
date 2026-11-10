### Critical

1. **[relay/relay.py:318](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L318), [relay/relay.py:325-334](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L325-L334), [relay/test/test_peers.py:259-290](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L259-L290) - `C1` incomplete: legacy `Login` still hijacks live foreign legacy sessions not recorded in `routes` (and explicit-ID sessions with `run_id == client_id`), and takeover tests never go through `frps`**
   - **What is wrong:**
     1) [`run_id_recorded_elsewhere`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L325-L334) only checks `routes`, which holds at most one row per binding written only after `NewProxy` succeeds. Any live stock legacy `frpc` session of another binding whose `run_id` is not in `routes` (e.g. a second legacy `frpc` for `globex` whose `NewProxy` was refused with `globex is held`, a legacy `frpc` between `Login` and `NewProxy`, or after a transient `NewProxy` failure) is `online: true` in `frps` with `clientID == runID`. A legacy `Login` with `acme`'s valid key and `globex`'s `run_id` passes `run_id_recorded_elsewhere` (`False`) and [`run_id_conflict`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L318) (`own = client_id or run_id`), displacing `globex`'s live session in real `frps`.
     2) In [`run_id_conflict`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L318), `own = client_id or run_id` allows a legacy login (`client_id == ""`) to match an explicit-ID `-peer` or `-visit` session (no `routes` row) if that session logged in with `run_id == client_id`.
     3) [`test_r1_3_legacy_login_with_foreign_run_id_refused`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L259-L274) and [`test_r1_3_legacy_run_id_of_another_binding_refused`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L275-L290) post directly to `/frp/handler` (`self.plugin_post`), never touching `frps`; lines 270-273 (`route['state'] == 'held'`) pass even if `Login` returns `reject: False`.
   - **Reproduction:** Bind `acme` and `globex`; start `g1 = stack.client("globex", globex_key)` (holds `globex`) and `g2 = stack.client("globex", globex_key)` (`Login` succeeds and stays `online: true` with `runID = r_g2`, `NewProxy` refused). Send a yamux wire `Login` to `frps` (`bind_port`) with `metas={"name": "acme", "key": acme_key}`, `client_id=""`, `run_id=r_g2`: `relay.py` returns `{"reject": false, "unchange": true}` and `frps` accepts the takeover (`error: None`), replacing `g2`.
   - **Required fix:** Bind every legacy `run_id` to its `name` from `Login` onward — e.g. on an accepted legacy `Login` with empty `run_id`, assign `f"{name}-legacy-{secrets.token_hex(8)}"` via `{"reject": false, "unchange": false, "content": {..., "run_id": ...}}` (verified honored by `frps` 0.71.1) and require any non-empty legacy `Login` `run_id` to match `f"{name}-legacy-..."` (or record `(run_id, name)` for every legacy session and set `own = client_id or ("" if CLIENT.fullmatch(run_id) else run_id)`). Add a wire `Login` test against `frps` proving the foreign binding/session stays `online: true` and serves `200` after a refused takeover.

---

### Important

1. **[relay/test/test_peers.py:416-417](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L416-L417) - `I2` incomplete: `test_r5_1_peer_services` does not check `-app`'s target identity**
   - **What is wrong:** [`extra_echo`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L96) returns `{"service": "acme-data", "path": self.path}`, while `Stack`'s `_Echo` returns `{"host": ..., "path": self.path}`. Line 417 checks `-app` only with `self.assertIn('"/through-the-relay"', answer)`, which `extra_echo('acme-data')` also satisfies.
   - **Reproduction:** Point both `acme-3f2a9c1b-data` and `acme-3f2a9c1b-app` at `data_port` in `test_r5_1_peer_services`: the test still passes.
   - **Required fix:** Verify distinct identities on both visited services (e.g. run `app_target = self.extra_echo('acme-app')` or assert `json.loads(answer)` has `'host'` and no `'service'` key).

2. **[relay/relay.py:544](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L544), [relay/relay.py:576](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L576), [relay/relay.py:660-675](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L660-L675), [relay/relay.py:928](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L928) - `I6` incomplete on `NewProxy`: non-string `user.run_id` (and non-dict `content.user`) can still coerce or mutate `routes`**
   - **What is wrong:** [`malformed_id_reason`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L627-L636) validates `run_id` only on `Login`. On `NewProxy`, [`offer_reason`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L660-L675) checks `metas['client']` but never checks `content['user']` or `user['run_id']` before [`register_route`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L542) / [`upsert_route`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L566).
   - **Reproduction:** Post `NewProxy` with `metas={'name': 'acme', 'key': key}`, `proxy_name='acme'`, `proxy_type='http'`, `subdomain='acme'`, and `user={'user': '', 'metas': metas, 'run_id': 7}` (or `'run_id': None`): `NewProxy` returns `{'reject': False, 'unchange': True}` and inserts generation `1` into `routes` with `run_id='7'` (or `''`). With `'run_id': ['r']`, `locked_route_of` runs `straighten_route` before `upsert_route` fails with `sqlite3.ProgrammingError`.
   - **Required fix:** Guard `isinstance(content.get('user'), dict)` in [`call_metas`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L928), reject non-dict `content['user']` (when present) and present non-string `user['run_id']` in [`offer_reason`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L660) before `proxy_check`, and add `NewProxy` non-string `run_id` assertions to `test_r1_3_non_string_ids_refused`.

3. **[relay/test/test_peers.py:725-751](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L725-L751), [relay/relay.py:825-839](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L825-L839), [relay/relay.py:1069-1070](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L1069-L1070) - `C2` tests omit HTTP interleaving, transaction atomicity fault/race, and `unban_binding` coverage**
   - **What is wrong:** Production SQL in [`release_binding`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L794-L822) and [`store_visitor_key`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L841-L853) is atomic, but [`VisitorKeyStoreTests`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L708-L751) only calls helpers sequentially:
     1) [`visitor_key_answer`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L1069-L1070)'s `if not store_visitor_key(...): return self.error(404, ...)` branch is never executed.
     2) `test_store_and_release_are_atomic_with_the_binding` passes even if `BEGIN IMMEDIATE` / `COMMIT` are removed from `release_binding`.
     3) New function [`unban_binding`](file:///Users/0x/Projects/hornhoof-edge/relay/relay.py#L825-L839) is never called by any test (0% coverage; CC 3 gives CRAP 12 > 10).
   - **Reproduction:** Remove `if not ...: return self.error(404, ...)` at `relay/relay.py:1069-1070` (returning `200 {"visitorKey": ...}` on a released/rebound binding), remove `BEGIN IMMEDIATE`/`COMMIT` in `release_binding`, and replace `unban_binding`'s body with `pass`: all 101 tests still pass.
   - **Required fix:** Interleave an HTTP `POST /api/v1/links/acme/visitor-key` paused between `authorize_link` and `store_visitor_key` across concurrent `DELETE` + rebind (asserting `404` and unchanged `visitor_keys`), test `release_binding` rollback when the second `DELETE` fails, and add an `admin ban` / `admin unban` test covering both placeholder and real bindings.

---

### Minor

- Kept ledger minors (`M1`, `M2`, `M3`) left unchanged per brief.
- **[relay/test/test_peers.py:614-618](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L614-L618) - `_DelayedDashboard.do_GET` does not ignore `(BrokenPipeError, ConnectionResetError)` after sleeping**
  - **What is wrong:** Unlike [`_DashboardHandler`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_route.py#L306-L313), writing after `0.7` s / `3.0` s client timeouts is unguarded and can emit stderr tracebacks if loopback RST arrives before `wfile.write`.
  - **Required fix:** Wrap `send_response`..`wfile.write` in `try ... except (BrokenPipeError, ConnectionResetError): pass`.

---

### Round 1 Finding Closure Summary

- **C1:** **Open (Critical)** — empty-`client_id` logins now run `run_id_conflict` and `run_id_recorded_elsewhere`, and legacy reconnect works, but live legacy sessions not in `routes` (and explicit-ID peer/visit sessions with `run_id == client_id`) remain hijackable in real `frps`, and `C1` tests do not exercise `frps` wire login.
- **C2:** **Production SQL closed; test gap open (Important)** — SQLite lifecycle invalidation and `WHERE EXISTS` key-hash guard are atomic, but `visitor_key_answer`'s interleaved `404` path, `release_binding` rollback, and `unban_binding` are untested.
- **I1:** **Closed** — empty-link (`0` rows in `routes`, `generation == 0`) and held-link (`client`, `since`, `generation` preserved) verified in [`test_peers.py:427-460`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L427-L460).
- **I2:** **Open (Important)** — two echo servers exist and `-data` is verified by identity, but `-app` at [`test_peers.py:417`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L417) only checks the echoed path.
- **I3:** **Closed** — [`echo_closes_silent`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L139-L162) enforces zero raw bytes before EOF/reset and fails on empty-body HTTP responses or timeouts.
- **I4:** **Closed** — [`README.md:11,24,37`](file:///Users/0x/Projects/hornhoof-edge/README.md#L24) accurately documents `-data`/`-app` peer services and visitor-key hash storage.
- **I5:** **Closed** — filtered `/api/clients?runId=` with two online clients, missing `runId -> []`, slow (`0.7` s) and hanging (`3.0` s) `Login` reads within `< 1.0` s, and `min(0.5 s, time left)` cap verified in [`test_peers.py:305-325`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L305-L325) and [`624-705`](file:///Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py#L624-L705).
- **I6:** **Partially open (Important)** — `CLIENT.fullmatch`, empty dashboard `clientID` rejection, and `Login` non-string rejection work while keeping absent/empty legacy fields, but `NewProxy` still accepts/coerces non-string `user.run_id`.
- **I7:** **Closed** — invalid `CLIENT` syntax, visitor `http`/`stcp` `NewProxy` refusals, `POST .../visitor-key` `401` cases, and `503 busy` (`Retry-After: 1`, hash unchanged) all tested and passing.
- **Scope deviations (`test_route.py`):** Accepted (four `CLIENT` fixture IDs + omitted synthetic `run_id` in busy-`Login` test; all assertions intact).

---

### Done When

- **Command:** `PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`
- **Result:** `OK` — **101 passed, 0 failed, 0 errors** (in 371.9 s; repository unmodified).
