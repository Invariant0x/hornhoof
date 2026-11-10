# Plan 1 Task 12, review round 2 (Claude, scoped re-review)

Package: `network-build/runs/p1t12-r2.diff` in lane `wt/p1t12`. Read only; nothing in either repository changed.

Runs (lane, through light.sh): `vitest run test/relay-client.test.ts test/link.test.ts`: 2 files, 44 tests pass, no
unhandled errors. `tsc -p apps/server/tsconfig.json --noEmit` rc 0; `tsc -p apps/server/tsconfig.eslint.json --noEmit`
rc 0. No em dash and no `console.` in the two changed files.

## Findings from round 1

1. Generated keys printed on failure. ADDRESSED. `relay-client.test.ts:334-338`: the fresh key and the visitor key are
   compared with `===` and `toBe(true)` with a fixed message, so a failing assert prints only `false`. `:337` asserts
   `route` with the fresh key reads `known: true`. `:405` keeps the whole-file key check as one boolean. A failure
   anywhere in this file prints no key.

2. `setSync` timeout untested. ADDRESSED. `:233-238`: `oneAnswer(..., 1000)`, `timeoutMs` 100, `{stored: false, why:
   'unknown'}` under 250 ms. Bites without the fix: with the budget ignored the answer would come after 1 s, over the
   250 ms bound; `attempt` passes `timeoutMs` into `AbortSignal.timeout` (`relay.ts:91`).

3. Test that does not test what it says. ADDRESSED. `does not take a stored record that differs` is gone from the file;
   the three `oneAnswer` tests at `:248-270` cover a differing field, a non-record 200 and a 409 with an unknown word.

4. Stalled or broken body reads as `malformed`. ADDRESSED. `relay.ts:92-96`: `await res.clone().text()` inside the
   try, so the body read is under the same `AbortSignal.timeout` as the headers; a `TimeoutError` is `slow`, anything
   else `unreachable`. Reproduced independently (script in `network-build/tmp/p1t12-r2-claude/body.mjs`, a server that
   writes `{"state":` and then stalls or destroys the socket, 200 ms budget): old way (headers only in the try) gives
   `malformed` in 203 ms (stall) and 23 ms (cut); new way gives `slow` in 201 ms and `unreachable` in 21 ms. So the test
   at `:274-278` really fails without the fix, and the body reader does not hang past the budget: undici errors the
   body stream when the signal fires. `check`, `bind`, `unbind` now also read the body inside `WAIT_MS`; `link.test.ts`
   passes with that.

5. Route fields unpinned, `since` seam. ADDRESSED. `:284-286` pins the full answer with `toEqual`; `:288-297` reads
   eleven spoiled values as `malformed`, among them `since: null`; `:299-302` a never-registered binding reads `known:
   true, state: 'empty', generation: 0`. Type stays `Count` (`relay.ts:31`), so making it nullable would let the
   `since: null` case through and the test would fail.
   relay.py check: `routes.since` is `INTEGER NOT NULL` (`relay.py:123`), `bindings.created_at` is `INTEGER NOT NULL`
   (`:108`). `route_body` (`:469-481`) gives `since = None` only when there is no routes row and no bindings row. The
   route call runs `authorize_link` first (`:1221-1225`), which answers 404 when the bindings row is missing, so `null`
   reaches the client only if the binding is deleted (`:946`, `:955`, `:966`) between that check and `route_body`. In
   that race the client reads `malformed`, which is fail closed. The writer's claim holds. One seam fact for the ledger,
   not a finding: for a binding nobody registered yet the real relay gives `since = created_at`, the fake gives 0;
   both are numbers and the test at `:299` does not pin `since`.

6. Key calls' failure paths. ADDRESSED. `:357-363` 429 is `[429, 'too_many']` for both calls (bites: `relay.ts:145`
   is the only line that makes `busy()`); `:365-371` 401, 404, 500 keep `relay_unreachable`; `:373-381` visitor key
   `{}`, short, number, wrong field and a short link key answer refuse. `:385-406` the no-key test adds a hung read
   (`:400-401`), a closed port for `route`, `setSync`, `changeKey` (`:402-403`) and a `changeKey` success (`:404`).

## New breakage in what the fix changed

Critical: none. Important: none.

Minor: `relay-client.test.ts:237` and `:208` bound a timeout at 250 ms and 400 ms on a machine that runs a company;
under load they may flake. The `oneAnswer` server at `:414` keeps its 1 s timer after the client gave up and writes to a
closed response; harmless today (no unhandled error in the run), but `server.close()` in `onTestFinished` does not
cancel the timer.
