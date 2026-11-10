# Notes for this task from the build lead

- Work in the relay repo `/Users/0x/Projects/hornhoof-edge`, branch `main`. The tasks before this one are committed
  (HEAD dce89a9). Do not `git add`, do not commit: the build lead commits after review. The task's "Commit" step is
  the build lead's.
- Run the relay tests with `/opt/homebrew/bin/python3.12 -m unittest discover -s relay/test -v` (the droplet's
  Python) and with `python3`. Run exactly two plain final full suites total, one per interpreter, then the gate coverage run. Repeat only for a new change or failure. Leave no frps/frpc/relay process
  running when you finish.
- relay.py today (after Task 6): every plugin call has one 1 s budget (`PLUGIN_CALL_S`, `call_deadline()`); the
  per-name lock (`hold_route_lock`), each dashboard read (`_dash_get`, min(0.5 s, time left)) and each write
  (`write`) draw from it, and a spent budget refuses with `relay error: frps does not answer`. Keep every
  new blocking step inside a plugin call on that budget. Trace and log lines go through `log_line` (one atomic write).
- Gates, after the Done when passes: run
  `/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build/gates-relay.sh dce89a9`.
  It runs the whole relay suite under coverage (relay.py measured in the processes the harness starts), then crapper
  and dryer on this task's .py files, and prints both reports. Rules:
  - Every function this task adds or changes scores under CRAP 10. Bring it under by splitting it into smaller
    functions, by testing it through the relay's behavior, or both.
  - Old functions this task only touches may keep their old score if the task does not raise it. Scores now:
    `admin` 29.4 and `Handler.create_binding` 26.2; every other function is under 10 (`do_DELETE` 8.8, `do_POST` 9.1).
  - dryer: no pair at 0.8 or above that involves code this task added.
  - The gate script writes `.metrics/` and `target/` in the relay repo (git-ignored); write nothing into its folder.
  - Report both results (the worst CRAP among the task's new or changed functions, and dryer's pairs) at the end.
- A test that would still pass with the code wrong is not a test: check each new test fails for the reason you expect
  before the fix, and say how it failed in your report.

# Task 7 specific notes

You are a NEW separate Codex writer. Task6 is accepted/committed at dce89a9 after Ivan-authorized round4; do not revisit it or the kept M1-M8. Work only Task7. Root Codex leads; Kimi and Antigravity review concurrently afterward, at most3 Task7 review rounds. No writer commits or staging. No TaskA1 optional chosen-key body, no Task8 harness/Caddy work.

Allowed files before any additional approval: relay/relay.py, relay/hornhoof-relay (help text only), relay/test/test_keys.py (new). Run sh -n on the changed wrapper; never execute its root/systemctl operations. Keep visitor lifetime/release guards and role restrictions intact. Newly generated keys belong only in their one response, never diagnostic assertions, logs, labels or other results. Use exact comparisons via boolean/fixed messages for generated secrets.

Known compatibility fact, NOT an unexplained earlier-test failure: two existing no-dashboard cases currently create a named acme binding through the API before asking route/sync. Task7 R1.5 intentionally requires that named bind to return503 unknown. A narrow fixture-only proposal is L/briefs/plan1-task7-fixture-compat-proposal.diff: use the expressly permitted random binding and derive the same route/sync target (with matching sync client id), preserving ALL assertions. Those files are outside Task7 Files, so explicit owner approval is pending. DO NOT apply it or edit test_route.py/test_sync.py unless the lead creates L/briefs/plan1-task7-fixture-approval.md explicitly saying Ivan approved these exact fixture changes. Check that marker after focused Task7 tests, before final full verification. If approved, first observe the two old cases fail because named setup sees503, then apply only the proposed fixture edits and rerun them. If no marker exists, leave them untouched, report the known compatibility blocker after completing authorized core/focused work, and do not claim full Donewhen/gates passed. Do not weaken production name checks to accommodate obsolete fixtures and do not introduce cross-test monkeypatches. The lead can resume this same writer after an answer; no duplicate session.

Keep the new key endpoint inside the current write helper and CAS-style binding authorization, including its503 busy/Retry-After1 behavior and wrong-key counts. Preserve the name availability rate limits, validation/reserved/taken ordering, requested-name unknown failure and random-name bypass. Refactor only allowed source as needed for under10 gates; existing do_POST9.1 and create_binding26.2 must not worsen. Report actual measured gates, not estimates.

Read full ledger L/progress.md, every Ruling. Task6 final evidence L/runs/p1t6-review4-merged.md is available. If a new underlying fact is false or an earlier failure's cause is unknown, stop/report per the original rules. All tests target owned local Stack fixtures only, never public hornhoof.org, any company or GitHub. No external dependency download or installation. L=/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/network/.superpowers/network-build.

# Preparation note for Task 7, not a launch brief

Do not start Task7 until Task6 is accepted and committed and the actual base is filled into its generated brief.

R6.1 says live sessions stay after key rotation. This includes a today's legacy tunnel using its original30s heartbeat settings. Current plugin_decide authenticates Ping with the session's original metas.key, so a key update alone would cut that existing legacy session at its next Ping. Cover actual legacy traffic through a heartbeat after rotation as well as the plan's network-client test; preserve ban/free refusal and the old key's refusal at every public API and new Login. Resolve implementation within Task7 allowed files, without broadening the contract or printing credentials. This is a reminder of the existing live-session requirement, not a new ruling or permission to weaken authentication.

The new authenticated key update must also preserve the existing binding-lifetime ownership rule: a request authorized before release/rebind must not overwrite the next owner key. Recheck the authorizing hash in the update, with a failing local authorization/write race regression first. This follows the existing lifetime guards, not a request for TaskA1 chosen-key support.
