# Plan 1 Task 7, review round 3 (Claude, read only)

Scope: the one round 2 finding, `read_json` taking a short read as a whole body. Uncommitted tree in
`/home/altera/hornhoof-network/hornhoof-edge` against bd24cc1.

## Verdict: ADDRESSED

## How I checked

1. Code: `relay/relay.py:1178-1188`. `read_json` now raises `ValueError('the body was cut short')` when
   `len(raw) < length`, before `self.body_read = True`. So on a cut-short body:
   - `key_answer` (`relay.py:1279-1282`) and `binding_body` (`relay.py:1343-1347`) catch the `ValueError` and answer 400
     before `store_link_key`, `store_visitor_key` or any binding write; `sync_answer` (`relay.py:1251-1254`) likewise;
     the plugin path (`plugin_request`, `relay.py:1322`) turns it into a reject.
   - `body_read` stays `False`, so `request_bytes_may_remain` (`relay.py:1173`) is true and `send_json` adds
     `Connection: close`; `BaseHTTPRequestHandler` closes after that answer. Nothing of the declared body can run as a
     next request.
   - `length == 0` still reads `b''` with no false raise.
2. Tests: `relay/test/test_keys.py:812-832`, `test_a_key_is_not_changed_by_a_body_cut_short` (on `/key` and
   `/visitor-key`) and `test_a_binding_is_not_made_from_a_body_cut_short`, four bodies each (`CUT_SHORT_BODIES`,
   line 661: no bytes, whitespace, a whole value, part of a value) with `Content-Length: 20` and the sending side shut
   down. Each asserts exactly one answer, status 400, `Connection: close`, the connection closed, the old key hash
   unchanged, no lifetime rows, and for bindings `counts() == (1, 0)`. The key test ends with a real `POST /key` using
   the old key, 200: the old key still works.
3. They fail without the fix: `runs/p1t7-r3-red.log` shows 12 failures, `[200] != [400]` and `[201] != [400]` for no
   bytes, whitespace and a whole value, and the missing `Connection: close` for part of a value. That is the right
   reason in each case: the old code took the short read as the body and acted on it.
4. Green run, mine, foreground, through `light.sh`:
   `python3 -m unittest relay.test.test_keys -v` in the relay repo: `Ran 48 tests in 92.761s`, `OK`.
5. No em dash in the changed hunks of `relay.py` or `test_keys.py`; no syntax newer than 3.12 in the new lines
   (`:=` and `TimeoutError` are fine on 3.12).

## New Critical or Important in what the fix changed

None.

## Minor, not new, not reopened

- `Handler` sets no socket timeout (`relay.py:1128`), so a client that declares a length and then stalls without
  hanging up holds `rfile.read` and its thread open. The fix neither caused nor worsened this; the old code blocked
  the same way. Noted for the ledger, not for this round.
