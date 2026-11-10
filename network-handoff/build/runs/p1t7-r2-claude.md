# Plan 1 Task 7, review round 2 (Claude, read only)

Tree: `/home/altera/hornhoof-network/hornhoof-edge`, uncommitted against bd24cc1. Package `runs/p1t7-r2.diff`.
Checked: the diff line by line, the writer's fix report, and two focused runs through `light.sh` (logs, free of key
values, in `network-build/tmp/p1t7-r2-claude/`):

- Fixed tree: `python3 -m unittest relay/test/test_keys.py` plus `RouteTests.test_r2_3_errors_are_not_empty` and
  `SyncTests.test_r2_4_unknown_frps`: 48 tests, OK, 94 s (`fixed-tree.log`). Local Python is 3.13.5; the lead's 3.12
  and 3.14 runs stand for those.
- Pre-fix copy: bd24cc1 with round 1's `relay.py` (from `runs/p1t7-r1.diff`) and the new `test_keys.py`, in-process
  classes plus `KeyTests.test_r2_4_a_freed_names_sync_record_goes_with_it`: 50 failures in 38 tests, all in the new
  or changed tests, each for the reason the fix addresses (`prefix-red.log`). So every finding's test really fails
  without its fix.

## Findings from round 1

**C1 ADDRESSED.** One rule in one place: `Handler.request_bytes_may_remain` (relay.py:1165) is true for any
Transfer-Encoding or for a declared, unread, non-zero or untrusted Content-Length; `send_json` (1151) then sends
`Connection: close`, which also sets `close_connection`, so every route answers through it: `error`, 503 from
`handle_one_request`, plugin answers. Unsupported methods go through stdlib `send_error`, which closes too (the PUT
case, 501). `read_json` (1176) is the one body reader and the one Content-Length parse (`declared_body_length`, 166:
digits only, one header only). Keep-alive holds for a clean request: `test_clean_requests_keep_their_connection`
(plugin call twice, no body, empty body, body read in full) passes on the fixed tree and would fail if the rule
closed too much. Pre-fix: 15 route shapes ran the smuggled binding (`[401, 201]`, `[415, 201]`, `[404, 201]`, later
`429` as the smuggled requests used up 127.0.0.1's limit), the plugin was reached (`[401, 200]`), chunked and
untrusted lengths ran it (`[201, 201]`), over-limit and big bodies left the connection open.

**I1 ADDRESSED.** `sync` is in `BINDING_LIFETIME_TABLES` (928) and goes in `release_binding`'s transaction, under the
same `EXISTS` guard as `visitor_keys` on the HTTP path (941-954); the `routes` row stays, as ruled. Pre-fix,
`test_r2_4_a_freed_names_sync_record_goes_with_it` showed the next owner the stranger's record (`epoch 900`); fixed
tree: empty record and a post with epoch 1 taken, through real frps.

**I2 ADDRESSED.** `ping_keys` is in the same list, same transaction, same guard. Pre-fix: `{'ping_keys': 2, 'sync': 1}`
left after both the HTTP DELETE and `admin release`; `test_refused_release_leaves_what_belongs_to_the_binding` pins the
guard (stale hash, then banned). README now says retired hashes are kept, only a heartbeat can use them, and a release
deletes them; `authenticate_call` (1106) uses them for `op == 'Ping'` only, and `ping_key_matches` joins the live,
unblocked binding on `link_hash`, so the README is true at this commit.

**I3 ADDRESSED.** `LABEL.fullmatch` (178); `CLIENT` already used `fullmatch`. Pre-fix `'globex\n'`, `'www\n'`,
`'acme\n'` answered `503 != 400` (they reached the dashboard) and `admin add 'globex\n'` made the binding (`0 != 1`,
its stdout redirected so no key reached the log). `admin add` uses `check_name`, so it benefits.

**I4 ADDRESSED.** test_route.py:190 asks `started(name, within=2)` of the client's own random name and nothing else in
the fixture moved; the writer's can-fail proof (`runs/p1t7-r1-i4-can-fail.log`) is the right kind of evidence for an
assertion a correct relay never trips. Passes on the fixed tree.

**Minor ADDRESSED.** Docstring says `list|add|ban|unban|release|banned-caddy`, which is what `admin` (1408) takes; it
also lists `/key` and the 503 answers of `names` and `bindings`, all true.

## The writer's four extra changes

1. `store_sync` guarded by the authorizing hash (523-535): right. It is one more `EXISTS` in the one INSERT..SELECT, so
   it is atomic with the holder check; it bites only for a post in flight across a release or a key change, where it
   answers 409 `not_holder`, and a post with the retired key is already 401 at `authorize_link`. The race test fails
   pre-fix (`200 != 409`, the next owner inherited the post). Same shape as Task 6's visitor-key ruling. Accept.
2. `key_answer` reads its bounded body before it commits (1268-1286): right. Order is authorize, `read_json`, store,
   answer, so a key is never handed out on an answer that closes over unread bytes of its own request, and a body it
   cannot read (over limit, not JSON, not text, chunked, untrusted length) is 400 with the key unchanged, on both key
   routes; pre-fix all ten cases handed out a key (`[200] != [400]`). An unauthorized request still closes unread,
   which carries no key. Accept.
3. `read_json` refuses Transfer-Encoding on every route, the plugin's too (1178-1180): right, and it does not cost
   frps. frp's http plugin posts a `bytes.Reader` body through Go's `net/http`, which sends Content-Length, never
   chunked; the suite's real frps 0.71.1 Login, NewProxy and Ping calls all pass with the refusal in place, and
   `test_clean_requests_keep_their_connection` shows two plugin calls on one kept connection. Hornhoof's `relay.ts`
   (`call`, line 45) sends a `JSON.stringify` body through `fetch`, which carries Content-Length. For the lead: a
   future client that streams a body without Content-Length gets 400; Task 11's client and fake must send framed
   bodies. Accept.
4. `test_r6_1_change_key` no longer compares `relayStarted`: right, and it hides nothing. `relay_started()` (244) is
   the max of `STARTED`, the watcher's `back_at` and the `RELAY_FRPS_STARTED` file; `store_link_key` and `key_answer`
   touch none of them, while `back_at` moves whenever the watcher's probe (a 1 s dashboard cap, 0.5 s interval) fails
   once and recovers, which is the flake. `test_restart.py` covers the field. Accept.

## New breakage in what the fix changed

None found. No em dash or "ё" in the changed files; no syntax past 3.12 (`:=`, parenthesized `with` are 3.8 and 3.10);
no key value in either log (checked for 43-character base64url tokens: none). Assertions that could hold a key compare
booleans or status lists. `FrpsUnknown` now propagates from `create_binding` out of `create_lock` to
`handle_one_request`, which answers 503 before anything was sent; `name_checks` still runs before the dashboard read.

Minor, no action required: `sync_answer` (1246) and `binding_body` (1337) carry the same Content-Type line; dryer finds
no pair at 0.8 and the brief kept this round to the list.
