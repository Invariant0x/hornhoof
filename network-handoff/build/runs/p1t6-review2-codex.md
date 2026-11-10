**Critical:** None remaining.

**Important, must fix:**

- **I6 partly open, [relay/relay.py:665](/Users/0x/Projects/hornhoof-edge/relay/relay.py:665):** Authenticated `NewProxy` with `user.run_id=[]` returns `reject:false` and stores generation 1 with an empty run ID. Validate this field before registration; test that malformed values leave rows unchanged.
- **C2 production fixed, coverage open, [test_peers.py:725](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:725):** Both store tests pass with the release transaction removed. My coordinated interleaving then left an orphan visitor credential. Add a synchronized issuer/release regression that detects this unsafe implementation.
- **I2 open, [test_peers.py:417](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:417):** Wiring both services to the data target still passes the service test. Assert the app target’s parsed identity, as the data check already does.
- **New, [test_peers.py:345](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:345):** Subtest labels include credential-bearing `metas`. An induced Login regression printed the generated binding key in captured unittest output. Use credential-free case labels and redact failure details.

Accepted findings closed:

- **C1:** Real-frps takeover probes were refused; the victim remained online and served HTTP; its own legacy reconnect succeeded.
- **I1:** Tests verify no peer route row/generation and unchanged held-link identity.
- **I3:** Raw-byte check rejects empty-body HTTP 200/403, confirmed independently.
- **I4:** README’s app-only promise is removed.
- **I5:** Real filtered dashboard, missing ID, slow/hanging reads and spent-budget checks pass; 0.5 s cap retained.
- **I7:** Grammar, visitor restrictions, endpoint authentication, rotation and busy-response checks pass.

**Minor:** No new findings. M1-M3 remain retained per ruling.

Done when, run from the relay root:

```sh
PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v
```

**101 passed, 0 failed**, 372.836 seconds, exit 0. `nice` could not adjust priority. The pending diff remained unchanged; no gates ran. The fixture-only deviations preserve the original assertions.