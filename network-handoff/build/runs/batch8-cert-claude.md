# Review: batch 8, slice cert (Plan 1b Task 8), Claude

Read: `network-build/runs/batch8-cert.diff` (commits 1a6926c7, ef508bd1, b4679ea6) and the tree
`/home/altera/hornhoof-network/hornhoof` on `batch-8`, where the cert files stand unchanged after b4679ea6 (checked with
`git diff --quiet b4679ea6 HEAD -- manager.ts checks.ts link-tls.test.ts tls-checks.test.ts`). The lead's check log
(`runs/remote-p1bt8-check-20261105-103601-2441131.log`): 1682 tests in 95 files green, worst changed CRAP 9.0, dryer no
pairs, types and lint clean. No em dash in any changed file. No relay file changed. Nothing in the diff prints a key: the
one log line of a failed order carries kind and type only (`manager.ts:243`), the listener's refusal is a fixed string
(`manager.ts:305`), `TlsView` has no key field, and `loggable` keeps messages only.

## Critical

None.

## Important

None.

## Minor

1. `apps/server/src/modules/tls/manager.ts:359-362` and `:253-266`. A rename that lands during a switch to https (between
   `giveListener` and the end of the 60 s probe) makes the probe of the old name fail, since `PublicLinks.set` has let
   that name go at the relay, and `checkCarried` then saves `httpsBlockedUntil: now + 1 h`. The next pass orders the new
   name's certificate and keeps that block, so the new name stays on http for up to an hour although nothing about it
   failed. `tunnel.json` is never wrong (`linkMode` compares the row's name with the link's), so the link works on the
   relay's TLS meanwhile. Reasoning from `set` (`link.ts:98-100`), `saveMode` (`manager.ts:364-367`) and `order`, which
   saves `mode: 'http'` for a new name but leaves `httpsBlockedUntil`. What would make it right: `order` saves
   `httpsBlockedUntil: null` with a certificate for a new name, or `saveMode` skips the block when `linkOfCompany()` no
   longer names `link.name`. With the keeper's `KeeperServed` the earlier window (a rename during the order) is already
   safe: `use` never confirms the old name and the mode does not move.
2. `apps/server/src/modules/tls/manager.ts:80-83`. `failureFields` takes the CA's `Retry-After` with no upper bound
   (`max(1 h, retryAfterS)`), as the plan's step 4 says. ARI's `retryAfterS` is clamped to a day (`:67`) but a failure's is
   not, so a CA answer with an absurd `Retry-After` would park renewal past the certificate's end and the link would go to
   http at the 24 h line with no retry. Spec-conformant; a clamp at a few days would cost one constant.
3. `apps/server/src/modules/tls/manager.ts:284`. After a CA change the row keeps the old CA's certificate and
   `planRenewal` asks the new directory for renewal information about a certificate it never issued, every hour
   (`'error'` gives `askAt = now + 1 h`) until the certificate is renewed through the new account. Harmless traffic and
   as the plan's step 5 reads; skipping ARI while `certDirectory !== directory` would save it.
4. `apps/server/test/link-tls.test.ts:558-568`. "gives the listener the certificate before it switches" compares the last
   `use` with the probe, not with the mode's write. Code that wrote `mode: 'https'` and `tunnel.json` first and gave the
   listener the certificate after would pass it, and a visitor during that gap (up to the keeper's 20 s wait) would meet
   the stand-in certificate. The code is in the right order today (`pass`, `manager.ts:199-200`); a regression guard
   would record the tunnel's mode at the moment of `use`.
5. `apps/server/test/link-tls.test.ts:749, :753, :775`. `toEqual([GLOBEX, null])`, `toEqual([null, null])` and
   `toEqual([[HOST, null]])` on arrays that hold `{ certPem, keyPem }` when the code is wrong: a failure prints a private
   key into the test output. The key is a throwaway `selfSigned` one made at run time, so no real secret is at risk, but
   the rule is booleans and fixed messages; map to `cert?.certPem` or `cert === null` as the other asserts in the file do.
6. `apps/server/src/modules/setup/routes.ts:47` and `apps/server/src/modules/link/link.ts:16` define the same `Tx`
   alias; one export would do. Behavior of the split route is the same as before, line for line (`madeOrLinkLetGo` keeps
   the let-go, the unique-violation mapping and the rethrow in the old order).

## The join (the lead's question)

Nothing lost. `manager.ts` imports `linkMode, mayRunHttps, saveTls, tlsOf, updateTls` and all stand in `store.ts`;
`mayRunHttps` uses `namesHost` and `hasTimeLeft` under it, `LEAST_LEFT_MS` is private again, `passes`, `readLinkMode`
and `linkMode(db, config, log?)` are as batch 6's fix made them. `PublicLinks.writeSettings` calls
`writeTunnelSettings(this.ctx.db, this.ctx.config, this.ctx.log)` (`link.ts:132`), which is carry 399. `sync()` is in
turn and answers a boolean (`link.ts:124-126`), `set` and `remove` kick after their own write. `configFor`'s own-key
check on `local` (`client.ts:41-42`) matches `Settings.mode`. One seam to know of, from the rest slice: `store.ts:92`
`certificateIn` (the keeper's `servedCertificate`) decides "the certificate for the link's name" a second time beside
the manager's `certificateOf` (`manager.ts:85-88`); they agree today (`order` always writes `notAfter` with `certPem`),
but it is one rule in two files.

## A real test of the whole path

I find no harm that one Pebble run of `LinkTls` with its default `new AcmeAccount` wiring would catch and nothing else
does, so leave it. Reasoning: the seam is typed (`Acme = Pick<AcmeAccount, 'account' | 'issue'>`, and the default
factory is `new AcmeAccount(directory, accountKeyPem, accountUrl)`, both checked by `tsc`); `test/real/acme.test.ts`
already runs the real `issue` against Pebble through the app's own `/.well-known/acme-challenge/*` route and the real
`Challenges`, with `replaces`, and asserts `certInfo(certPem).names`, `certId(certPem)` and `renewalInfo` on Pebble's
chain; `link.test.ts` proves `mayRunHttps` on a chain with a second block and an ECDSA key, which is what acme-client
hands back (`newKey` is P-256). What stays unproven against a CA is the self-check (`verifyChallenge` on port 80 over
the link), which Pebble cannot reach from a container without root, and that is Task 10's staging rehearsal, the lead's
and Ivan's.

## Checked against the brief, no finding

- Interfaces: `start`, `stop`, `tick` (one pass at a time, nothing with certificates off), `kick` (nothing before
  `start`), `serveOn`, `view`, `GET /api/link`'s `tls` all as written. Steps 1 to 8 followed in order; `replaces` only for
  the same name at the same CA with a non-null `certId`; `accountDoesNotExist` and `alreadyReplaced` each give up one
  thing and an order comes back at most twice (`nextOrderTry`); a chain without the host counts as invalid; a new name's
  first https goes through the probe.
- Fail toward a working link: `wantedMode` says http without a certificate that can serve, keeps the row's mode while
  the relay is unknown, and `tunnel.json` is written through `linkMode`, which refuses a row whose name is not the
  link's. A stop during a pass moves no mode (`settleMode`, `runHttps`, `checkCarried` each read `stopped`).
- A failed try never stops future tries: every failure sets a finite `nextTryAt`; a row gone under a pass is one line
  and the next pass makes the row again; a pass that throws is one line and starts over.
- `probe`: new connection each try (`agent: false`), certificate checked, fingerprint compared, bounded by tries and the
  deadline, the request destroyed on timeout; tests cover a server that never finishes TLS and one that never answers.
- Tests are deterministic enough: the clock is the test's, floored to whole seconds; the real clock reaches only
  `tunnel.json`'s mode, and the comment at `link-tls.test.ts` says why that holds. `until` polls; the two 50 ms `aMoment`
  waits guard negative assertions and are bounded.
- Writer's rulings in the ledger (lines 369, 370, 411) match the code. "Each test watched failing first" is the
  writer's claim; the check logs are of the author check after, so I could not verify it and did not try.
