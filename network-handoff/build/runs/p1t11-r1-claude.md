# Review of Plan 1 Task 11, round 1 (Claude, read only)

Change: `/home/altera/hornhoof-network/network-build/runs/p1t11-r1.diff`, the uncommitted tree of
`/home/altera/hornhoof-network/hornhoof` on `network` against 73d086ba. I checked that the package equals
`git diff 73d086ba -- apps/server/test/fake-relay.ts` (same content, only the context width differs) and that
`fake-relay.test.ts` is the untracked file in the tree. Compared against the contract table in the brief and against
`hornhoof-edge/relay/relay.py` (`authorize_link`, `route_answer`, `route_body`, `sync_answer`, `set_sync`,
`valid_sync_body`, `key_answer`, `health_answer`, `name_answer`, `create_binding`, `do_DELETE`, `check_name`,
`requested_name_reason`).

What I ran (through `light.sh`, one at a time):
- `npx vitest run test/fake-relay.test.ts` from `apps/server`: 1 file, 20 tests passed.
- `npx tsc -p apps/server/tsconfig.json --noEmit` from the repo root: no output, exit 0.
- Read `network-build/runs/p1t11-gates2.log`: crapper highest 9.0 (`POST /api/v1/bindings`, `nameRules`), none at 10;
  dryer 0.8 "No duplicate candidates found". Mutator is not asked for in this review; the log shows 50 killed, 5
  survived (all `??` to `||` on operands that are never 0, '' or false, which I agree are equivalent).
- No em dash in either changed file (grep for U+2014 and U+2013 found nothing).

## Counts

Critical: 0. Important: 2. Minor: 9.

## Important

### I1. The fake's 404 body says `unknown`; the relay says `not_found`, and `unknown` is the relay's 503 word

`apps/server/test/fake-relay.ts:159` (the shared `authorize` hook, used by DELETE, route, sync, key and
visitor-key) answers 404 `{ error: 'unknown' }`. relay.py answers 404 `{'error': 'not_found', 'message': ...}`
(`authorize_link`, relay.py:1187; `do_DELETE`, relay.py:1350; also `key_answer`, relay.py:1238), and the relay's own
tests pin it (`hornhoof-edge/relay/test/test_route.py:181`, `test_sync.py:187`:
`assertEqual(body['error'], 'not_found')`). In relay.py the code `unknown` means one thing only: 503, "the relay
cannot tell whether the route is live" (relay.py:1121, 1202, 1219), and the fake uses the same `UNKNOWN` body for its
503s. So from the fake, a 404 and a 503 carry the same error code.

What a person would get: plan 1b's `Relay.route`, `setSync`, `changeKey` and `visitorKey` are written and tested
against this fake. A client that reads `body.error === 'unknown'` as "relay cannot tell" (the fail-closed branch) is
green against the fake and takes a real 404 (`not_found`) down a different branch; a client that looks for
`not_found` to mean "the binding is gone" can never pass against the fake. Today's `relay.ts` branches on status only,
so nothing breaks at this commit, but the row says "404 unknown name" as a status, not a code, and the brief says
relay.py is the source where the table is silent.

Make it right: `reply.code(404).send({ error: 'not_found', message: \`There is no binding ${name}.\` })`, and a test
line in `R2.3` and in the 404 cases of R2.4/R6.2 asserting the body code. The old DELETE answered `unknown` before
this change, so `link.test.ts` should be checked for a dependence on it (I found none: no test in link, setup or
orchestrator-control asserts that body).

How I checked: read relay.py lines 1183 to 1193 and 1343 to 1359; grep of the relay tests for `not_found`.

### I2. The R6.2 test compares generated visitor keys by value, so a failure prints them

`apps/server/test/fake-relay.test.ts:203`, `:205`, `:206`: `expect(relay.visitorKeys.get('acme')).toBe(first.body.visitorKey)`,
`expect(second.body.visitorKey).not.toBe(first.body.visitorKey)`. When such an assert fails, vitest prints both
values in the diff. The rule (CLAUDE.md, the brief's Security section) is "tests compare it with booleans and fixed
messages", and names generated visitor keys. The writer's report says "Keys are compared with booleans and lengths,
never printed", which these three lines contradict. R6.1 (`:188` to `:190`) does it right with
`expect(fresh.length >= 16 && fresh !== 'k').toBe(true)`.

What a person would get: a throwaway key of a fake in a CI log. The real cost is nil, the rule and the report's claim
are the gap.

Make it right: `expect(relay.visitorKeys.get('acme') === first.body.visitorKey).toBe(true)`,
`expect(second.body.visitorKey !== first.body.visitorKey).toBe(true)`, and the same for `:206`.

How I checked: read the lines; vitest's `toBe` failure message prints expected and received.

## Minor

### M1. Error bodies lack the relay's `message`

`fake-relay.ts:159`, `:160`, `:190`: 404, 401 and 400 come without `message`; relay.py's `error()` always sends
`{'error': code, 'message': text}` (relay.py:1140). The 409 `{ error: 'not_holder' | 'stale_epoch' }` and the 503
`UNKNOWN` match relay.py exactly. A client that validates the error body shape strictly would differ. Add the
messages; they are fixed strings.

### M2. Fastify parses the JSON body before `authorize`, the relay authorizes first; no 415

Fastify's lifecycle runs content parsing before `preHandler`. So `POST /links/<unknown>/sync` or a wrong key with a
malformed JSON body answers 400 with Fastify's own body (`error: 'Bad Request'`, code `FST_ERR_CTP_INVALID_JSON_BODY`)
instead of 404 or 401; relay.py (`sync_answer`, relay.py:1206 to 1215) answers 404, then 401, then 415 for a body that
is not `application/json`, then 400 `{error: 'invalid'}`. The fake never answers 415. Hornhoof's client always sends
valid JSON with the header, so this stays unseen unless a test sends a bad body on purpose. Reasoning from the code,
not reproduced (a reproduction needs a test file inside the repo).

### M3. Names in paths are not lowercased

relay.py lowercases the name in every path (`parts[3].lower()`, relay.py:1166, 1168, 1286, 1347). The fake
looks the name up as given, so `GET /links/ACME/route` is 404 here and 200 there. The fake is stricter, which is the
safe direction, but it differs.

### M4. `register` checks the held name before the busy client id; the relay meets them in the other order

`fake-relay.ts:60` to `:61`. In the real relay a second login of an online client id is refused at `Login` (frps,
`already online`) before any `NewProxy` can hit `router config conflict`. When both hold, the fake says
`router config conflict`, the real stack says `already online`. Both refuse and move no generation, so the row is
kept; the reason differs in that one corner.

### M5. `register` takes a name with no binding

`fake-relay.ts:59`. The relay cannot register a name that has no binding (login needs the key). The fake lets a test
hold `globex` without a binding (R1.3 and R1.4 tests do this). It is a test lever, not an API answer, so no client
behavior is affected; but a later plan's test can build a relay state the real relay never reaches. A guard that
throws on an unbound name, or a `bind(name, key)` helper on `FakeRelay` that sets the binding and seeds the route,
would keep the state honest.

### M6. `since: 0` for a binding set directly in `relay.bindings`

`fake-relay.ts:84` `NO_ROUTE`. relay.py gives `created_at` for a bound name with no row (relay.py:461 to 462), never
0. A client that reads `since` as a positive integer fails against the fake and passes against the relay. Same
remedy as M5: seed the route when a binding is made, through one helper.

### M7. Bearer parsing is stricter than the relay's

`fake-relay.ts:160`: exact `Bearer <key>`. relay.py takes the scheme case-insensitively and strips spaces
(`bearer_key`, relay.py:1152 to 1154). Stricter is the safe direction; noted for completeness.

### M8. R2.3 asserts status only

`fake-relay.test.ts:94` to `:99` check 401, 404 and 503 by status. The brief asks for the table's exact bodies; the
503 body `{error: 'unknown', message}` and the 404 body (see I1) are what plan 1b's client will read. Add body
asserts; this would also have caught I1.

### M9. Small readability points

- `fake-relay.ts:51` `const text = ...` names a zod schema; `syncText` or `shortText` would say what it is.
- `fake-relay.ts:93` `spoiled` is a three-level ternary chain on one line; a small lookup table reads better.
- `fake-relay.ts:159` to `:160`: the `authorize` closure sits inside `fakeRelay`, where the other rules were moved
  out to module functions; it could take the same path (a function of `relay`) for one shape.

## Checked and found right

- Order of checks on route: 404, 401, then 503 while `frpsDown`, then the answer; relay.py the same (`route_answer`).
- Order on sync: auth, body validation, 503, holder (client and generation on a `held` route), epoch strictly higher;
  relay.py the same (`sync_answer`, `set_sync`). Stored record carries the route's generation and `at`; the missing
  record is `{state: 'off', copy: null, epoch: 0, generation: 0, at: null}` as relay.py's `sync_of`.
- Sync body rules match `valid_sync_body`: exactly the five fields, text 1 to 100, integers at least 1, `copy` null
  only with `off`. `z.int()` (zod 4.6.7 is in `apps/server/package.json`) excludes booleans as `type(value) is int` does.
- Route body fields and the 503 body match `route_body` and the `UNKNOWN` text word for word.
- Health: 200 `{ok, frps, relayStarted, passthrough}`, 503 `{ok: false, frps: false}`. relay.py at this clone has no
  `passthrough` yet (Task 9); the writer followed the table, as the plan says.
- R1.5: a bound, reserved or invalid name is answered without frps; any other requested name is 503 while
  `frpsDown`, `taken` while held; a random name never waits. Same order as `requested_name_reason` and
  `random_free_name`. DELETE leaves the route, so the freed name waits for `drop`.
- R6.1: the key is replaced at once; the old one is 401 on route and DELETE; R6.2 replaces the visitor key and DELETE
  removes it, as `release_binding` does.
- `preHandler` short-circuit is proven by the tests themselves: after a 401 DELETE the binding is still there (R6.1),
  so the handler did not run.
- `hang` with `reply.hijack()` plus `forceCloseConnections: true`, so `app.close()` is not blocked; the existing
  three test files still pass (writer's run and the lead's full suite).
- No key is logged; the fake stores visitor keys in plain text in a Map, which the Interfaces ask for.
- TDD: the report lists a red run of 18 tests with reasons that match a fake without the routes (`register is not a
  function`, 404s). I cannot reproduce a past run; I take it on the report's word, with the correction the writer
  made in round three (the `since` change was first done without a red run, then redone with one).
