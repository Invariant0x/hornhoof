# Task 6 review round 1: merged findings and lead judgment

Sources: runs/p1t6-codex-review.md, runs/p1t6-review1-agy.md and lead probe p1t6-lead-legacy-runid-probe.log. Both reviewers independently ran Done when: 84 passed. Final snapshot comparison: unchanged (status, diff and file hashes). Lead Done when: 84 passed on 3.12 and 3.14. Lead gates: 84 passed, worst changed CRAP 9.1 (Handler.do_POST), old admin 285.4/create_binding 26.2 unchanged, dryer no pairs.

Accepted Critical:
C1. relay.py:618: legacy Login bypasses run-id ownership; real frps takeover of another binding reproduced by both reviewers and plugin refusal gap reproduced by lead.
C2. relay.py:758 and binding lifecycle: visitor credential survives release and rebind under a new owner. Invalidate atomically across deletion/recreation and prevent stale authorized issuance from restoring a credential after lifecycle change.

Accepted Important:
I1. test_peers.py:215: assert peer registration creates no routes row or generation, both without a link route and with a held link route. Reviewer mutation writing generation 99 escaped current test.
I2. test_peers.py:68: use two distinguishable targets and actually verify service identities.
I3. test_peers.py:99: wrong-secret test accepts any empty-body HTTP response; require zero raw response bytes and guard send/reset too.
I4. README.md:24: app-only promise is false after adding data/app peer services.
I5. test_peers.py:169: pin the filtered runId dashboard response with another client online, missing runId yields [], and bound slow/hanging Login reads. Retain the ledger's 0.5 s per-plugin-read cap, not AGY's proposed 1 s cap.
I6. relay.py:290,603,628: empty dashboard clientID, trailing newline identities and non-string identity fields can pass or become legacy. Validate complete strings, reject malformed identities before any row is changed, preserve absent legacy fields.
I7. test_peers.py:192,269,288: test invalid id grammar, visitor http refusal, missing/link-wrong authorization and visitor-key-as-Bearer, plus visitor-key SQLite contention (503 busy, Retry-After 1, stored hash unchanged).

Not accepted as a fix: AGY Important 3's demand for cap=1.0 conflicts with the binding Task 2 ruling (each plugin dashboard read min(0.5 s, time left)). Keep that cap. Add targeted filtered-query and budget tests as I5.

Minor kept, not fixed:
M1. authenticate reports blocked before validating the supplied key. Refusal remains closed and a name's availability is public.
M2. second-login test captures frps log offset after the second-login wait. Under unusual CPU load it can miss an eviction event; a false failure, not unsafe behavior.
M3. README logging summary omits the visitor-key rotation event; that event contains a name only, never a credential.

Scope deviation accepted: four test_route.py fixture identities now match CLIENT. Preserve assertions. A further fixture-only adjustment to the busy Login test's synthetic run_id is authorized when needed to preserve that test's intended write-contention path.
