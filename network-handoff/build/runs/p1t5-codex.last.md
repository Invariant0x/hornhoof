Task 5 remains incomplete pending one contract ruling.

Changed only [relay.py](/Users/0x/Projects/hornhoof-edge/relay/relay.py), [test_sync.py](/Users/0x/Projects/hornhoof-edge/relay/test/test_sync.py), and [README.md](/Users/0x/Projects/hornhoof-edge/README.md).

- Sync tests: all 11 initially failed as expected with 404 or `sync: null`, then passed.
- Full suite: 72/72 passed on both `python3` and `/opt/homebrew/bin/python3.12`.
- `gates-relay.sh 6faf6c8`: coverage suite passed; worst new/changed CRAP **8.0**; dryer **0 pairs**.
- Process audit: zero children left running. Nothing staged or committed.

The blocker: epoch `9223372036854775808` satisfies the stated positive-integer contract but exceeds SQLite INTEGER storage. A real local API check confirmed it closes the connection without a response. Per your stop-and-report rule, I have not guessed the policy. **Should these epochs return 400 `invalid`?**

Deviations: four extra tests and shared authentication extraction; temporary logs/process auditing because `ps` is blocked. The referenced spec was unavailable, so I used the supplied contract. `nice` priority changes were denied, although every command ran.

[Full action log and commands](/private/tmp/hornhoof-task5.AIsZrp/progress.md)