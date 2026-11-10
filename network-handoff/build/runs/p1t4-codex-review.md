- **Critical** [relay/setup-relay.sh:41](/Users/0x/Projects/hornhoof-edge/relay/setup-relay.sh:41): The password enters `.env.new` before permissions are restricted. With umask `022`, it is world-readable; interruption leaves it behind. Create it as `0600` before writing, then install as `0640`.

- **Important** [relay/relay.py:303](/Users/0x/Projects/hornhoof-edge/relay/relay.py:303): An expired budget sets `busy_timeout=0` but still executes SQL. Reproduced an expired upsert creating generation 1. Refuse before executing when time is exhausted.

- **Important** [relay/relay.py:591](/Users/0x/Projects/hornhoof-edge/relay/relay.py:591): `touch()` swallows `WriteBusy`. A locked-database login was accepted after 0.84 seconds without updating `last_seen`. Return `relay error: busy` as the lead requires.

- **Important** [relay/relay.py:759](/Users/0x/Projects/hornhoof-edge/relay/relay.py:759): API write paths leave `WriteBusy` uncaught. A contended binding POST produced `RemoteDisconnected`. Handle it with a structured HTTP error response.

- **Important** [relay/relay.py:170](/Users/0x/Projects/hornhoof-edge/relay/relay.py:170): The watcher uses a 0.5-second dashboard timeout instead of 1 second. A successful response arriving at 0.7 seconds was rejected. Give the watcher the specified timeout.

- **Important** [relay/test/test_restart.py:99](/Users/0x/Projects/hornhoof-edge/relay/test/test_restart.py:99): The restart test never samples company HTTP traffic; it checks route API statuses. Sample `stack.get()` every 0.2 seconds throughout the restart and require every response to be 200.

- **Important** [relay/test/test_restart.py:142](/Users/0x/Projects/hornhoof-edge/relay/test/test_restart.py:142): The busy-string assertion cannot detect busy refusals because relay traces omit refusal reasons. Reproduced a busy rejection with no matching log text. Assert expected restart calls exist and none were rejected.

- **Important** [relay/test/test_restart.py:74](/Users/0x/Projects/hornhoof-edge/relay/test/test_restart.py:74): The health test permits 3 seconds where the brief requires 2. Enforce the required elapsed-time bound.

Minor: none. Reported deviations 1, 2, 4, 5 and 6 are reasonable; deviation 3 causes the timeout finding above.

Done when, from the relay root: `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`, with bytecode writes disabled: **47 passed, 0 failed**.

Gates rerun on a `$TMPDIR` snapshot with only `REPO` redirected: **47 passed, 0 failed**. CRAP passed with the three allowed baselines unchanged; Dryer found no candidates at ≥0.8. Setup and unit files passed `sh -n`. Reviewed files remained unchanged; no test relay/frp listeners remained.