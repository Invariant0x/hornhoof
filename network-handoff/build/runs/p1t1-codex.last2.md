Task 1’s authorized work is complete. Both full suites pass.

Files: copied all 15 requested runtime files unchanged. Added the five project documents, font license, deployment example, `.gitignore`, six `.github/` files, and five relay test files.

Tests run, wrapped in `nice -n 10`:

- `python3 -m unittest relay/test/test_public.py -v`: expected initial failure, then 6 passed.
- `python3 -m unittest discover -s relay/test -p test_today.py -v`: failed before the harness existed.
- `python3 -m unittest relay/test/test_today.py -v`: 4 passed.
- `python3 -m unittest relay/test/test_frp_facts.py -v`: 3 passed.
- `sh relay/test/frp.sh && python3 -m unittest discover -s relay/test -v`: 13 passed on Python 3.14.
- `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v`: 13 passed.

The archive checksum, private-words check, shell syntax checks, and harness restart/cleanup checks passed. All test processes stopped.

Deviations: used your revised file enumeration and `CODE_NAMES` exception. The sandbox prevented `nice` from lowering priority, but commands ran. ShellCheck was skipped as briefed. Commits and Step 12 remain with the build lead. No staging, alternate Git directory, pushes, deployments or private-file writes occurred during the resumed work.