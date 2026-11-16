# Task 1148: controlled keeper tests

Base: `6d17d217e568fcdf7a6e6267b636ef332c205a62`.
Executable candidate: `f5171f05bf33c671ba5949749a57b8c508c93ede`.

## Causes and changes

- Joining depended on recurring keeper reports and peer refreshes on real timers. The join's HTTP client also had its own native deadlines. The test freezes the keeper's timers, bootstraps the server with direct steps, and passes the join request to the real app route through an injected fetch. Front-door requests still cross the actual peer link.
- Computer access waited for repeated carrier timers between grants, commands, answers, closes and refused grants. Native AbortSignal deadlines could expire while the machine was busy. The test uses a frozen clock and awaits each real carrier round. It preserves the owner signature, refused grant, replay, front-door refusal, command result and disconnect assertions.
- The older-leader test could receive a real ten-second socket timeout in its log while a report was still being handled. Its reports and holder round now run explicitly on a frozen clock. Setup makes and verifies a real signed bundle directly, without a timed stream fetch. The test checks that its bytes remain unchanged, reports retry only their existing compatibility forms, and neither keeper logs a report failure.

`askApp` retains the ten-second inactivity limit. A normal timer starts when its socket connects, restarts on the response and body data, and clears on completion or close. Stopping the keeper still aborts the request. `appDeadline` owns this scheduling separately from response parsing. No public keeper option, report retry or longer timeout was added.

## Regression and verification

The original socket timer did not expire after ten virtual seconds: the regression expected `the app did not answer in ten seconds` and received `waiting`. The controlled timer passes that regression. The four boundary tests use a recorded HTTP response and also check an answer before the deadline, continued body delivery, and stopping without advancing time.

From `apps/server`, run each named file twenty consecutive times, stopping at the first failure:

```sh
npx --no-install vitest run test/keeper-app-call.test.ts test/worker-keeper.test.ts --maxWorkers=1
```

The final completed repetition receipt belongs to task 1148. This command runs four boundary tests and all twenty-nine worker keeper tests each time; it does not run the whole suite.

Additional local checks on the executable candidate:

- `npx --no-install vitest run test/keeper-identity.test.ts test/keeper-backups.test.ts --maxWorkers=1`: 27 passed.
- `NODE_OPTIONS=--max-old-space-size=6144 npm run build -w @hornhoof/server`: exit 0.
- `NODE_OPTIONS=--max-old-space-size=6144 npm run -s check:author -- --sha f5171f05bf33c671ba5949749a57b8c508c93ede --base 6d17d217e568fcdf7a6e6267b636ef332c205a62`: lint, server source/test types, 49 selected tests, crapper and dryer passed. Worst CRAP 9.648; no duplicate candidates. The repository has no formatter, so that stage is unavailable.

The initial type check exhausted Node's default 2 GB heap; the completed check above used 6 GB. The first author check found increased complexity in `askApp`; extracting deadline scheduling resolved it before the final candidate.

## Review and limits

Self-review checked cancellation, timer cleanup, the unchanged timeout and compatibility retries, and the retained access assertions. No access, identity, secret or permission rule changes. The built-in `codex review --base` could not inspect the diff because its sandbox could not create a namespace; it is not a passed review. Manual self-review was completed under the turnkey assignment.

No full suite or `run_tests` was started. The release owner retains the broader checks listed by the author selector. No integration into a turn or main is authorized by these checks; integration waits for the head's instruction.
