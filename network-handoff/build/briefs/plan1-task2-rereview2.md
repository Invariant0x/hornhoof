Kimi answered your four remaining findings on Plan 1 Task 2 (a 1 s budget per plugin call: lock wait and dashboard
reads share it; the race helper takes any first outcome and matches trace records by client id; a controlled
young-pending-plus-offline test on the fake dashboard; a barrier test for atomic trace lines, which Kimi says it could
not make fail on plain print). Check, read-only as before: is each fixed, does the deadline logic hold (no path that
waits over 1 s inside a plugin call, no path where an expired budget lets a registration through, Login and Ping
untouched), anything new broken. Run `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` once.
Report Critical / Important / Minor with file:line, or say none remain.
