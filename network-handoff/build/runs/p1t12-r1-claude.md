# Plan 1 Task 12, review round 1 (Claude reviewer, read only)

Change reviewed: `network-build/runs/p1t12-r1.diff` in lane `wt/p1t12` (`apps/server/src/modules/link/relay.ts`,
`apps/server/test/relay-client.test.ts`). Compared with the task's Interfaces, the Global Constraints (fail closed, no
key in a result, error or log), the fake relay of Task 11 and the real `hornhoof-edge/relay/relay.py` at its current
commit, status by status and field by field.

What I ran: `light.sh npx vitest run test/relay-client.test.ts` in the lane: 1 file, 15 tests pass, 6.45 s. A node
script (`network-build/tmp/p1t12-claude/body-hang.mjs`) that answers 200 headers and never finishes the body: under
`AbortSignal.timeout(200)` the body read rejects with `TimeoutError` after 208 ms, so `route` ends as `malformed`, it
does not hang. The lead's suite log (p1t12-suite2) ends green; the gates log shows every added or changed function
under CRAP 10 (highest 6.0), dryer clean, and 32 mutants killed, 0 survived in relay.ts.

## Counts

Critical: 0. Important: 1. Minor: 5.

## Critical

None found.

## Important

1. `apps/server/test/relay-client.test.ts:300` and `:303` (also `:301`): `expect(fresh).toBe(fake.bindings.get('acme')?.key)`
   and `expect(await relay.visitorKey('acme', fresh)).toBe(fake.visitorKeys.get('acme'))` compare a generated link
   key and a generated visitor key by value. When such an assert fails, vitest prints both values, so a generated key
   lands in the test output and in any report that copies it. CLAUDE.md: "tests compare it with booleans and fixed
   messages"; the sibling `fake-relay.test.ts:178` keeps that rule (`expect(fresh.length >= 16 && fresh !== 'k').toBe(true)`).
   What a person gets: nothing today, these are the fake's throwaway keys and they print only on a failing run; it is
   a rule break, not an exposure. Right: compare with booleans, for example
   `expect(fresh === fake.bindings.get('acme')?.key && fresh !== key).toBe(true)`, and the same for the visitor key.
   Checked by reading the lines; a `toBe` mismatch message always carries both operands.

## Minor

1. `relay.ts:138-143` `secretFrom`: a 401 (wrong key) or 404 (no binding) on `changeKey` or `visitorKey` throws
   `relay_unreachable`, "hornhoof.org does not answer now. Try again in a few minutes.", which is not what happened.
   The plan says "throws ApiError as bind does" and names no other reason, and plan 9's ruling 20 treats every non-200
   end of `changeKey` alike, so this is within the brief; the writer ruled on it. Cost: a person whose key the relay
   refuses is told the relay is down. Worth one ledger line; a `link_refused` reason would be the better word later.

2. `relay-client.test.ts:231-268`: the three tests added after the mutator run (a stored record that differs in one
   field, a 200 that is not a sync record, a 409 with an unknown word or no body) were not seen failing first; the
   writer says so and offers the mutator's kills (6 survivors to 0) as the proof they bite. That proof holds for the
   mutants it names, but the rule is red first. Noted, not blocking.

3. `relay-client.test.ts:224` `expect(route.known && route.sync).toEqual(result.stored && result.sync)`: both sides are
   `false` when both reads fail, and then the assert passes. It is saved only by line 222, which pins `stored: true`
   first. Clearer: narrow with `if (!route.known || !result.stored) throw ...` or assert `route.known` on its own line.

4. `relay.ts:106` a timeout that lands during the body read, after the headers came, reads `malformed`, not `slow`
   (reproduced with the node script above, 208 ms). Fail closed either way, label only; the writer's ruling says the
   same. A caller that tells `slow` from `malformed` would mislabel this one case.

5. `relay.ts:105` any non-200 on `route` is `refused`, including the relay's 503 `unknown`, 503 `busy` and 429
   `rate_limited`, so "the relay cannot tell" and "wrong key" read the same word. This is exactly what the Interfaces
   say ("A non-200 is `refused`"), so no gap; but plan 10's takeover logic should know that `refused` covers a relay
   that cannot tell, not only a wrong key. For the ledger.

## Checked and found right

- Real relay vs fake. `relay.py` answers 404 `not_found` where the fake answers 404 `unknown`: the client reads the
  status only on `route` (`relay.ts:105`, any non-200 is `refused`) and maps every non-409 failure of `setSync` to
  `unknown` (`relay.ts:114-115`), so the word in a 404 body never reaches a result. The real 409 body is
  `{'error': conflict}` with `not_holder` or `stale_epoch` (`relay.py:1221`), as the fake's; `conflictOf` reads
  exactly those two and nothing else.
- Route fields against `relay.py:458-480`: `state` held or empty (`pending` rows read held), `client` str or None,
  `since` an integer from `now()` or `bindings.created_at` (both `INTEGER NOT NULL`), `generation` int,
  `relayStarted` int (`relay_started`, `relay.py:233`), `evictionBound` 30, `sync` with `at` int or None and `copy`
  str or None. Every one passes `RouteBody`; a wrong type in any of them is `malformed`, never `empty`.
- Health against `relay.py:1242-1246`: the real 200 has no `passthrough` yet and reads `passthrough: false`; a 503
  `{ok: false, frps: false}` reads `DOWN`. A `passthrough` of the wrong type reads down, fail closed.
- `setSync` is `stored: true` only for a 200 whose `sync` echoes `state`, `copy`, `epoch` and `generation`
  (`relay.ts:73-75, 117`); the real relay's stored record takes `generation` from the routes row after the holder
  check (`relay.py:504-520`), so a stored record always echoes. 415, 400, 401, 404, 503 all read `unknown`.
- The key goes only into the `authorization` header (`relay.ts:86`); `attempt` reads only `error.name`
  (`relay.ts:91`); every thrown error has a fixed message; no log line in the file. The "never puts the key" test
  compares with one boolean (`relay-client.test.ts:333`).
- `check`, `bind`, `unbind` unchanged in behavior: `call` keeps `WAIT_MS` and throws `unreachable` as before.
- No em dash, no Russian, no new dependency, no doc changed. Nothing reaches hornhoof.org: the tests use the fake on
  127.0.0.1, a one-answer server on 127.0.0.1 and port 1 for "unreachable".
- Lane state: `relay.ts` modified, `relay-client.test.ts` untracked, nothing staged or committed, as the rules want.
