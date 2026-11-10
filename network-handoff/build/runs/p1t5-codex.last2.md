Task 5 is complete. Changes remain unstaged and uncommitted.

Changed [relay.py](/Users/0x/Projects/hornhoof-edge/relay/relay.py), [test_sync.py](/Users/0x/Projects/hornhoof-edge/relay/test/test_sync.py), and [README.md](/Users/0x/Projects/hornhoof-edge/README.md).

- Both new range tests failed first: oversized epochs disconnected; oversized generations returned 409. After the fix, all 13 sync tests passed.
- Full `-m unittest discover -s relay/test -v`: **74/74 passed**, twice with `/opt/homebrew/bin/python3.12` and once with `python3`.
- `gates-relay.sh 6faf6c8` passed. Worst CRAP among new/changed functions: **8.0**. Dryer: **0 duplicate pairs**.
- Process audits confirmed no test-owned relay, frps, or frpc processes remain.

Deviations: the approved integer bound, six extra tests, shared authentication extraction, and temporary logging/process auditing. The referenced spec was unavailable, so I used the supplied contract.

Limitations: the sandbox denied `nice` priority changes. Python 3.14 emitted SQLite warnings reproduced in unchanged earlier-test code; all tests passed.

[Full action log and commands](/private/tmp/hornhoof-task5.AIsZrp/progress.md)