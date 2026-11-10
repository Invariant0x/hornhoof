# Where to read

This batch's staging branch does not exist yet, because batch 6 lands first. Read the tree in the lane `/home/altera/hornhoof-network/wt/p3lease` instead, read only: it stands on batch 6's first commits, then Plan 3 Tasks 1 and 2 and the pure lease file. Batch 6's fix round (Plan 2 Task 3's `AppMode`, Plan 1b Task 7's store) is not under it and does not touch these files.

Plan 3 Task 4's rest (`lease-store.ts`, the keeper's renewals, the fence on a step-down) is not written. Nothing writes a lease yet, so agent roles are always fenced and the orchestrator's database writes are refused on a real company until then: the plan does not ship in part, by ruling. Do not report that as a finding. Do report what Task 4's writer will trip over.

Look hardest at: a write path that reaches a table with no journal entry or no fence, a role that can get around the fence (`SET ROLE`, `SECURITY DEFINER`, a default privilege, a function owner), what the journal stores about a person's secret columns (`HIDDEN`, `SECRET` in `apps/server/src/db/`), whether migration 0057 fails on a real company's existing data or locks a live one for long, and whether the real-Postgres tests would pass with the code wrong. The lease's edge cases: clocks that jump, a tick late by exactly the limit.

You are also this batch's reader for interactions, between the journal, the lease and what batches 4 to 6 already landed.
