# Linux test runtime, task 378

Reduce real waiting in terminal end and hook deadline tests, and distribute long files across shards without losing test names, assertions or cases. Production behavior remains unchanged.

Run the same four-part Linux benchmark before and after, with two Vitest workers per part. Record actual source commits, runtime/hardware, package counts, package wall times and ten slow files. Baseline run 101 has 211 protocol, 2802 server, 1650 node and 1399 web tests, with eight failures. Six server failures predate this work and are outside its scope; two terminal-waits failures include the legitimate initial Antigravity idle state. Observe accepted turns separately while retaining the no-idle-during-work assertion.

Keep real terminal processes, HTTP, ownership checks, retries and cancellation. Virtual time must follow real acceptance, request and Escape milestones. Do not skip cases, add retries or increase test timeouts. Prove each changed family with an intentional temporary fault and restore it before the green run.

Split install-script (94 cases), test-runs (99) and decisions (58), preserving the multiset of full test names. Keep installer stubs in their existing directory, unchanged. Never modify the installer/updater scripts, updater tests, install-nodes-only, server helpers/global-setup/migrations/migration-history/typed/live/decision-context tests, image workflow/github-test-status/RepoSettings, node browser/image/check-queue/check-slots, or test-environment-templates. Do not run mutation tools.

Use targeted tests during development; full run_tests is allowed only for the two benchmark runs. Final checks: affected tests, tsc for node/server, typecheck:tests, eslint, crapper with existing coverage, dryer. Work on task-378, commit as Ivan Korol without trailers and push this branch. The parent task assesses the combined 30% improvement against turn 7 with task 321; this baseline is a later turn-8 snapshot, not a turn-7 measurement.
