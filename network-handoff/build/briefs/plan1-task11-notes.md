# Notes for this task from the build lead

- Repo: `/home/altera/hornhoof-network/hornhoof`, branch `network` (build ruling 1: no worktree, no new branch), HEAD
  73d086ba. `npm ci` is done and `@hornhoof/protocol` is built; if you see vitest die with "No test files found" and
  `code.charCodeAt is not a function`, it means `packages/protocol/dist` is missing: `npm run build -w @hornhoof/protocol`.
- Plan line references were read at an older main (04bec1d); this clone is 73d086ba, Release 0.6.0. Check each named file
  and line against the code before you rely on it. A fact that proved wrong goes in your report.
- The relay's real code, the source of the contract's exact bodies, is in `/home/altera/hornhoof-network/hornhoof-edge`
  (`relay/relay.py`, uncommitted Task 7 included, read only). Where the plan's contract table and relay.py disagree, say so in
  your report and follow the table.
- Focused runs from `apps/server`: `/home/altera/hornhoof-network/network-build/light.sh npx vitest run test/fake-relay.test.ts --maxWorkers=2`.
- Gates, when the Done when passes:
  - `/home/altera/hornhoof-network/network-build/gates-relay.sh` is NOT for this repo. Use
    `/home/altera/hornhoof-network/network-build/gates-hornhoof.sh 73d086ba server 'test/fake-relay.test.ts test/link.test.ts test/setup.test.ts test/orchestrator-control.test.ts'`.
    Every function you add or change must score under CRAP 10; dryer must find no pair at 0.8 involving your code.
  - Mutator on your changed lines:
    `/home/altera/hornhoof-network/network-build/mutate.sh /home/altera/hornhoof-network/hornhoof 73d086ba apps/server/test/fake-relay.ts 'cd apps/server && npx vitest run test/fake-relay.test.ts --maxWorkers=1'`.
    The mutator may skip a path under `test/` as a test file; if it does, report that and do not work around it: the lead
    rules on it. A survivor is killed by a new test (see it fail first) or listed in your report with why it is equivalent.
- `tsc`: `npx tsc -p apps/server/tsconfig.json --noEmit` from the repo root.
- Do not stage or commit. The lead commits after review.
- The report file: `/home/altera/hornhoof-network/network-build/runs/p1t11-report.md`.
