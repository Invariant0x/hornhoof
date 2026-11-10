Changed only [relay.py](/Users/0x/Projects/hornhoof-edge/relay/relay.py) and [test_peers.py](/Users/0x/Projects/hornhoof-edge/relay/test/test_peers.py). Existing changes and staging are preserved.

- C3 first failed because absent/offline legacy identities were accepted. The narrow guard now refuses them; genuine legacy controls pass.
- I8 first failed because each captured lifecycle failure contained the generated key. Both probes now pass while still detecting one failure and zero errors. No credential was printed.
- Focused tests: 18 passed per interpreter.

Final commands:

```sh
nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v
nice -n 10 python3 -m unittest discover -s relay/test -v
```

Each passed twice, 123 tests per run. Actual `L/gates-relay.sh 75e8a3d` also passed 123 tests. Changed-function maximum CRAP: 9.0609; `login_reason`: 9.0; admin: 29.4; create_binding: 26.2. Dryer: no candidates at 0.8.

Fixture adjustment: frps clears offline run IDs, so explicit offline dashboard answers are also covered in process. No production-scope deviation.

Cleanup completed; socket audit found no owned relay/frp listeners. Sandbox restrictions blocked `ps`/`pgrep` and nice priority adjustment. No staging, commit or deployment.

[Credential-free action log and commands](/var/folders/kk/_yqtl97120d_mtq6p5nnx5pr0000gn/T/p1t6-round4-mghcd53l/actions.txt).