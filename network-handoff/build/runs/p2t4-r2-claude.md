# Plan 2 Task 4, review round 2 (Claude, read only)

Package: `network-build/runs/p2t4-r2.diff`, lane `wt/p2t4`. Nothing in the lane changed: `git status --short` shows the same four untracked paths before and after.
My temporary files are in `network-build/tmp/p2t4-r2-claude/`, safe to remove. It holds a copy of the five files, spoiled one change at a time, and my probes. The copy was byte-identical to the lane's `proxy.ts` after the spoils (`cmp`).

## Result

| Round 1 finding | Verdict | Test fails without the fix? |
|---|---|---|
| Important 1, sockets leak during a handshake | ADDRESSED | Yes |
| Important 2, two-hop test cannot see buffering | ADDRESSED | Yes |
| Minor, `limitConnect` timer | ADDRESSED | Yes |
| Minor, a client abort asks for a refusal; detach once upgraded | ADDRESSED | Yes, for the refusal. Detaching after a 101 has no behavior to test, so I read the listeners instead |
| Minor, `headers()` rejects on a request with a body | ADDRESSED | Yes |
| Minor, the test that bound 0.0.0.0 | ADDRESSED | Not applicable |

New: Critical 0, Important 1 (a test gap, the code is right), Minor 1.

## New findings

### Important: no test sees the early limit stop at the 101

`apps/server/src/net/proxy.ts:177`, `client.off('data', hold)`. Delete this line and all 123 tests still pass (proxy 108, front 15).

What a person would get with that line wrong: every WebSocket is cut once the client has sent 64 KiB in total after the 101, and the bytes are also kept in memory until then.

Checked by `probes/past101.mts`, one hop, real `ws` client and server, 16 KiB messages:
- The code as it is: the app received 262144 of 262144 bytes, and the client was not cut.
- With the line deleted: the app received 65536 bytes, and the client was cut.

The code is right today, so this is not breakage. It counts as Important by the brief's own words, a test that would pass with the code wrong, and it guards the worst way this fix could go wrong.

What would make it right: one test that sends more than `EARLY_LIMIT` after the 101, asserts it all arrives, and asserts the socket stays open.

### Minor: `head` does not count towards the limit

`apps/server/src/net/proxy.ts:166-167`. `size` starts at 0, so what came in the request's own read is not counted.

Measured with `probes/small.mts`: 120 KiB before the 101, 60 KiB of it in that first read, was not cut, and all of it reached the target. A connection can therefore hold about 64 KiB plus two reads, where Ruling 11 says plus one. No person notices this. Either correct the ruling's words or start `size` at `head.length`.

## The three questions

### Does a tab that closes during a handshake still leave a socket open? No.

`probes/handshake.mts`, 8640 handshakes in two runs:
- Hops: one and two.
- Targets: `ws` with a delayed `verifyClient`, a raw late 101, a refusal, a silent target, a target that is down.
- Clients: FIN, RST, half-close, at random moments, behind no bytes, some bytes, or more than the limit.
- `headers()`: at once, or after a random wait, on every hop.

After every mix, every hop and target read `getConnections() === 0`, and nothing escaped as uncaught. 1295 of the clients got a 101 before they left, so the moments on both sides of the 101 are covered.

Separately, also with no socket left and nothing uncaught:
- `headers()` failing on an upgrade whose client has gone.
- A client that goes during a DNS lookup that never answers.

Limits of this evidence: loopback and Node clients with a real WebSocket handshake, no real browser. A machine that vanishes sends neither FIN nor RST, which is another matter and I did not test it.

### Can an ordinary browser reach 64 KiB before the 101? No.

- It sends nothing at all until the 101: RFC 6455 section 4.1 requires the client to wait, and the browser's `WebSocket.send` throws while connecting.
- Hornhoof's own client also checks first: `apps/web/src/ui/AgentTerminal.tsx:95` sends only at `readyState === 1`.
- `probes/browserearly.mts` with the `ws` client: `send` while connecting throws, the head is 0 bytes, and 0 bytes were read past it in 600 ms.
- `fetch` cannot set `Upgrade`.

Only a non-browser client that sends a body with an upgrade can reach the limit, which is the cost Ruling 11 already states.

### Does the known limit hold a socket forever? Only until the app reads or closes.

`probes/limit.mts`: the app stops reading, the client floods until nothing drains for 1.5 s, then the client goes. In every row the visitor's socket was still held 3 s later, so the limit is real.

| What the app then does | One hop | Two hops |
|---|---|---|
| Socket: reads again | Free in 25 to 52 ms | Free in 27 to 87 ms |
| Socket: closes | Free in 25 ms | Free in 25 to 26 ms |
| Socket: writes every 200 ms, never reads | Visitor's socket free in 209 to 408 ms, the app's stays | Front's socket free; next hop and app keep one each, still so at 6 s |
| Upload: reads again, closes, or answers without reading | Free in 25 to 26 ms | Not run |

Each row ran with the client closing and with it resetting. The results did not differ beyond the times shown.

If the app does none of these, nothing here ends the hold, by reading the code rather than by measuring: there is no timer, and `proxy.ts:251` sets `requestTimeout: 0`. So it lasts as long as the app is hung, and restarting the app frees it, as in the "closes" row.

How likely this is in the real app:
- `apps/server/src` outside `net/` has no `.pause(` call.
- `ws` pauses its socket only when its receiver is backed up (`node_modules/ws/lib/websocket.js:1387-1391`), which in practice means while the app's event loop is busy.

I did not check how each upload route reads its body. The writer's description of this limit is accurate. Not a finding.

## How each finding was checked

### Important 1

Spoils on the copy, with the tests in `before the 101` and `while headers`:
- No reading at all (`data` and `end` listeners gone): 6 fail. Among them `keeps no socket and sends nothing on ... closes behind nothing` and `... behind bytes` with `expected 1 to be +0`, and `keeps no socket when a client that sent bytes closes before the 101` with `AbortError`. These match the failures the report names. The `resets` rows pass, also as the report says.
- No `end` handling only: 5 fail.
- No cut past the limit: `cuts a client...` fails.
- `>=` for `>`: `carries exactly...` times out.
- No `side.destroyed` check: the 4 rows of the `while headers() waits` table fail.
- `abandon` not attached: 6 fail.
- `end` listener left on after the 101: `lets a client close its half...` fails.

The tests assert `getConnections()` reaching 0 through `holdsNoSocket`, in both cases the finding names, as the brief asked.

I saw these tests fail by spoiling the finished code. I did not see the writer's original red runs, but my failures match the report's.

### Important 2

Spoils, with `through front` in `front.test.ts`:
- A hop that buffers to the end: `gives an event stream as it comes...` fails with `expected 'data: 1\n\ndata: 2\n\n' to be 'data: 1\n\n'`, and two other tests time out.
- `up.pipe(res)` for the pipeline: `cuts an event stream...` fails.
- `abandon` not attached: `closes a request at the app...` fails. With the pipeline spoiled as well, `closes an event stream at the app...` also fails, as the report says.
- No close passed across the splice at all (close listeners gone and pipes with `end: false`): `keeps a quiet WebSocket open...` fails.

One nuance, not a finding: removing only the splice's close listeners passes `front.test.ts`, because that test closes with a close frame and the pipe's end carries it. Two single-hop tests catch that spoil (`outlives a client that resets..., right after the 101` and `outlives a target that resets...`). So an abrupt close is covered on one hop only, and it is the same code on the second hop.

### Minors

- `limitConnect`: without `out.once('close', stop)`, `leaves no timer...` fails with `Command failed`: the child process, which has a 10 s limit, does not end by itself.
- Client abort: without `detach()` in `abandon`, both `does not ask for an answer...` tests fail with `expected 1 to be +0`. `probes/last.mts` read the listeners after a 101: `close` has the splice's and the pipe's, `end` has Node's and the pipe's, `data` has the pipe's. No `abandon`, `hold` or `leave` remains. The misleading comment is gone.
- `headers()` rejecting: without `closing()`, `closes the connection when headers() fails...` fails with `AbortError`.
- 0.0.0.0: the test is gone. The only `0.0.0.0` left is `front.test.ts:291`, the address asked for, and the preload there binds `127.0.0.1`.

## What ran

- `light.sh npx vitest run test/proxy.test.ts test/front.test.ts --maxWorkers=2` in the lane: 2 files, 123 tests passed, as the report says.
- All spoils and probes on the copy, through `light.sh`, one at a time.
- One of my probes hung through my own mistake: it replaced `dns.lookup` before `listen`, which also looks up. I stopped that one process and fixed the order. It says nothing about the code.
- No em dash and no Cyrillic yo in the five files. No secret value in anything I read or ran.
- Not run: the full suite, the gates and the mutator, which are the lead's. `runs/p2t4-r1-gates.log` names `holdEarlyBytes` and `closing`, highest CRAP 3.0, no duplicate pair. All five files carry the mtime 16:24:23, later than that log at 16:21. I did not establish why, so the lead's landing run is the one to trust. The mutator's run on this plan should show `proxy.ts:177` as a survivor until the test above exists.
