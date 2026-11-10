# Plan 2 Task 4, review round 1 (Claude, read only)

Package: `network-build/runs/p2t4-r1.diff` against `lanebase` in `wt/p2t4`. Files: `apps/server/src/net/proxy.ts`,
`apps/server/src/net/front.ts`, `apps/server/src/front.ts`, `apps/server/test/proxy.test.ts`, `apps/server/test/front.test.ts`.
Nothing staged or committed in the lane; no other file changed. Nothing was changed by this review.

## What I ran

- `light.sh npx vitest run test/proxy.test.ts test/front.test.ts --maxWorkers=2` from `apps/server`: 2 files, 107 tests passed, 35.6 s.
- `npx tsc -p apps/server/tsconfig.json --noEmit` from the lane root: prints nothing, exit 0.
- Two scripts of my own in `network-build/tmp/p2t4-r1-claude/` (safe to remove), see Ruling 6 below.
- Grep of the diff for em dashes and "ё": none. No key, token, address or hostname outside the documentation ranges and `hornhoof.test`.

## Counts

Critical: 0. Important: 0. Minor: 6.

## What I looked hardest at, and found sound

- Dropped or doubled request: `agent: false` on every hop (`proxy.ts:88`), no retry anywhere, `res 'close'` destroys the target request
  (`proxy.ts:119`), a target that dies before answering gives exactly one 502 (`openTarget`, `fail` is `once`). Tests `carries many
  requests at once...`, `never sends a %s again...`, `answers pipelined requests in order` pin it.
- A stream or socket held or cut: `requestTimeout: 0`, no timer after connect (`limitConnect` clears on `connect`), `pipeline(up, res)`
  and `req.pipe(out)` carry backpressure both ways. The 128 MiB tests show memory does not grow with a long upload or a slow client.
- Connections left open: both sides of a request close each other (`proxy.ts:116,119`); after a splice each close ends the other and
  then destroys it (`spliceSockets`); a client that leaves while `headers()` waits sends nothing on (`gone()`); an upgrade that is
  refused or unreachable keeps no socket (test `keeps no socket once it...`). One nit on the connect timer, Minor 4 below.
- Address and headers on the way through: `x-forwarded-for`, `x-forwarded-proto` and `x-hornhoof-*` are dropped whatever their case
  and count, `host` and `x-forwarded-host` pass as they came, `front` writes the socket's address and nothing else
  (`front.ts:9`, `names the visitor by the socket and nothing else`). `auth/tunnel.ts:22,29` and `auth/origin.ts:19` read only those
  names, so nothing a visitor or the node forges reaches the app.
- The app restarting behind it is the keeper's task; what this hop does when the next hop is down is the 502 with `Retry-After: 5`
  at once on refusal and after `connectMs` on silence, for requests and upgrades alike.
- Ruling 9 stands as the lead gave it: `serve` sets 72 000 and 60 000 (`proxy.ts:30,32,211`), and the test asserts both values and the
  `Keep-Alive: timeout=72` hint a client reads, plus a 6.5 s idle reuse that Node's default 5 s would have reset.
- Uncaught errors: `failOnUncaught` guards the eight tests where a reset or an odd answer could escape; `socket.on('error', ignore)` is
  on the client's socket before anything is awaited (`proxy.ts:188`) as the plan asks.

## The writer's rulings, judged

- Ruling 1 (hop-by-hop dropped from answers too): right and necessary. The target always answers `Connection: close` on this per-request
  connection; passing it would close every visitor's keep-alive after each answer. The 101 is written as it came. Test
  `keeps the hop-by-hop headers of an answer from the client` pins it with `connections === 1`.
- Ruling 2 (framing survives the drop): right. Without it a chunked DELETE body would arrive at the target as a second request with
  headers nobody filtered, which breaks the Global Constraint on forged headers. Both smuggling tests pin it.
- Rulings 3, 4 (headers() failing, an unwritable answer, both answered as unreachable): right; both reproduced by tests with
  `failOnUncaught`.
- Ruling 5 (target socket error handler at the `upgrade` event): right. Until that event `ClientRequest` owns the socket's errors and
  turns them into the 502 the plan requires; Node removes its handler and emits `upgrade` in the same tick, and `spliceSockets` adds
  `ignore` inside that tick.
- Ruling 6 (close one side: flush the other, then destroy): holds in both directions, which I checked, because I first doubted it.
  `carry` leaves `client.once('end'|'close', leave)` with `leave = () => out.destroy()` in place after the splice, which looked like an
  at-once destroy of the target on a client FIN. It is not: Node marks the `ClientRequest` destroyed right after the `upgrade` event
  returns, so `out.destroy()` is then a no-op (`tmp/p2t4-r1-claude/destroyed-after-upgrade2.mjs`: `out.destroyed = true`, target
  not destroyed). With 8 MiB sent and a target or client reading 64 KiB every 20 ms, every byte arrived both ways
  (`tmp/p2t4-r1-claude/client-fin-after-splice.mts`). Its stated cost (a client that stopped reading keeps its socket) is real and
  acceptable, as the writer says.
- Ruling 7 (a client's `end` before the 101 counts as leaving): right; the server's sockets allow half-open, so `close` never comes
  on a FIN. Bytes ahead of the FIN keep `end` from firing until the target reads them; test `carries what a client sent before the
  101` pins it.
- Ruling 8 (exit 0 when closed or after 5 s): right. `server.close` never calls back while a WebSocket is open, and a running company
  always has one; 5 s sits inside Docker's 10 s. Tests pin both the early exit and the 5 s one.
- Ruling 10 (the error listener stays): right; a failed accept would otherwise end the process.

## Findings

### Minor

1. `apps/server/src/net/proxy.ts:159-162` and `:163-168`. After the 101 the `leave` listeners on the client socket stay registered and
   do nothing, since `out` is already destroyed; the comment above them says only what they do before the 101. A reader will believe,
   as I did, that a client FIN after the splice destroys the target at once. What a person gets: nothing wrong today. What would make
   it right: take the two listeners off in the `upgrade` handler (`client.off('end', leave); client.off('close', leave)`), or one
   sentence in the comment saying they are spent once the sockets are spliced.

2. `apps/server/src/net/proxy.ts:80-83`. `limitConnect` clears its timer only on `connect`. When the target refuses at once
   (ECONNREFUSED, ENOTFOUND, the usual case while the keeper is down), the timer and its closure over `out` live for the full
   `connectMs` after the 502 went out. What a person gets: nothing visible; under a burst of requests at a down keeper, a few
   thousand pending timers for 5 s, each small, then gone. What would make it right: clear it on `out`'s `close` as well.

3. `apps/server/test/front.test.ts:94-98`, `listens on every address unless told otherwise`. The test binds `0.0.0.0` on an ephemeral
   port for a moment on this machine, where the Global Constraints say tests use `127.0.0.1`. The default itself is also pinned by the
   container test (`asked: { port: 8080, host: '0.0.0.0' }`), where the preload turns it into `127.0.0.1`. What would make it right:
   drop this test, or check the default through the same preload trick without binding.

4. TDD. The report says five tests were written after the code (the latin1 head, the flush-then-destroy pair, the `server.close`
   callback, the late reader, `connectMs: 0`) and proved by spoiling a line and restoring it. That is honest, and each spoil is named
   with its failure, but it is not the failing test first that the rules ask for. Nothing to change in the code; a note for the
   ledger.

5. Duplicated test helpers. `front.test.ts:14-65` repeats `deferred`, `listening`, `answering`, `send` from `proxy.test.ts:29-80`
   nearly line for line (dryer did not flag them at 0.8). The writer stayed inside the task's two files and off `test/helpers.ts`,
   which many lanes touch; that is defensible for this round. What would make it right: when the plan's lanes on `test/helpers.ts`
   have landed, one shared file for these helpers.

6. `apps/server/src/front.ts` writes nothing to its log, not even that it listens; `main.ts:23` prints one line at start. An operator
   reading `docker logs` of the `front` container sees nothing, and an `error` after the start (Ruling 10) is silent. The plan does not
   ask for a line, so this is a suggestion: one line at start and one on a server `error`.

### Known limits, agreed

The writer's list holds and none costs a person today: an upgrade with a body, response trailers, a `Refusal.status` Node does not
know, and `Transfer-Encoding: gzip, chunked` losing its `gzip` label. Timing asserts (`toBeLessThan(3000)`, `>= 4500`, `>= 150`) are
wide enough for `--maxWorkers=2` on this machine; they passed here in 35.6 s with the company running.

## Facts checked against the report

- 107 tests, 2 files, as reported. `tsx`, `ws` and `@types/ws` are devDependencies already; no dependency added.
- Node here is 22.23.2, the version the writer measured on; the `requestTimeout: 0` and `headersTimeout` facts are consistent with what
  the test asserts (`server.headersTimeout === 60_000`, `requestTimeout === 0`).
- Crapper: highest CRAP 3.0, all 21 functions at 100% coverage (`runs/p2t4-gates.log`). Dryer: no pair at 0.8. The gates saw the
  code with `HEADERS_MS` at 75 000; the only change since is that constant and one test line, both of which the focused run covers.
