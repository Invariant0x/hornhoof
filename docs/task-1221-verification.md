# Task 1221 verification

Status: DONE_WITH_CONCERNS. Checked code and observed remote task-1221 / turn-31: 150e3e1fdd916fa1d5347022c0aa1caf3ba756cc. Base: da719b0e7094ce0b78e35a48c13085f9f7521e5b. Integration used the normal fast-forward push, without force, before the head started the full release run. This evidence branch adds documents only and preserves the checked code SHA.

## Evidence

- RED on the base plus new regression tests: both keeper fixture cases fail with EADDRINUSE. The unavailable-address regression also fails because a second bind unexpectedly succeeds. See fixture-red.log and closed-port-red.log.
- `npm run build -w @hornhoof/server`: exit 0 on the checked candidate.
- `NODE_OPTIONS=--max-old-space-size=2048 npm run -s check:author -- --sha 150e3e1fdd916fa1d5347022c0aa1caf3ba756cc --base da719b0e7094ce0b78e35a48c13085f9f7521e5b`: exit 0. Eslint passed; server types including tests passed with the requested heap; 18 named files, 390 passed, 0 failed / skipped. The selector record and full log are in author.log; author-tests.json holds all case results.
- `NODE_OPTIONS=--max-old-space-size=2048 node docs/task-1221-series.mjs /tmp/task-1221-series-150e3e1f`: exit 0. Ten sequential fresh Vitest processes, explicitly naming worker-keeper-fixture.test.ts and worker-keeper.test.ts, each 31 passed and 0 failed / pending. Total 310 passed. Every run checks the same SHA and clean worktree before and after execution. Load 1m across all samples: 5.32 to 9.36. No builds ran during these series. Full stdout/stderr, JSON and sampled load for all ten runs are under series/.
- Own manual diff and security inspection: no confirmed findings. The change touches server test helpers and tests, holds only loopback addresses, registers cleanup early, adds no dependency and leaves production code untouched. Existing scenario, access, identity and redaction assertions and timeout settings remain.
- `git diff --check` passed. Both code commits use Ivan Korol <invariant0x@icloud.com> and Signed-off-by, without Co-Authored-By. Remote task-1221 and turn-31 were read back at the checked SHA after the fast-forward.

## Concerns and limits

- Oracle's separate rare stalled round remains outside this port repair; none of the ten final series failed. This evidence does not establish its cause or claim it fixed.
- `codex review --base task-1221-base` could not read the diff because the sandbox could not create a namespace. Its exit code 0 is not review proof. Manual self-review is complete, and independent approval is not claimed.
- The repository has no formatter. The author check has no coverage adapter for the standalone verification harness, so CRAP is unavailable rather than zero. These optional stages are not reported as green. Dryer reports one pre-existing identical four-line clock fixture in outbound-live.integration.test.ts and outbound-webhook.test.ts; both blocks are unchanged from the base.
- The selector lists 889 indirect files left to the release owner's full run. The Docker lab, whole suite, run_tests and main push were not run by this task. Named lab/network tests and server types cover the changed lab import; the Docker scenario stays with the release profile.
- Development checks first found a Socket return from a test cleanup callback, corrected to void before the candidate. One initial author invocation had an invalid SHA and exited 2 before checking; the corrected exact-SHA command above passed. The logs retain both events.

Next: the release owner runs the combined release checks. See task-1221-load.xlsx / .csv for per-series counts and load, task-1221-proof/verification.json for the machine-readable receipt, and task-1221-checks.tar.gz for all logs.
