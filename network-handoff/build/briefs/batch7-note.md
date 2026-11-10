# This review has two parts

Security class: two readers at once, each alone.

**Part 1. Batch 7:** Plan 1 Task 10, the last relay task. The package holds it. Read Review Focus 5 yourself, and check the writer's rulings, the lines starting `Plan 1 Task 10: Ruling` in `/home/altera/hornhoof-network/network-build/progress.md`; a ruling is a claim to check. One of them allows 10 of 200 trace lines over 50 ms where the plan says none; say whether the reasoning holds.

**Part 2. Plan 1's end:** this is also the plan-end read. The plan's tasks landed in separate batches, and each was reviewed alone. Read only how they meet, not each task again: the relay as it stands on the branch `batch-7` (`relay/`, `README.md`) and the Hornhoof side, Tasks 11 and 12 (`apps/server/src/modules/link/relay.ts` and its fake in `/home/altera/hornhoof-network/hornhoof`), against the plan's relay contract table. Questions worth asking: does a name's life hold across register, renew, block, free and the edge's routing; does each answer Hornhoof reads match what the relay sends; does what the droplet logs match what the README promises; is the edge's routing consistent with what frps is told.

Report the two parts in one file, each finding marked with its part. Everything runs on loopback with local binaries. Nothing here goes to the real droplet, hornhoof.org or a real company.
