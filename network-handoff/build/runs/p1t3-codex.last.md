Task 3 complete. Eviction measured **20.16 to 20.46 s**; the bound remains **30 s**.

Files changed:

- [frps.toml](/Users/0x/Projects/hornhoof-edge/relay/frps.toml): keepalive 10 s, heartbeat timeout disabled.
- [test_eviction.py](/Users/0x/Projects/hornhoof-edge/relay/test/test_eviction.py): all four contract tests.
- [relay.py](/Users/0x/Projects/hornhoof-edge/relay/relay.py:50): measured-times comment only.

Verification, all wrapped in `nice -n 10`:

- `python3 -m unittest relay/test/test_eviction.py -v`: four expected failures first, then four passes. Three eviction checks stayed held past 30 s; idle network generation became 2 instead of 1.
- `python3 -m unittest discover -s relay/test -v`: **43 passed, twice**.
- `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`: **43 passed, twice**.
- `gates-relay.sh dc70994`: **43 coverage tests passed**. Worst new-function CRAP: **3.0**. Dryer: **no pairs at 0.8 or above**, including explicit checks of the new tests. Existing source exceptions stayed unchanged.

Deviations/limits: Step 4 required the `relay.py` comment although the Files list omitted it. The referenced spec path was absent, so I used the supplied brief. The sandbox denied `nice` priority adjustment; commands still completed.

Nothing staged or committed. No test frps, frpc, or relay process remains. [Full action log](/private/tmp/hornhoof-task3.PtDh7r/actions.md).