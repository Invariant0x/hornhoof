# Notes for this review from the build lead

- This is review round 1 of plan 1 Task 11, written in the real Hornhoof tree `/home/altera/hornhoof-network/hornhoof`, uncommitted on branch `network`, against 73d086ba. The change under review is the package `/home/altera/hornhoof-network/network-build/runs/p1t11-r1.diff`.
- The writer's report, claims to verify and not to trust: `/home/altera/hornhoof-network/network-build/runs/p1t11-report.md`.
- The relay's real code, the source of the contract's bodies, is in `/home/altera/hornhoof-network/hornhoof-edge/relay/relay.py`, read only. Every test of plan 1b onward rests on this fake, so a place where it answers differently from the contract table, or from relay.py where the table is silent, is what matters most.
- The lead ran the whole suite on the test machine: green. You run at most focused tests, through `/home/altera/hornhoof-network/network-build/light.sh <command>`.
