Critical: none remain. Minor: none.

Against the saved pre-fix Task 2 code:

| Previous finding | Fix and regression check |
|---|---|
| 1. Young pending cleared by offline | Fixed; new race test **passed old code**, so coverage remains unreliable. |
| 2. Online route without a row | Fixed; new test fails old code with **200 instead of 503**. |
| 3. Second dashboard endpoint skipped | Fixed; new test fails old code because `FrpsUnknown` is not raised. |
| 4. Missing clientID accepted | Fixed; missing/empty-ID tests fail old code correctly. |
| 5. Stale generation overwritten | Fixed; new test catches old code clearing the newer pending generation. |
| 6. Trace records interleaved | Fixed; race tests **passed old code**, leaving no reliable regression test. |
| 7. Race checked too early | Improved; waits for all client logs, but trace identities remain unchecked. |

Remaining findings:

- **Important**, `relay/relay.py:288`: Lock acquisition has no deadline. A registration behind one route read took **1.414 seconds**, with each dashboard request completing in 0.35 seconds. Bound lock waiting and dashboard work by one plugin deadline; refuse on expiry. No recursive lock deadlock found.
- **Important**, `relay/test/test_route.py:44`: The helper recognizes only success or conflict as outcomes. The suite failed when a client received the valid fail-closed refusal `relay error: frps does not answer`. Track each client’s first outcome and corresponding trace by client ID, including unknown refusals.
- **Important**, `relay/test/test_route.py:105`: The pending regression depends on scheduling and passed old code. Add a controlled young-pending-plus-offline test that asserts held state, refusal and unchanged generation.
- **Important**, `relay/test/test_route.py:88`: The race tests do not reliably expose old trace interleaving. Add a synchronized concurrent trace test that requires one complete record per call.

The fake-dashboard import keeps database operations in temporary directories; no additional issue found there.

Ran once:

`PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`

**31 passed, 1 failed**: `test_r1_1_race_after_empty`.

Files remained unchanged; no test listeners remained.