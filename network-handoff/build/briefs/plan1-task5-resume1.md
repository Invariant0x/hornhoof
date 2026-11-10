Build lead's ruling on your stop: yes. An `epoch` or `generation` above 2**63 - 1 (SQLite's INTEGER range) is 400
`invalid`, and so is a JSON `true`/`false` where an integer is wanted (Python's bool is an int: check the type
exactly). Add the tests (each fails first), then finish the task as briefed: the whole suite with
`/opt/homebrew/bin/python3.12` twice and `python3` once, and the gates (`.../gates-relay.sh 6faf6c8`). No commit.
