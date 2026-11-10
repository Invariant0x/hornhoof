- **Critical**, `relay/relay.py:324`: Expired calls still register successfully. Only lock acquisition checks the budget; dashboard reads retain fixed 0.5-second timeouts, SQLite retains its 10-second wait, and the upsert checks no expiry. Reproduced acceptance and generation advancement after **1.105 s** and **1.272 s**. Apply the remaining deadline throughout and refuse or roll back expired registrations.
- **Important**, `relay/test/test_route.py:423`: The deadline tests allow **1.6 seconds**, so the broken 0.7-second lock wait plus 0.5-second read passes. Tighten verification and test an otherwise successful response arriving after expiry; require refusal and unchanged generation.
- **Important**, `relay/test/test_route.py:142`: Although the helper accepts any first outcome, both race tests still require every refusal to be a conflict. They still reject the documented `relay error: frps does not answer` outcome. Allow that fail-closed refusal while preserving the winner, generation and per-client trace assertions.
- **Important**, `relay/test/test_route.py:430`: The start barrier with `StringIO` still passes old plain-print code. Synchronize between partial writes to exercise interleaving. A review probe using that approach produced **0 valid records with old print, 16 with the current writer**.

Minor: none.

The controlled pending test is fixed and fails old code for the correct reason. Login and Ping retain their behavior; no recursive deadlock found.

Ran once:

`PYTHONDONTWRITEBYTECODE=1 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`

**37 passed, 0 failed.** Files remained unchanged; no test listeners remained.