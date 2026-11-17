# Task 1242: wait for inbox count reports

Status: DONE. Kind: bug. Risk: none. Branch: task-1242.
Base: `11aa5777c4a5f74a550c0e53570ec35ebae39f53`. Tested code commit: `877f28cd0193da7b3f304aa09d9a8d46e9eda659`.

Cause: finding the letter list did not guarantee that the passive effect had reported its unread count to the parent, so the test raced that effect.

The only code change is in `apps/web/test/Inbox.test.tsx`. It waits for the actual callback values 2, 1 and 0 before checking the corresponding letter, status and focus state. All original assertions, request payloads and focus checks remain. There are no sleeps, new deadlines, retries of failed tests or changes to production code.

## Requirement to evidence

- Original failure: [run 97 RED](task-1242-evidence/red-run-97.log), from task 1120's `tests-97-3.log`, pinned to the base above. The complete assertion says the callback's last call was undefined where 2 was expected at line 92. It fails before either mark button is clicked.
- Local baseline: `cd apps/web && npx --no-install vitest run test/Inbox.test.tsx`, three attempts, each exit 0 with 15 tests. See `baseline-01.log` through `baseline-03.log`. This does not establish a reliable local RED. The production callback lives in `useEffect([unread, onUnread])` in `apps/web/src/ui/Inbox.tsx`, after the DOM commit. DOM discovery and effect execution are different completion conditions; the original loaded run observed that gap. No focus or product defect is demonstrated.
- Stability: the same named command, 10 consecutive fresh processes on the tested code commit, all exit 0, 15 tests each. See `repeat-01.log` through `repeat-10.log`. File execution took 530 to 629 ms per run; elapsed time is reported by the runner, never asserted in the test.
- Build: `npm run build -w @hornhoof/web`, exit 0. Existing large-chunk warning only. See `build.log`.
- Types: `npx --no-install tsc -p apps/web/tsconfig.json --noEmit`, exit 0, no diagnostics. See `types.log`.
- Lint: `npx --no-install eslint apps/web/test/Inbox.test.tsx`, exit 0, no diagnostics. See `lint.log`.
- Own review and security check: all checks remain, only their synchronization changes; no access, input, secret or dependency change. No blocking findings. The first `codex review --base 11aa5777c4a5f74a550c0e53570ec35ebae39f53` could not execute git because bwrap could not create a namespace; this is unavailable, not a pass. A second review of the pasted exact diff and relevant production context found no correctness or security defects, without shell access. Both logs and the review input are retained.

Evidence and observed exit codes are recorded in [checks.json](task-1242-evidence/checks.json). The test SHA-256 is `30de042eb516b6f38469948130bb3fc0f064837e298e272cc982a487e1084220`. The evidence commit adds documentation and logs only, preserving that test fingerprint. The repository's exact-candidate `check:author` receipt is attached to task 1242 after this evidence commit.

## Limits and handoff

No neighboring test file changed. No browser run is needed for this test-only change. No full suite or `run_tests` was started, and neither main nor turn-31 was updated. The head integrates the pushed task branch and owns the next full release run. The original run's failure is the RED evidence; it was not reproduced by the three unloaded local attempts.
