- **Critical:** none remaining. C1 and C2 are closed, including stale DELETE, concurrent ban, issuance races and rollback.
- **Important, I8 remains open:** [relay/test/test_peers.py:637](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:637), also line 660. Both `assertIsNone(visitor_key_hash())` assertions render the actual value. Injecting a plaintext credential observation produced **1 failure, 0 errors per case**, with the generated key present in captured diagnostics. Use boolean `value is None` assertions with fixed messages, preserving detection.
- **Minor M1, kept:** [relay/relay.py:949](/Users/0x/Projects/hornhoof-edge/relay/relay.py:949), blocked-before-key refusal ordering.
- **Minor M2, kept:** [relay/test/test_peers.py:218](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:218), late log offset can miss eviction and falsely fail.
- **Minor M3, kept:** [README.md:41](/Users/0x/Projects/hornhoof-edge/README.md:41), event summary omits visitor-key rotation.
- **Minor M4, kept:** [relay/test/test_peers.py:916](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py:916), delayed dashboard responses can emit socket-close noise. No fixes requested for M1–M4.

**I1–I7 are closed.** All eight supplied behavioral/diagnostic probes passed. **G1 is closed** using the lead’s actual gates: maximum changed CRAP **9.1**, dryer **no duplicate candidates**. Independent busy/deadline/rollback checks passed without leaked transactions.

Done when, run once:

```sh
PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v
```

**117 passed, 0 failed, 0 errors; 384.429 seconds.** `nice` reported its priority adjustment was denied; the suite completed successfully.

Status, staged diff and file hashes remained unchanged. No test processes or additional listening ports remained.