The writer (Kimi) answered your review of Plan 1 Task 2. The build lead accepted all seven findings, reverted
deviation 1 to the plan's rule (and had Task 1's `test_fact_dashboard_shows_the_route` read the route while its first
client is online), and accepted deviation 2. Check the fix, still read-only (change no file):
- For each of your seven findings: is it fixed, and does its new test fail on the old code for the right reason
  (read `git -C /Users/0x/Projects/hornhoof-edge diff 9c83be0` and `relay/test/test_route.py` as they are now)?
- Anything new the fix broke or opened (the per-name lock now around every read: can it deadlock or make a plugin
  call wait over 1 s; the generation guard; the fake dashboard tests importing relay.py).
- Run `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` once.
Report findings as before (Critical / Important / Minor, file:line), or say none remain.
