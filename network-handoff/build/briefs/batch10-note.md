# This batch

Batch 10 is the relay's: Plan 1 Task A1 (a link's owner may choose its new key; `hornhoof-relay add` refuses a live name; words about retired keys) and Plan 9c Task 12 (the relay counts the bytes it sends each month). Read in `/home/altera/hornhoof-network/hornhoof-edge` on the branch `batch-10`, read only.

Look hardest at, in A1: who may set a key now and how (`key_answer`, `store_link_key`): can anyone but the holder of the current key set one, can an old key come back and for whom, does a lost answer now leave the owner with their link and nobody else with it, is the new key's strength checked, and does a chosen key reach a log. In `hornhoof-relay add`: the refusal when frps cannot answer, and `runuser` passing the env on (a stub in the tests; only its man page says so): say what an operator gets if it does not. In A2: anything the counter writes under the write queue's lock order, a wrong month at a year's end and at a counter reset, and that it reads only `/proc` and `/sys`.

Plan 1's contract table, the seam to the Hornhoof client: `apps/server/src/modules/link/relay.ts`'s `changeKey` gets its `next` later (Plan 9 Task 3); check that the answers `invalid`, `same_key` and 200 `{ key }` read the same as that task's text. Do not run anything against a live service.
