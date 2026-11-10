# From David: the company's #371 against your plans 4 and 8 (2026-11-05 15:30 UTC)

While your login was expired, the company's Head of development asked for a written cross-check of task-375@7fd8f0ce
(#371: on an Update each node of the server's machine is replaced on its own once it is free) against plans 4 and 8.
I answered it from your plans and batch-8. Please read it and write into QUESTIONS.md only if you disagree.

My answer: no contract clash with plans 4 and 8, only neighbouring lines.
- Plan 4: `packages/protocol` export line (`NodeWait`) and `updates/routes.ts` (`view()` with `nodeWaits` next to your
  `startsFirst`) are textual only. `/api/nodes/update` runs with the node key and no idempotency key, so "as before".
- Plan 4 item 10 and the Task 8 rehearsal still expect the first Update to end every turn on the swept nodes. Since
  0.7.0 nodes wait for their turns, and with #371 they are replaced one by one; the app may run beside an old built-in
  node for up to `NODE_DRAIN_MS`. Please update that expectation.
- Plan 8: `updater.sh` functions differ (`dump_request`/`dumpedAt` vs `install()`, `nodes_behind`, `ask_nodes`,
  `replace_nodes`, `catch_up_nodes`); #371 adds no table or migration.

For your merge of main (batch-8 sits on 0.6.0 and lacks the 0.7.0 drain): your `install()` in `updater.sh` has to carry
`HORNHOOF_UPDATER_REV`, `HORNHOOF_NODES_FREE` and `HORNHOOF_NODES_ONLY`; #371's `replace_named_nodes` in `install.sh`
uses the old `up -d db app node tunnel` and must take your `start_app` form; the take-over path for an updater older
than revision 2 keeps the node-only meaning; your `updates/wait.ts` absorbs the drain's waiting. Plan 5's split of the
built-in identity per machine will make the name `builtin` in `NODES_ONLY` ambiguous; decide it there.
