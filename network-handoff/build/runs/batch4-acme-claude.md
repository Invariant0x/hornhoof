# Batch 4, slice acme (Plan 1b Task 6): review by Claude, read only

Package: `runs/batch4-acme.diff`, commit de80cc2c on branch batch-4. Compared line by line with the task's Files, Interfaces
and Steps, the Global Constraints, the build rulings, `parallel-map.md` section 3 and acme-client 5.4.0's source in
`node_modules/acme-client/src` (client.js, api.js, http.js, axios.js, verify.js, util.js). No test was rerun; nothing settled
a doubt that the sources did not.

## Counts

- Critical: 0
- Important: 0
- Minor: 7

## The writer's question: account() and the swallowed createAccount failure

The writer's way is right, and no real failure is lost.

How acme-client behaves (`src/client.js:171-189`, `:208-229`; `src/api.js:98-110`): `createAccount(data)` POSTs newAccount,
and `api.createAccount` sets `accountUrl` from the Location only after the answer was 200 or 201 (`apiRequest` throws on any
other status before that line). So while no URL is held, every failure of the create itself, a 4xx problem, a 5xx, no answer,
reaches `makeOrFind`'s catch with `holdsAccountUrl()` false and is rethrown. Nothing of the create is hidden.

Once the create answered 200 (key known), acme-client itself goes on to `updateAccount({ termsOfServiceAgreed: true })`, a
signed POST to the account URL that is not a POST-as-GET and carries no contact and no status. RFC 8555 7.3.1 says the 200's
Location is the account URL, which is all `account()` promises ("found by its key"); 7.3.2 lets a server refuse an update
that changes nothing, and Pebble does (the fake test pins the words `Use POST-as-GET`). The update is acme-client's own
appendix, not a step the Interfaces ask for, and its answer carries nothing the app uses. What its failure could hide: a 5xx
or no answer (the next request, in `issue`, meets the same CA), or an account the CA no longer treats as valid if it still
answered 200 with a Location (the next `createOrder` then fails `refused` with the CA's own type, one request later, and the
URL returned is still the right URL for that key). No data, access or wrong URL comes of it.

`onlyReturnExisting: true` first would be RFC 7.3.1's lookup, but in acme-client it costs one more round trip on every first
setup, needs its own swallow (the 400 `accountDoesNotExist`, matched by type through `lastProblem`), and for a known key
ends in the same `updateAccount` call anyway (then as a POST-as-GET, since `onlyReturnExisting` is deleted and the data is
empty). It is not cleaner, and it is further from the plan's text. Keep `makeOrFind` as written; the writer's ruling and the
comment above it say what happens.

One thing to keep in view (Minor 1 below): with a URL given to the constructor, `account()` is in effect a no-op on Pebble,
since the only request it makes is the update Pebble refuses. `issue` never calls it then, as the brief says, so nothing
depends on it today.

## Critical

None.

## Important

None.

## Minor

1. `apps/server/src/modules/tls/acme.ts:350-356`: `account()` on a constructor-held URL returns that URL after a swallowed
   refusal, without any request having succeeded; a stale or foreign URL is not noticed until `createOrder` answers
   `refused`. Harmless now (`issue` skips `account()` when a URL is held); worth one more sentence in the comment, and a
   seam note for Task 7 or 8: a `refused` of type `accountDoesNotExist` from an order is the moment to drop the held URL and
   find the account by its key again, or the company stays on a dead URL through every backoff.
2. `apps/server/test/before-sign-in.test.ts:23-36` (seam 1b T2 and T6): `GET /.well-known/acme-challenge/:token` answers
   2xx without a session, locally and over the link, when a token is held. The test cannot see it (its fixed `token: 'x'` is
   never held, so it gets 404), and the `PUBLIC` list, which the lead reads as the list of public routes, does not name it.
   Add `GET` and `HEAD /.well-known/acme-challenge/:token: EVERYWHERE` so the list stays true.
3. `apps/server/src/modules/tls/ari.ts:480-485`: a directory that answers 5xx reads as `refused`, while `acme.ts` reads a
   5xx as `unreachable`; and a 200 directory that is not JSON reads as `null`, that is "no ARI", so a proxy page at the
   directory URL silently turns ARI off (writer's ruling). Whether this matters depends on what Task 7 does with `refused`
   against `unreachable` from `renewalInfo`; if it treats them alike, nothing to do.
4. `apps/server/src/modules/tls/acme.ts:404-409`: an order that turns `invalid` at finalize or while waiting for the
   certificate reads as `unreachable` with the order's JSON (cut to 200 characters) as the detail; only the authorization wait
   reads the reason again. The writer notes it; Task 8's backoff then retries a transient for what may be a refusal. No
   secret in that JSON (status, identifiers, URLs).
5. `apps/server/test/acme-fake.test.ts:665-671` and `apps/server/test/ari.test.ts:989-995`: `closedPort()` is the same
   seven lines in two test files; `REQUEST_TIMEOUT_MS = 15000` is declared in both `acme.ts` and `ari.ts`. dryer found no pair
   at 0.8 (too small), but it is duplicated logic; one shared test helper would do.
6. `apps/server/src/modules/tls/acme.ts:254-256`: the comment claims "only one ACME flow runs at a time in the app". At this
   commit nothing enforces or shows it; it is a promise on Task 7's manager. Say so in the comment, or in Task 7's seam.
7. `apps/server/src/modules/tls/acme.ts:258-262` (ruling "no answer"): acme-client's TypeError, with `retryMaxAttempts` 0,
   also eats the code of a self-check's network failure (`ENOTFOUND` against `ECONNREFUSED`), which is the one case where a
   person wants to know why their link does not answer. acme-client's handler throws before the app's interceptor sees the
   error, so nothing cheap recovers it; left as a known cost.

## Checked and found right

- Interfaces: every signature, the module-load settings on `acme.axios` (one cast, `retryMaxAttempts = 0`, `timeout`
  15000, one response handler after acme-client's own), the `Client` options, `account()`'s calls, `issue`'s order of steps,
  `finalized` passed to `getCertificate` (`src/client.js:351-365`, `:598-607`), `hooks.forget` in a `finally`, the error
  rules (problem below 500 `refused`, authorizations read again on a wait that threw with none kept, else `unreachable`),
  `certIdFrom`, the sign byte put back, the trailing slash dropped, `fetch` with `AbortSignal.timeout(15000)` and
  `redirect: 'error'`, `run.sh`'s image digest, flags, trap, wait, `docker cp` and the three variables, both vitest configs,
  the CI job with the same pinned actions as `test` (`images.yml:38-39`), `images` needing both.
- acme-client's handlers: the request interceptor sets `validateStatus` to false so every answer reaches acme-client's
  rejected handler, which, with retries off, returns the response (4xx included) to the fulfilled side; a request with no
  answer trips `validateStatus(undefined)` (`src/axios.js:112`), the TypeError the ruling names. The badNonce retry is in
  `http.js:302` and does not depend on the axios retry; the fake test pins it.
- Keys: none in a message, a log line, a test assertion or a report; `acme-client`'s logger is a no-op unless set; the
  `never puts a key in an error` test compares with booleans only; the fake records only JWS payloads (identifiers,
  `replaces`, `termsOfServiceAgreed`, a CSR), never a key.
- Nothing points at real Let's Encrypt: `LETS_ENCRYPT` is compared as a string; every test server is `127.0.0.1` or Pebble.
- No em dash in the diff; no droplet IP, no hostname but `acme.test`, `acme.hornhoof.org` and RFC 5737 addresses.
- Tests seen failing first: writer's report and `remote-p1bt6-red-*` logs (no module, then the TypeError, then the Pebble
  account failure reproduced in a fast test before the fix). Gates: crapper highest `meaningOf` 8.0, dryer no pair at 0.8
  (`remote-p1bt6-gates-*.log`).
- Processes and ports: every server is closed in `onTestFinished`; `app.listen(5002)` in the real tests is closed by
  `testApp`'s hook; Pebble's container is removed on exit.
