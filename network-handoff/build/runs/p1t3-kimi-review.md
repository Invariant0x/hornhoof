All checks complete. Here is my review.

## Review: Plan 1, Task 3 (silent client goes, idle one stays)

### Findings

**Critical: none.**

**Important: none.**

**Minor: none.** Notes only, no action needed:
- `relay/relay.py:50` is modified although the Files list names only `frps.toml` and `test_eviction.py`; this is justified because Step 4 explicitly asks for the measured-times comment beside `EVICTION_BOUND_S`.
- `relay/test/test_eviction.py:55` — `assertLessEqual(elapsed, EVICTION_BOUND_S)` duplicates the deadline assert inside `wait_route`; harmless redundancy.
- `relay/test/test_eviction.py:69` — `test_r3_2` uses a fixed `time.sleep(150)` rather than a wait, but that is exactly what the task's Step 1 specifies, and the assertions after it are real.

### What I verified

- **Change is minimal and matches the brief**: `frps.toml` sets `transport.tcpMuxKeepaliveInterval = 10` and `transport.heartbeatTimeout = -1` with the rewritten comment; `relay.py` gets only the measured-times comment (`network 20.16/20.46 s, today 20.26 s`); new `test_eviction.py` implements all four tests from Step 1, including printing `eviction took <s> s` and polling every 0.5 s (deadline-based, no unbounded loop).
- **Tests exercise the shipped config**: `harness.Stack.start_frps` copies the repo's `relay/frps.toml` verbatim (only ports/password substituted), so the new eviction knobs are what the tests run against.
- **Step 2 holds (R3.1/R3.2 genuinely proven)**: I copied the repo to `$TMPDIR`, restored the old `frps.toml` (`heartbeatTimeout = 90`, no keepalive interval) and ran the four eviction tests: **all 4 fail** (both silent-client tests exceeded the 30 s bound with the route still `held`; the idle test failed with generation `2 != 1` because frps dropped and the client re-registered). With the new config the same run passes.
- **Measured bound is honest**: my run measured 20.27/20.28 s (network) and 20.27 s (today) against the 30 s bound; all under 25 s, so keeping `EVICTION_BOUND_S = 30` is exactly per Step 4.
- **Review Focus 4**: `test_r3_2` holds one `today` and one `network` client idle 150 s, both `held` at the same generation, and both still serving HTTP 200 — covered.
- **frps.toml comment is true**: "drops a silent client within 30 s" matches measurement; "heartbeats ... are checked by the plugin as before" matches `relay.py`'s `plugin_decide`, which checks every `Ping` via `binding_ok` (blocked/missing binding refused), unchanged by this task.
- **No em dashes / no private content** in the changed files (`test_public.py` passes); fail-closed behavior untouched; Python is ≤3.12 (the relay.py change is a comment only); no processes or ports left behind after either suite (verified with `ps`).

### Done when

`/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` from the relay repo root: **Ran 43 tests in 307.670s — OK (43 passed, 0 failed).**

### Gates

`gates-relay.sh dc70994`: exit 0. Coverage run of the whole suite passed (43 tests OK). **Crapper**: no function added or changed by this task (relay.py change is comment-only); every function under CRAP 10 except `admin` (285.4), `do_DELETE` (47.4), `create_binding` (26.4→26.2), all pre-existing at `dc70994`. **Dryer**: "No duplicate candidates found."

Verdict: the change is correct, minimal, and proven; no findings.
