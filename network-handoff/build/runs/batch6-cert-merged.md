# Batch 6, certificate slice: what the fix round does

Reports: `network-build/runs/batch6-cert-r2-agy.md` (Antigravity, with the code) and `network-build/runs/batch6-cert-claude.md` (Claude). Read both from the top.

## Important
1. `apps/server/src/modules/tls/store.ts` `isKeyOf` and `mayRunHttps` check only the first PEM block, while `LinkListener.use` loads the whole chain with `createSecureContext`. A leaf with a broken second block gives `https` and the link stops working in browsers. Keep `checkPrivateKey`, also build the context, and let `linkMode` answer `http`. Test: a broken second block gives `http`.
2. `store.ts` `mayRunHttps` compares SAN names case-sensitively, and the link's host is always lowercase; the ledger already says callers must lowercase. Test: a mixed-case SAN gives `https`. Plan 1b Task 8, being written on top, does its own comparison; do not touch its files.

## Minor worth doing here
3. `store.ts:42`: an `Invalid Date` fails open. Invert the comparison so NaN gives `http`.
4. `apps/server/src/modules/link/client.ts:32`: `PROXY[settings.mode]` takes inherited names such as `toString`. Use an own-key check and throw.
5. `linkMode` swallows a throw with no log line: add one, with no secret in it.

## Also in your lane, from Plan 1's end read
6. `apps/server/test/fake-relay.ts:179-183`: `DELETE /api/v1/bindings/:name` keeps `relay.syncs`, while the real relay drops `sync` with the binding (`BINDING_LIFETIME_TABLES`). Add the delete and a free-and-rebind assertion in `apps/server/test/fake-relay.test.ts`, red first. Fix the comment at `fake-relay.ts:51-54` while you are there: it says a copy only when the sync is on, and the refine allows a copy unless the state is off.
7. `apps/server/test/sign-in-limit.test.ts`'s comment says the races wait for a harness: Plan 3 Task 1 now brings it. Say that instead. A comment only.

## Not yours
`writeTunnelSettings`'s stale row across an await (Antigravity's Minor 3) goes to Task 8's writer. Claude's other Minors go to the ledger.
