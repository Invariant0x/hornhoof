# Linux test runtime, task 378

Reduce real waiting in terminal end and hook deadline tests, and distribute long files across shards without losing test names, assertions or cases. Production behavior remains unchanged.

Run the same four-part Linux benchmark before and after, with two Vitest workers per part. Record actual source commits, runtime/hardware, package counts, package wall times and ten slow files. Baseline run 101 has 211 protocol, 2802 server, 1650 node and 1399 web tests, with eight failures. Six server failures predate this work and are outside its scope; two terminal-waits failures include the legitimate initial Antigravity idle state. Observe accepted turns separately while retaining the no-idle-during-work assertion.

Keep real terminal processes, HTTP, ownership checks, retries and cancellation. Virtual time must follow real acceptance, request and Escape milestones. Do not skip cases, add retries or increase test timeouts. Prove each changed family with an intentional temporary fault and restore it before the green run.

Split install-script (94 cases), test-runs (99) and decisions (58), preserving the multiset of full test names. Keep installer stubs in their existing directory, unchanged. Never modify the installer/updater scripts, updater tests, install-nodes-only, server helpers/global-setup/migrations/migration-history/typed/live/decision-context tests, image workflow/github-test-status/RepoSettings, node browser/image/check-queue/check-slots, or test-environment-templates. Do not run mutation tools.

Use targeted tests during development; full run_tests was initially allowed for the two benchmark runs. The later head decision below authorizes one controlled paired job. Final checks: affected tests, tsc for node/server, typecheck:tests, eslint, crapper with existing coverage, dryer. Work on task-378, commit as Ivan Korol without trailers and push this branch. The parent task assesses the combined 30% improvement against turn 7 with task 321; this baseline is a later turn-8 snapshot, not a turn-7 measurement.


## Controlled continuation, head decision at 2026-11-05 16:07 UTC

Run one authorized run_tests job with parts=1. Inside it, sequentially run the original four logical shards for each of two pinned commits. Both inherit one integration base with the same fixes from tasks 408, 374 and 409 when ready. Keep the accepted-turn observation correction in both variants: their difference must contain only task378 clock/splitting optimizations, with no dropped baseline cases. Retain the new queued-run case from the integration branch.

Diagnose all 24 remote timeout cases and their cleanup errors first, then run the moved file and ten affected server families with the original 20000 ms test limit and maxWorkers=2. Do not change the other 23 failed cases without a demonstrated cause.

Use the same Node binary, architecture, CPU quotas, package locks, Vitest configs and cache policy for both variants. Use eight fresh worktrees in the one worker job, each with a separate initially empty npm cache and a fresh npm ci; do not drop or claim to control host page caches. Record load, free/available memory, cgroup memory/CPU limits, cpuset and pressure before/after each stage and periodically during commands. Reject identity/config/limit changes rather than silently comparing unlike conditions. Background load remains an observed limitation.

Label the result as sequential logical-shard measurements on one worker, not the historical four-machine wall time and not turn7. A failed controlled stage remains failed. Preserve original run101/run103 data and failures. While awaiting409 or the worker use task wait_for with a concrete reason.
