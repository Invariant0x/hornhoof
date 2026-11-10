# Notes for this review from the build lead

- This is review round 3, the last, of plan 1 Task 7. It is in the real relay tree `/home/altera/hornhoof-network/hornhoof-edge`, uncommitted, against bd24cc1; the package `/home/altera/hornhoof-network/network-build/runs/p1t7-r3.diff` runs from dce89a9, so it also holds bd24cc1, the lead's Linux fix of a test helper, which went in without a review and needs one too.
- Writers' reports, claims to verify and not to trust: `network-build/runs/p1t7-codex-detail.md` (the code), `network-build/runs/p1t7-gates-report.md` (harness fix, create_binding split).
- Two no-dashboard fixtures in test_route.py and test_sync.py changed exactly as `network-build/briefs/plan1-task7-fixture-approval.md` allows. The ledger holds every ruling before this task, Task 6's on client ids, visitor keys and binding lifetimes above all.
- `relay/relay.py`'s retired key hashes in `ping_keys` were the Mac writer's way to keep a live today's tunnel alive after a key change (R6.1 "live tunnels stay"). The plan did not prescribe them. Judge them: can an old key do anything but keep a heartbeat, ever, across release, rebind, ban, and repeated rotation?
- The lead runs the full suite on both Pythons and the gates on the test machine. You run at most focused tests, through `/home/altera/hornhoof-network/network-build/light.sh <command>`. test_restart_burst is under separate investigation.

# This is a scoped re-review, round 3, the last

Round 2 left one finding: `read_json` took a short read as a whole one, so a request with a declared body that ended early still changed a key or made a binding. Say ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its tests really fail without the fix: a body cut short on /key, /visitor-key and /bindings answers 400 with `Connection: close`, changes nothing, and the old key still works. Report new Critical or Important breakage only in what this fix changed; do not reopen the rest. Read the code and the repository's own tests; do not write new traffic through Caddy.
