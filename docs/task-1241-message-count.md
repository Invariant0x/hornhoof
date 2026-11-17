# Task 1241: bounded recovery of the message quota

Bug, assigned risk class none. Branch: `task-1241`, based on
`11aa5777c4a5f74a550c0e53570ec35ebae39f53` from `turn-31`. This task is for
0.31.1; it does not integrate into `turn-31`, `turn-32` or `main` itself.
Checked implementation: `8797456d19be31f7385c8e5c25f0b7c34dbd6bc9`.
Status: DONE_WITH_CONCERNS. The assigned named checks pass; the broader author
selection was interrupted and is not a complete or passed check.

The first send in a turn restores its persisted count in `tools/watch.ts`.
Its existing company, sender and inclusive start-time filters remain. Recovery
now counts a subquery capped by `TURN_NUDGES`, the same constant as the refusal
check. The kind is a fixed SQL literal matching the partial index predicate.
The synchronous in-memory reservation, shared quota for `message_employee` and
`tell_orchestrator`, and concurrent-send protection are unchanged.

Migration `0137_message_sender_window`, journal index 136, adds
`agent_events_message_sender_window` on `(company_id, (data->>'by'), created_at)`
where `kind = 'message'`. The head selected 0137 and owns renumbering when the
pending 0137/0138/0139 branches join 0.31.1. Drizzle generated the SQL and snapshot;
the snapshot differs from 0136 only in identity, predecessor and this index.
Earlier migrations are unchanged. No compatibility or data-conversion path was
added. The extra index leaves old queries' columns and rows intact; a full
application-binary rollback was not executed.
There is no supported down-migration runner. The ordinary transactional index
build can hold writes while it runs; no production build duration was measured.

Requirement -> test: `message-count.test.ts` calls the real `message_employee`
handler and captures its executed, parameterized counter query for EXPLAIN.
With 30,000 unrelated events, RED on
`5c163ea5680bb98b1b6611a85e378cbede72afaa` shows Aggregate -> Seq Scan and a
recovered count of 11 instead of the quota 10. Four cases fail for the missing
index and unbounded count; the existing window behavior passes. GREEN uses
Aggregate -> Limit -> Index Scan on the new index, with all three conditions in
Index Cond and no sequential event scan. No elapsed-time assertion or real wait
was added; the message scenarios use a fixed virtual Date.

The tests preserve N-1/N/N+1 behavior, exact window boundaries, start-time
preference and creation-time fallback, other senders, other companies, other
event kinds and outgoing mirrors. They also verify a fresh installation and an
upgrade from 0136 applied twice, with stored messages unchanged.

Named checks on `db7eddda8c84dba3a18fe51810df73698faafc65`: message-count,
watch-tools, message-routing, task-messages and migration-metadata, 100 of 100,
exit 0. The final implementation changes only the new test's driver type;
production and the other four test files are identical. On the final checked
implementation, message-count passed 5 of 5 again, and server/test types,
ESLint of all touched TypeScript files and the server build passed, exit 0.

The RED/GREEN commands, exact commits, exit codes and full outputs, together
with EXPLAIN before and after, are in `docs/evidence/task-1241/`. The project
selector chooses 330 named server files and leaves another 240 to the release
owner. The author command ran on the checked implementation with two workers.
It was stopped after 63 completed file summaries, including two failing cases:
`restore.test.ts` / `applies the carry only after a committed swap` and
`merge-peer.test.ts` / `asks no old copy of a machine that left the data`.
The selected-test process exited 130 and the author command exited 1. No full
counts or completed coverage were produced. Its automatic CRAP pass is not
valid completed-coverage proof; lint, types and independent dryer (no duplicates)
did finish. There is no formatter. The unfinished selection remains for the
release owner, and there is no overall author-check PASS.

Both named failing cases were then executed together, with one worker, on clean
base `11aa5777c4a5f74a550c0e53570ec35ebae39f53` and on the checked implementation:
2 passed in each run, exit 0; the other 35 cases were excluded by the name
selector, not executed. This does not reproduce or explain the earlier failures,
and does not prove either whole file. The interrupted runner did not emit their
complete failure stacks. Restore, merge and backup code and their test files
are unchanged. No full profile or `run_tests` was started. No timeout, test case
or assertion was weakened.

Own diff and security inspection: filters and message permissions remain intact,
the limit comes from one constant, SQL values remain parameterized, and the index
adds no data, access grant or uniqueness rule.
The migration follows Drizzle's generated SQL format; there is no separate SQL
language-rule folder installed on this machine.
