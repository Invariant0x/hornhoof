# Task 1241: bounded recovery of the message quota

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1241-message-count.md). These are historical results, not checks of the current release.

Branch: `task-1241`, prepared for the authorized fast-forward into `turn-32`.
Released base: `82d62a6bebb3ffde6c21ae89274d85ece89b5685`.
Checked implementation: `d91cd873ba13a60974cd12138e6f46833c73d232`.
The final evidence commit changes documents only. The task records the actual
integration receipt after the push.

The six task commits were rebased onto the rewritten main history, using the
old merge base `11aa5777c4a5f74a550c0e53570ec35ebae39f53` only as the cut point.
No old turn-31 branch was merged. The task range contains no forbidden
co-author trailer; no push to main or turn-31 was made.

The first send in a turn restores its persisted count in `tools/watch.ts`.
The company, sender and inclusive start-time filters remain. Recovery counts a
subquery capped by `TURN_NUDGES`, the same constant as the refusal check. The
fixed message-kind predicate matches the partial index. In-memory reservation,
shared quota for employee messages and reports to the orchestrator, and
concurrent-send protection are unchanged.

The first free migration in the observed turn-32 journal is still
`0137_message_sender_window`, idx 136, immediately after 0136 / idx 135.
Renumbering was therefore unnecessary. The migration adds
`agent_events_message_sender_window` on `(company_id, (data->>'by'), created_at)`
where `kind = 'message'`. Drizzle generated its SQL and snapshot. The snapshot
adds only the index and its new identity/predecessor; earlier migrations and
rows are unchanged. This is an additive index, with no compatibility path or
new access grant. A transactional index build can hold writes while it runs;
production build duration and a full binary rollback were not measured. There
is no supported down-migration runner.

After the rebase, the named message-count, watch-tools, message-routing,
task-messages and migration-metadata files passed: 100 of 100, exit 0. These
include N-1/N/N+1, inclusive window boundaries, start-time preference and
creation-time fallback, other senders and companies, other event kinds,
outgoing mirrors, concurrent sends, the shared quota, and recovery after a
restart. Fresh installation and upgrade from 0136 applied twice passed with
stored messages intact. Server/test types, lint of all touched TypeScript and
the server build passed, exit 0. Full commands, commits and outputs are in
`docs/evidence/task-1241/turn-32/`.

EXPLAIN of the actual parameterized handler query is now Aggregate -> Limit ->
Index Scan on the new index, with all three keys in Index Cond and no sequential
event scan. The original RED and before/after plans remain in
`docs/evidence/task-1241/`: RED showed Seq Scan and an unbounded count of 11
instead of quota 10. No elapsed-time assertion, real pause or timeout change
was added; the new message cases use a fixed virtual Date.

The historical extra author run remains interrupted, not a PASS. Its coverage
and CRAP output are not completed-coverage proof. The two cases it flagged in
restore and merge-peer passed separately on the original base and candidate;
those receipts execute only the named cases, not either whole file. The head
accepted the task evidence and assigned those cases separately. In accordance
with note 29, this resumed work ran only the named files, types, lint and build.
No broad author run, full profile or run_tests was started again.
