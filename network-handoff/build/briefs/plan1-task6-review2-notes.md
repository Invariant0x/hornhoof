# What to review

Plan 1 Task 6, written by Kimi in /Users/0x/Projects/hornhoof-edge on main. Base commit 75e8a3d. Pending change: git diff 75e8a3d including staged relay/test/test_peers.py.
Changed files: relay/relay.py, README.md, relay/test/test_peers.py and relay/test/test_route.py.

Read briefs/plan1-task6-notes.md and the writer report runs/p1t6-kimi.md in the build folder if needed. The new client id grammar forced four fixture-string substitutions in test_route.py; no assertion changed. Judge the deviation as well as the task. Review all Interfaces and Steps, real-frps dashboard shape, takeover checks, key storage/rotation, peer restrictions, actual visitor traffic and its wrong-secret refusal. Check that services and route generations are independently verified.

Run Done when yourself from the relay root with PYTHONDONTWRITEBYTECODE=1 nice -n 10 /opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v. Review read only. Do not run gates in this repository because they write ignored files; the lead runs them separately. Temporary artifacts only in TMPDIR. Do not print secrets even in probes.

Every plugin blocking operation shares the 1 s deadline; dashboard reads go through _dash_get. Every new SQLite write uses write(). API contention is 503 busy with Retry-After: 1. No Python newer than 3.12, no new dependencies. Report Critical, Important, Minor separately with file:line, reproduction and required fix. Do not modify any repository file.

# Review round 2 after the first fix

Do not start from the previous review's assumptions. Review the complete pending Task 6 diff against 75e8a3d, including the staged new test_peers.py. Writer fix report: runs/p1t6-kimi-fix1-resume2.md. Fresh fix run was interrupted before its report; the same session resumed to finish the edits and verification. Accepted first-round findings and grade: runs/p1t6-review1-merged.md. Fix requirements: briefs/plan1-task6-fix1-fresh.md. The earlier fix1 and resume1 attempts made no fix edits; the fresh Kimi session and its resume2 are the actual fix run. Review remains read only. Temporary files only in TMPDIR, bytecode disabled, no gates that write repository artifacts.

Close each accepted finding with evidence:
C1: nonempty run_id always ownership checked, including empty client_id legacy login; account for real frps's runID fallback identity; legitimate legacy reconnect stays; foreign binding/session stays live after an attempted takeover.
C2: visitor credentials expire atomically with binding lifetime, API and admin paths; stale authorized issuance cannot restore credentials after release/rebind. Check the actual SQL atomicity and intentional interleaving test, not just the sequential happy path.
I1-I3: stcp creates no route row/generation and cannot change a held link's identity/generation; two distinguishable service targets; wrong-secret check rejects ANY HTTP answer, including empty bodies, with zero raw bytes before EOF/reset.
I4: README no longer promises app-only access after the peer services were added.
I5: filtered /api/clients?runId pinned with two online clients and a missing id; slow/hanging login read bounds. LEAD RULING: keep min(0.5 s, time left) for plugin dashboard reads, per the binding Task 2 ruling. Do not reopen AGY's proposed cap=1.0 as a finding; the watcher is a different explicit exception.
I6: CLIENT.fullmatch, malformed/non-string identity rejection before changing rows, empty dashboard clientID unknown, actual missing/empty legacy fields supported.
I7: invalid CLIENT grammar, visitor http and stcp refusals, visitor-key endpoint auth (no key and visitor key as Bearer), SQLite contention with Retry-After:1 and old hash unchanged.

Accepted scope deviations: four earlier test_route.py identity fixture substitutions and a fixture-only busy-Login run_id adjustment; keep original assertions. Every write through write(), shared 1 s plugin budget, hash-only credentials, no sensitive output.

Kept Minor findings, do not demand fixes unless new evidence raises their impact: (M1) blocked refusal reported before key validation, still closed; (M2) second-login test's log offset recorded after the second-login wait, possible false failure under unusual load; (M3) README event list omits visitor-key rotation, which logs no credential. All kept in the ledger.

Run the whole Done when yourself and give passed/failed counts. List any remaining or new Critical/Important separately, with file:line and reproduction. Explicitly say whether each C1/C2 and I1-I7 is closed. Do not fix anything.
