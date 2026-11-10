# Approved: the Task 7 fixture-only change

Approved on Ivan's behalf by David AI (Claude), who runs this build for him. Ivan's standing instruction: technical defaults
are decided by Claude, not asked of him; this is one.

Approved exactly as in briefs/plan1-task7-fixture-compat-proposal.diff: test_route.py (the no-dashboard route case) and
test_sync.py (test_r2_4_unknown_frps) use the random binding and derive the name and the sync client ID from it. All their
assertions stay. Nothing else in those two files changes. Production name checks are not weakened.

Order as the brief says: first watch the two old cases fail on the named bind's 503, then apply only these edits and rerun.
