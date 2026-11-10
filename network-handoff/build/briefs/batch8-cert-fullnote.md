# This batch

Batch 8 holds Plan 1b Tasks 8 and 9, Plan 2 Tasks 5, 6 and 7, and two bug fixes. It ends Plan 1b's code and Plan 2. Read in `/home/altera/hornhoof-network/hornhoof` on the branch `batch-8`, read only. The lead settled conflicts between these tasks and batch 6's fixes while assembling: `modules/link/client.ts` (`configFor`'s own-key check, now on `local`), `modules/link/link.ts` (`writeTunnelSettings(db, config, log?)`, `settingsWith`), and `modules/tls/store.ts` (`passes`, `readLinkMode`, `linkMode`). Read those on the branch and say if the join lost anything.

Writers' rulings and their open items are in the ledger, `network-build/progress.md`: the lines naming Plan 1b Task 8, Plan 1b Task 9, Plan 2 Task 5, Plan 2 Task 6, Plan 2 Task 7, and the carries beside them. Claims to check, not to trust.

Look hardest at, in this slice: a certificate or key text reaching a log, a client or a file with a wide mode; a row or a mode left saying https while the listener cannot serve it; a renewal that races a rename of the link or a step-down of `AppMode`; a failed try that stops future tries; what a person sees when Let's Encrypt refuses.

Nothing tests `LinkTls`'s default `new AcmeAccount` wiring against a CA. `npm run test:real` runs Pebble in this batch's check, with the account code and its own tests. Say whether one real test of the whole path (the manager with its default wiring, against Pebble, up to a certificate saved) would catch a harm that nothing else catches, and name the harm. If you find none, say so and we leave it.
