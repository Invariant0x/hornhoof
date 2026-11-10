# Batch 4, node messages that survive: what the lead accepted from its one review

Reader: Antigravity Argon high: `runs/batch4-node-agy.md`, read it for how each was traced. One fix round, each from a test that fails first. No third round. Plan 4 Tasks 4 and 5 are in the brief below.

## Critical

1. **An old `removed` revokes a machine's new key.** `removed` is numbered, stays in `outbox.jsonl`, and `stop()` closes the outbox before an ack can arrive; a node brought back with `set-key` replays it and wipes its brand-new `keyHash`: 401 on every reconnect. And a socket blip while `remove` waits leaves Hornhoof holding a removed node's key live. Clear the outbox in `setKey` when the node was removed or its server or subscription changed. `remove` keeps the connection until `removed` is confirmed, dropped on an older server, or refused.

## Important

2. **`hello` is dropped past 100 entries.** `MAX_UNCONFIRMED` went, so after 101 finished turns away from Hornhoof, `hello.running` or `tests` trips the protocol's `.max(100)`, the server drops the hello, and the node stops getting work. Choose the smallest right shape: raise the bounds for a confirming server and cap at 100 for an older one, active runs first.
3. **`runOne` and `testOne` hold twice.** They `hold`, await `status()`, then `emit(done)`, which holds again, re-numbering a confirmed end after a reconnect. The plan's Interface: number the held end with `outbox.number(id)` and deliver it.
4. **`sendPending` drops what it never sent.** On an older server, a socket closing mid-flush drops unsent messages: `dropSent` only up to the last that `next()` really took.
5. **A write failure loses messages.** A failed first rewrite leaves no stream header, and restart then forgets everything; a partial line corrupts the next. Mark dirty in both catches, so that the file is rewritten whole from memory.
6. **`flush()` never runs in a test.** Named harm: the file grows without bound on a long-running node and replays weeks of acked messages. One test lets `flushMs` elapse across two drop cycles without close.
