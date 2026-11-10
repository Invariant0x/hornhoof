# Plan 2 Task 4: the pass-through and front. Writer's report

Status: DONE_WITH_CONCERNS. The task is done and every hand-in check is clean. The concerns are the rulings below, where the plan
was silent or would have lost data.

## Read before writing

- Skills: `test-driven-development` (with `writing-good-tests.md`), `systematic-debugging`, `verification-before-completion`.
- Rules: `/home/altera/hornhoof-network/CLAUDE.md`, `hornhoof/AGENTS.md`, `hornhoof/templates/skills/dev-engineering-rules.md`,
  the brief, and sections 1, 3, 4, 5 of `parallel-map.md`.

## Files (lane `/home/altera/hornhoof-network/wt/p2t4`, nothing staged or committed)

- New: `apps/server/src/net/proxy.ts` (215 lines), `apps/server/src/net/front.ts` (18), `apps/server/src/front.ts` (15).
- New: `apps/server/test/proxy.test.ts` (96 tests), `apps/server/test/front.test.ts` (11 tests).
- `apps/server/test/fake-relay.ts` untouched. No dependency added. No other file changed.

## Results

| Check | Command | Result |
|---|---|---|
| Done when, tests, final code | from `apps/server`: `light.sh npx vitest run test/proxy.test.ts test/front.test.ts --maxWorkers=2` | 2 files, 107 tests passed |
| Done when, types | `npx tsc -p apps/server/tsconfig.json --noEmit` | prints nothing, exit 0 |
| Test types | `npm run typecheck:tests`, before the last edit | exit 0 |
| Lint | `npm run lint`, before the last edit; eslint on the two files changed by it after | exit 0 |
| Whole suite, with `HEADERS_MS` at 75 000 | `remote.sh run p2t4-ruling9 '... cd .../hornhoof && .../hh-suite.sh'` | exit 0: release 44, `typecheck:tests`, protocol 127, node 1206, server 1930, web 767, no failure |
| crapper, with `HEADERS_MS` at 75 000 | `gates-hornhoof.sh lanebase server 'test/proxy.test.ts test/front.test.ts'` in the same run | 21 functions, highest CRAP 3.0, all at 100% coverage |
| dryer 0.8 | same | "No duplicate candidates found." |

Hand-in follows Ivan's ruling relayed by the lead: writers no longer run mutator; it runs once at the plan's review. The hand-in is
the whole suite through `hh-suite.sh`, crapper and dryer, all from one run. No mutator
run of mine was running when the ruling came, so nothing had to be stopped.

Mutator results from before both rulings, for information, not a hand-in condition: `net/proxy.ts` 21 killed, 0 survived;
`net/front.ts` 1 killed, 0 survived; `src/front.ts` reported no mutants. So the four survivors of the first run were already closed;
how is under "Mutator survivors". The mutator has not seen Ruling 9's change (one more `serve` option, two constants). The review's
run decides.

The last edit came after that run: `HEADERS_MS` from 75 000 back to 60 000, its comment, and one line of `test/front.test.ts`. By the
lead's word the focused tests are enough for this one number: `test/proxy.test.ts` and `test/front.test.ts` through `light.sh`, 107
passed, with tsc and eslint on the changed files. So the whole suite, crapper and dryer saw 75 s, not 60 s.

Logs: `network-build/runs/remote-p2t4-ruling9-20261104-193244-435738.log`, and from before the rulings `runs/p2t4-mut-final.log`,
`runs/p2t4-mut-front.log`. Earlier suite runs do not count: `remote-p2t4-suite-...` ran in the wrong folder and stopped at
`npm error ENOENT`; `remote-p2t4-suite2-...` and `remote-p2t4-handin-...` passed, but on code before later edits.

## How the tests failed before the code

1. No modules: both files failed with `Cannot find module '../src/net/proxy.js'` and `'../src/net/front.js'`, the plan's Step 2.
2. To see each test fail on its own, I then ran them against a skeleton (a handler answering 500, an upgrade destroying the
   socket, pure functions returning wrong values): 102 of 102 failed, for example `expected 500 to be 502`, `expected '::' to
   be '0.0.0.0'`, `expected '' to be 'HTTP/1.1 502 Bad Gateway'`, and 16 timeouts on tests waiting for what never came. Log:
   `network-build/tmp/p2t4-red-skeleton.log`.
3. Real bugs a test showed first, each fixed after that:
   - A target answering status `000` ended the process (`res.writeHead` threw in a `response` listener). Now answered `unreachable`.
   - `closes the target when the client closes before the 101`: aborted after 1 s. `sends nothing on for a client that closes
     while headers() waits`: `expected 1 to be +0`. A FIN before the 101 was not noticed; the client's `end` event now counts.
   - `goes on serving after an error on its listening socket`: the second emitted error was uncaught.
4. Tests written after the code, so not red first in the plain sense. Each was proved by spoiling the line by hand and restoring it:
   - `writes the 101 back...` and `writes back an answer other than 101...`, with `latin1` taken away: header byte differs.
   - `keeps no socket once it...`, with the destroy after flush taken away, on either path: `expected 1 to be +0`.
   - `serves 8080... exits 0 on SIGINT/SIGTERM`, with `server.close()` having no callback: `expected 5013 to be less than 3000`.
   - `gives a client that reads late all...`, with `client.destroy()` for the flush: `expected 352842 to be 360522`.
   - `takes a connectMs of 0 at its word`, with `||` for `??`, the mutator's survivor: `expected 5031 to be less than 3000`.
5. Failures that were mistakes in my tests, found by tracing, not fixed in the code: returning out of `for await` closed the raw
   socket; the `dns.lookup` stub also blocked `listen`; raw targets did not read their socket, so never saw it close; Node's
   `http.request` stops emitting `drain` once its response has ended (the counters showed the hop had read all that was written),
   so that test uses a raw socket.

## Mutator survivors and what happened to them

First run: 17 killed, 4 survived, all `?? -> ||`; a later run found the same at `net/front.ts:16`.
- `proxy.ts:85` `connectMs ?? CONNECT_MS`: a real difference at 0. Killed by the new test `takes a connectMs of 0 at its word`.
- `proxy.ts:44`, `:191`, `:195` and `front.ts:16`: the value is absent or a string, and no input could tell the mutant apart except
  an empty string, which should mean the same as absent. So the code now says `||`, and the mutator's `|| -> &&` on each is killed.
  No test was weakened and no behavior changed for any value but `host: ''`.
- By hand I also found `out.destroy()` after an unwritable answer was dead code (closing `res` already does it), and removed it.

## Rulings, for the ledger

- Ruling 1: hop-by-hop headers are also dropped from answers, though the plan says "from what came in" - why: a target always says `Connection: close` on this hop's per-request connection, and passing it would close the client's keep-alive on every answer - cost if wrong: small, a change to one filter call. A 101 stays exactly as it came.
- Ruling 2: a request's framing survives the drop: `transfer-encoding: chunked` when one came, and `content-length` even when `Connection` lists it - why: otherwise the body of a `DELETE` or `GET` goes out unframed and the target parses it as a second request with headers nobody here filtered, which breaks the Global Constraint on forged headers; tests `...and smuggles nothing` - cost if wrong: `Transfer-Encoding: gzip, chunked` loses its `gzip` label; no browser or agent sends it.
- Ruling 3: `headers()` throwing or rejecting, and a request `http.request` refuses to build, answer as `unreachable` - why: the plan is silent, and an unhandled rejection would end the process and every request with it - cost if wrong: small.
- Ruling 4: an answer this hop cannot write (status below 100) answers as `unreachable` - why: it ended the process, reproduced first - cost if wrong: small.
- Ruling 5: the target's socket gets its error handler in the `upgrade` event, not "as it is made" as the plan says - why: until that event `ClientRequest` holds its own handler and Node removes it in the same tick, so there is no gap, and a handler that destroys both earlier would cut the `unreachable` answer the plan requires for a reset before an answer; `outlives a target that resets while a socket is open` covers it - cost if wrong: small.
- Ruling 6: after a splice, a close on one side ends the other after flushing, then destroys it, not at once - why: the plan's "destroys both" at once loses what this hop still holds for a slow client, 7680 bytes in the test - cost if wrong: a client that has stopped reading keeps its socket until its own TCP goes; it could hold a socket as long by keeping a WebSocket open anyway.
- Ruling 7: before the 101, a client's `end` counts as leaving - why: this socket keeps its half open, so `close` never comes on a FIN - cost if wrong: a client that half-closes and still waits for a 101 is cut; none does. The rest of this ruling, on bytes ahead of a FIN, was wrong and leaked sockets: see Ruling 7, amended, in the fix report below.
- Ruling 8: `src/front.ts` on a stop signal closes the server and exits 0 when it has closed, or after 5 s - why: the plan says it closes and exits 0, but `server.close` never calls back while a WebSocket is open, and a running company always has one; 5 s fits inside Docker's default 10 s and lets a request in flight finish - cost if wrong: an upload longer than 5 s is cut at a stop, as it would be at any exit.
- Ruling 9, the lead's: `serve` sets `keepAliveTimeout` 72 000 ms and `headersTimeout` 60 000 ms, today's exact values, in place of Node's default 5 s keep-alive - why: the plan's rule is that a one-machine install works as today, and a client reusing a connection just as 5 s closes it gets a reset; the headers timeout may sit below the keep-alive, measured on Node 22.23.2 - cost if wrong: small, one constant. A first version had the headers timeout at 75 s on the belief that Node requires it above the keep-alive; the measurement below showed it does not, and the lead took it back.
- Ruling 10: `startFront` keeps its error listener after the start - why: a failed accept is emitted on the server, and an unhandled one ends the process - cost if wrong: such an error is silent, nothing logs it.

## Known limits, not changed

- An upgrade request carrying a body (an `h2c` upgrade on a POST): the plan's upgrade path sends no body, so the target waits until
  the client gives up. Browsers do not send this. Only that client is affected.
- Response trailers are not passed on, following the plan's drop of `trailer`.
- `Refusal.status` must be a code Node knows, or an upgrade's status line reads `undefined`. Only 502 and 503 are in use or planned.
- The tests assert the 72 s and 60 s as values and the hint clients read (`Keep-Alive: timeout=72`). They show a connection outliving
  5 s (6.5 s idle, a second request answered), and do not wait out a real 72 s or 60 s.

## Facts against the plan and the code

- A headers timeout below the keep-alive is safe here. Measured on Node 22.23.2: with `headersTimeout` 300 ms and `keepAliveTimeout`
  3000 ms, an idle connection was alive at 1500 ms and answered its next request, while an unfinished head was cut at 313 ms with a
  408 (`network-build/tmp/p2t4/headers-vs-keepalive.mjs`). Fastify today has the same pair: `keepAlive` 72000, `headers` 60000,
  `request` 0, read from a real instance. That is one measurement of one Node version; no test in the suite pins it.
- The plan's statement that `requestTimeout: 0` alone turns `headersTimeout` off on Node 22 holds: measured, `headersTimeout` is 0.

- Everything named in this task held: new files, no drift. I read plan 4 T7's and plan 5b's later `PassOptions` fields and saw nothing here that blocks them; that is a reading, nothing of them was built or tested.
- Brief note: `npm test -- --testTimeout=90000` does not reach vitest, as the lead said; `hh-suite.sh` does.
- The plan's test `names the visitor...` and all named tests keep the plan's exact names; `passes WebSockets both ways and closes
  them together` and `answers for a target that is down` (plan 4 cites it) are whole tests. `outlives a client that resets during an
  upgrade` is two tests with that name as a prefix, one per moment.

## Added beyond the plan's tests, since a dropped or doubled request is the worst thing this code can do

- Exactly once: 100 requests at once, each to its own client and seen once; pipelined requests in order; nothing sent again when a
  target fails a GET or a POST.
- Never whole by accident: an upload cut by the client never reaches the target as complete, by length or by chunks; an answer cut
  by the target (FIN or reset) is cut at the client too, never ended cleanly.
- Answers during uploads: an answer before the upload ends reaches the client, the rest is read off, and the next request on that
  socket works; a target resetting mid-upload gives 502.
- Backpressure both ways with 128 MiB: nothing is buffered while the other side does not read.
- The entry point is run for real in `front.test.ts`: a preload given as a `data:` URL makes it listen on a free port and go to the
  test's own target, while saying what it asked for (8080 on 0.0.0.0, `keeper` on 7080), so it touches nothing real on this machine.

## Log of actions

1. Read the brief, the rules, the skills, the parallel map, the code around the new files and how plans 4 and 5b extend `proxy.ts`.
2. Wrote both test files; saw them fail on the missing modules, then on a skeleton.
3. Wrote the code; 93 of 102 passed. Traced each of the 9 failures: one real bug (status `000`), one real gap I first misread as a limit (a FIN before the 101, see step 5), the rest my tests' mistakes.
4. Fixed lint and types in the tests (`no-misused-promises`, `Promise.withResolvers` is newer than the compile target).
5. Mutated by hand; found one piece of dead code, two weak tests and the wrong belief about FIN before the 101; fixed each.
6. Ran gates, mutator and suite on home-api; closed the survivors; ran them again; reran the local checks after the last edit.
7. On Ivan's ruling: checked no mutator of mine was running, then ran crapper, dryer and the whole suite once more on the final code.
8. On the lead's Ruling 9: measured the headers timeout against the keep-alive on this Node and read Fastify's real values; wrote the
   tests and saw them fail on 5 s (`expected '' to be 'HTTP/1.1 200 OK'`, `expected 'timeout=5' to be 'timeout=72'`, `expected 60000 to
   be 75000`); changed `serve`; ran tsc, `typecheck:tests`, lint, crapper, dryer and the whole suite on the result.
9. The measurement went to the lead, who took back the 75 s: test line to 60 000, saw it fail (`expected 75000 to be 60000`), set
   `HEADERS_MS` to 60 000, ran the focused tests, tsc and eslint.

Temporary files of mine are in `network-build/tmp/p2t4` and `network-build/tmp/p2t4-*.log`, safe to remove.

# Fix report, review round 1

Lane refreshed onto Task 11's commit by the lead. Fix list: `runs/p2t4-r1-merged.md`. Status: DONE. No whole suite (the lead runs it at
landing) and no mutator, by the lead's word. So neither has seen this fix round.

## Checks on the final code

| Check | Result |
|---|---|
| `light.sh npx vitest run test/proxy.test.ts test/front.test.ts --maxWorkers=2` | 2 files, 123 tests passed |
| `npx tsc -p apps/server/tsconfig.json --noEmit` | prints nothing, exit 0 |
| `npm run typecheck:tests`, `npm run lint` | exit 0 |
| `gates-hornhoof.sh lanebase server '...'` on home-api, `REMOTE_HORNHOOF_TREE=wt/p2t4` | exit 0; highest CRAP 3.0; dryer "No duplicate candidates found."; log `runs/remote-p2t4-r1-gates-20261104-212035-633797.log` |

Coverage note: `startFront` now reads 50%, CRAP 2.5, since the test that bound 0.0.0.0 is gone. Its default host is still tested, by
`serves 8080...` (`asked: { port: 8080, host: '0.0.0.0' }`), in a child process that coverage does not see. The other 22 functions read 100%.

## Finding 1, sockets leak during a handshake: root cause and fix

Reproduced first, with tests. The reviewer was right, and my Ruling 7 had two holes. Root cause: before the 101 nothing read the client's
socket, and that socket keeps its half open.
- A FIN with nothing unread: `end` fired and `gone()` turned true, and `pass` returned, but nothing ended this hop's half: CLOSE_WAIT.
- A FIN behind unread bytes: `end` never fired, so the client was not seen to have gone, and client and target stayed open.

Fix, `holdEarlyBytes` in `proxy.ts`, set up before anything is awaited: it reads the socket until the 101, keeps the bytes for the
target, and destroys the socket on `end`. `gone()` is now just `side.destroyed`. Failed first, for the right reason:
- `keeps no socket and sends nothing on for a client that closes behind nothing while headers() waits`: `expected 1 to be +0` (one socket held).
- `... closes behind bytes ...`: `expected 1 to be +0`.
- `keeps no socket when a client that sent bytes closes before the 101`: `AbortError` (target not closed in 1 s).
- `cuts a client that sends more than it holds before the 101...`: `AbortError`.

The `resets` rows of those tables passed before the fix too: a reset was already seen.

## Finding 2, the two-hop test could not see buffering

`front.test.ts` has a new `through front and the next hop` block, split from the one test. Each test was written against code that already
passed, so each was proved by spoiling that behavior and restoring it:
- `gives an event stream as it comes...`, a hop buffering to the end: `expected 'data: 1\n\ndata: 2\n\n' to be 'data: 1\n\n'`.
- `cuts an event stream at the client when the app dies...`, `up.pipe(res)` for the pipeline: `AbortError`, no cut.
- `keeps a quiet WebSocket open, and closes it whichever end closes`, closes not passed across a splice: `AbortError`.
- `closes a request at the app when the client closes before any answer`, `abandon` not attached: `AbortError`.
- `closes an event stream at the app when the client closes it`: that same spoil did NOT fail it, since after the answer begins the
  pipeline carries the close, which is why the test above it exists. With the pipeline spoiled as well, it fails: `AbortError`.

## Minors

- `limitConnect` clears on `close` too. `leaves no timer behind a connect that failed...` failed first: the child process was still alive at
  10 s and was killed.
- A client abort no longer asks for a refusal: `abandon` detaches `fail` before destroying `out`, and `detach` runs on `out`'s `close`, also
  after a 101. `does not ask for an answer to a client that left...` failed first, both paths: `expected 1 to be +0`. The misleading comment
  is gone. Detaching after a 101 has no behavior to fail on; a one-off read of the socket's listeners after a 101 showed only the pipe's and
  the splice's (`network-build/tmp/p2t4/listeners-after-101.mts`).
- `headers()` failing closes the connection, with `Connection: close`. `closes the connection when headers() fails on a request with a body...`
  failed first: `AbortError`. I did not test whether the unread bytes could be taken for a request; the connection closes either way.
- The test that bound 0.0.0.0 is gone.

## Other tests, not red first

- `outlives headers() failing for a client that has already left` passed before the fix, and was red once only as fallout of the test before
  it. A separate script showed nothing escaping. It is a pin.
- `carries what a client sent before the 101...`, rewritten: bytes spoil `expected '-late' to be 'ahead-early-late'`.
- `lets a client close its half after the 101...`: stale `end` listener spoil, last words lost.
- `carries exactly as much as it holds before the 101`: `>=` for `>` spoil, test timed out.

## Rulings, for the ledger

- Ruling 7, amended: before the 101, a client's `end` destroys its socket and that ends the target's side too, whatever came before the FIN - why: anything less leaks, reproduced - cost if wrong: a client that half-closes and still waits for a 101 is cut; none does.
- Ruling 11: after its request and before the 101, a client may send 64 KiB, held in memory for the target; past that it is cut, with the target. `head`, the bytes Node hands over with the request itself, is held too and is not counted in the limit. The limit ends at the 101 - why: reading is the only way to see a close behind bytes, and pausing at a limit would hide the close again, while with no limit a flood during `connectMs` fills memory; a WebSocket client sends nothing until the 101 - cost if wrong: another upgrade protocol sending more than that early is cut. Each connection can hold `head`, up to 64 KiB, and the read that went past it, for as long as the target takes to answer.
- Ruling 12: only `headers()` failing or a request that cannot be built closes the connection; a target failing does not - why: there the rest of an upload is read off, so the client can read its 502 and go on (test `answers 502 to an upload the target resets partway...`), and closing there could reset the client before it reads the answer - cost if wrong: small, one call.

## Known limits, not changed

- A close behind unread bytes stays unseen whenever backpressure has stopped this hop reading: after a 101 or during an upload, if the target
  has stopped reading, a client that closes is noticed only when the target reads again or closes. Seeing it would need unbounded
  buffering. Both sockets stay open meanwhile. Unlike Finding 1, this needs a target that stops reading.
- The other minors the lead deferred are not done, among them the fixed `sleep(200)` in `takes no new request once it was told to stop`, and
  `container()` hanging to the test timeout if the child dies at start.

## Re-review, one test

The re-review found deleting `client.off('data', hold)` passed all 123 tests, while a live WebSocket would be cut after 64 KiB. New test
`stops counting at the 101, so a live socket carries more than it holds before it and stays open`, written against code that already
passed, so proved by spoiling that line in place and restoring it: `expected 131072 to be 262144`. After that, `test/proxy.test.ts` through `light.sh` 109 passed, tsc and lint exit 0; `test/front.test.ts` was not rerun, nothing it uses changed. Ruling 11's wording corrected: `head` is not
counted, as the code has it; the code did not change.
