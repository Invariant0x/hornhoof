# Task 1148: controlled keeper tests

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1148-keeper-clocks.md). These are historical results, not checks of the current release.

Base: `6d17d217e568fcdf7a6e6267b636ef332c205a62`.
The app-call mechanism was first checked at `f5171f05bf33c671ba5949749a57b8c508c93ede`; later task receipts name the expanded candidate.

## Causes and changes

- Joining depended on recurring keeper reports and peer refreshes on real timers. The join's HTTP client also had its own native deadlines. The test freezes the keeper's timers, bootstraps the server with direct steps, and passes the join request to the real app route through an injected fetch. Front-door requests still cross the actual peer link.
- Computer access waited for repeated carrier timers between grants, commands, answers, closes and refused grants. Native AbortSignal deadlines could expire while the machine was busy. The test uses a frozen clock and awaits each real carrier round. It preserves the owner signature, refused grant, replay, front-door refusal, command result and disconnect assertions.
- The older-leader test could receive a real ten-second socket timeout in its log while a report was still being handled. Its reports and holder round now run explicitly on a frozen clock. Setup makes and verifies a real signed bundle directly, without a timed stream fetch. The test checks that its bytes remain unchanged, reports retry only their existing compatibility forms, and neither keeper logs a report failure.

`askApp` retains the ten-second inactivity limit. A normal timer starts when its socket connects, restarts on the response and body data, and clears on completion or close. Stopping the keeper still aborts the request. `appDeadline` owns this scheduling separately from response parsing. No public keeper option, report retry or longer timeout was added.

The eighth repetition exposed another real-time timeout in the adjacent compatibility test that drops refused measures. Its full log and a load sample were attached to task 1148. The head then included that fourth test and the other real timers and report waits in the file, without splitting it or weakening assertions.

All worker keeper cases now use `worker-keeper-time.ts`. Its state wait awaits direct rounds of the server, peer hello, worker, computer carrier, backup keeper and updater. Wall time advances by one virtual millisecond between completed rounds; request deadlines stay frozen during I/O. The runner's cancellation stops an unfinished state wait. Recurring jobs never run against the real clock. The backup recovery test registers the replacement app for injected HTTP, and updater heartbeat files use the virtual timestamp. Fixture listeners use the repository's test port corridor.

The fixture requests an immediate offline refusal instead of a timed front-door hold; those cases assert the refusal and do not test the holding delay. The production holding limits remain unchanged. The peer stream's thirty-second idle limit also uses a normal timer, renewed by incoming or outgoing data and cleared on close. Its regression checks the exact virtual deadline and that observing activity loses no body bytes.

The expanded candidate's author check exposed the lease compatibility case in `keeper-peer.test.ts`: its real clock ran twenty times faster, so a delayed tick could end the lease before the test changed the link answer, yielding a different termination reason. The head included that case in this task. Its wall and monotonic clocks now move only in explicit steps, and the proof answer is deferred to the event loop without a deadline. Lease proof, renewal and reentry rounds are awaited directly. The former 60 and 100 ms pauses at twenty-times speed are 1,200 and 2,000 virtual milliseconds. All original assertions and the production lease limits are preserved. Its app and keeper ports come from the test corridor. No shared clock mechanism or keeper implementation changed for this repair.

## Regression and verification

The original socket timer did not expire after ten virtual seconds: the regression expected `the app did not answer in ten seconds` and received `waiting`. The controlled timer passes that regression. The four boundary tests use a recorded HTTP response and also check an answer before the deadline, continued body delivery, and stopping without advancing time.

From `apps/server`, run each named file twenty consecutive times, stopping at the first failure:

```sh
npx --no-install vitest run test/keeper-app-call.test.ts test/worker-keeper.test.ts --maxWorkers=1
```

Include `test/peer-stream-clock.test.ts` and `test/keeper-peer.test.ts` in the final candidate's repetition command. The final completed repetition receipt belongs to task 1148. The four named files run 62 tests each time; this does not run the whole suite. The stream regression was red before the change: after thirty virtual seconds it received no timeout error. The lease case was red in the recorded author check under load, and green with the controlled clock and deferred probe response.

Earlier local checks on the initial app-call candidate, repeated for the expanded candidate as recorded in the task receipt:

- `npx --no-install vitest run test/keeper-identity.test.ts test/keeper-backups.test.ts --maxWorkers=1`: 27 passed.
- `NODE_OPTIONS=--max-old-space-size=6144 npm run build -w @hornhoof/server`: exit 0.
- `NODE_OPTIONS=--max-old-space-size=6144 npm run -s check:author -- --sha f5171f05bf33c671ba5949749a57b8c508c93ede --base 6d17d217e568fcdf7a6e6267b636ef332c205a62`: lint, server source/test types, 49 selected tests, crapper and dryer passed. Worst CRAP 9.648; no duplicate candidates. The repository has no formatter, so that stage is unavailable.

The initial type check exhausted Node's default 2 GB heap; the completed check above used 6 GB. The first author check found increased complexity in `askApp`; extracting deadline scheduling resolved it before the final candidate.

## Review and limits

Self-review checked cancellation, timer cleanup, the unchanged timeout and compatibility retries, and the retained access assertions. No access, identity, secret or permission rule changes. The built-in `codex review --base` could not inspect the diff because its sandbox could not create a namespace; it is not a passed review. Manual self-review was completed under the turnkey assignment.

No full suite or `run_tests` was started. The release owner retains the broader checks listed by the author selector. No integration into a turn or main is authorized by these checks; integration waits for the head's instruction.
