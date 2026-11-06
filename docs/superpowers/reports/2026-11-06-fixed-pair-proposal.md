# Fixed source pair proposal for378/222

Status: proposal only. The independent source-preparation stage is complete with concerns;378/222 are not complete. No full suite, work run or paired replay was started. No acceleration percentage or whole-suite GREEN is claimed.

## Pinned sources and composition

| Variant | Branch | Exact40SHA |
| --- | --- | --- |
|CONTROL|task-378-fixed-control|6d0c79b0ced4ab2fc4f771a46479680664d6b663|
|OPTIMIZED|task-378-fixed-optimized|b98035e6d1b6b75715a5839ff0a4ea243878e65a|

CONTROL starts at the preserved05c63819 control. It adds only two reviewed test changes: the css.test.ts hunk from441/c7116367cf1005c7656dda180a283170e2d143a4 and the timers.test.ts hunk from489/93e6798ffd77adc433e8e2f1b897c8a6ad65a6a8 relative to12bef523. This does not merge those tasks' feature histories, current theme changes,460,565 or other new turn8 features.

OPTIMIZED is a child of this fixed CONTROL. Its tree delta is byte-for-byte the old05c63819..54340764 optimization patch,28 paths: the preserved controlled clocks and file splits plus their existing documentation. Both new sources therefore have identical CSS/timer fixes. The existing shared408/374/409 fixes remain in their common original integration base. The JSON records their provenance and every path/hash.

Local read-only Git metadata confirms the ancestry, identical hashes for all15 driver configuration inputs and both shared fix files, and the identical binary optimization patch. This is source provenance, not a test or runtime result. Ordinary push and ls-remote readback confirmed both full SHAs. No force, main merge or rights/ref workaround was used.

## Source and driver artifacts

- New source archive: fixed-sources-6d0c79b0-b98035e6.tar.gz,11211338bytes, SHA256 `037b48a88284eebfca0f52c909731b338ab74cc45fe33972b882398614e5752d`, attachment378 `7f16d32c-5439-46a0-b3da-b025b380a258`. It contains an offline bare source.git for the two exact sources, constructed without a remote credential configuration. Packaging/hash is local metadata; remote archive/asset preflight remains NOT_RUN.
- Unchanged checked driver: edc370c5c1472453649d26cd81ccda3b6ee41347, archive51200bytes, SHA256 `c856c8b8d2217d56f1b8c3740e616374a5a966de2a78f6f7a65415a06161307d`, existing attachment378 `79371b56-ed45-4bf5-945c-9367d8948ab2`. Source checks114/138 remain their original receipts and were not repeated.
- Execution harness branch stays task-378-driver-candidate at6e53d43312e96a8bdab629dd91f3618e078c2af8. Its driver/evidence bytes are those checked above. This proposal lives on a separate task branch so that execution identity does not move.

Do not execute the old wrapper in the driver bundle: it still names the old diagnostic pair/archive. The new exact command body is in2026-11-06-fixed-pair-command.txt. It was prepared as data and has not been executed or syntax-checked. It deliberately requires canonical durable input/output paths instead of assuming that current run_tests provides them.

## Narrow remote proof

Both full logs were fetched and read. Each native run passed, all10 stages exited0, and each ran only23 cases:14 timers,3 CSS and6 check-command. The three old CLI failures now have both protocol and node built first. The original assertions/deadlines are retained, including TERM/grace handling.

| Run/part | Source | Actual executor facts | Outcome |
| --- | --- | --- | --- |
|329/1|6d0c79b0ced4ab2fc4f771a46479680664d6b663|platform-selected home-api; Linuxx64,Node22.23.4,DockerMarkertrue,8 logical CPUs,cpuset0-7,cpu.max=max100000,memory.max=max; observed load1 0.81..2.09|23/23, build/types/test-types/lint0|
|330/1|b98035e6d1b6b75715a5839ff0a4ea243878e65a|platform-selected built-in node; Linuxx64,Node22.23.4,DockerMarkertrue,16 logical CPUs,cpuset0-15,cpu.max=max100000,memory.max=max; observed load1 0.75..1.56|23/23, build/types/test-types/lint0|

The exact commands and complete per-stage resources/outcomes are in tests-329-1.log, tests-330-1.log and the proposal JSON. Their critical commands after npmci were:

```sh
npm run build -w @hornhoof/protocol
npm run build -w @hornhoof/node
# In their respective package folders, maxWorkers2 and original test limits:
npx --no-install vitest run test/timers.test.ts --maxWorkers=2
npx --no-install vitest run test/css.test.ts --maxWorkers=2
npx --no-install vitest run test/check-command.test.ts --maxWorkers=2
# From the repository root:
npx --no-install tsc -p apps/server/tsconfig.json --noEmit
npx --no-install tsc -p apps/web/tsconfig.json --noEmit
npm run typecheck:tests
npx --no-install eslint apps/server/test/timers.test.ts apps/web/test/css.test.ts
```

These ran on different machines and are not comparable performance samples. They do not prove full6325-case counts, the other historical103/0049 failures, or a green full suite. New coverage/CRAP/dryer of the entire old optimization delta was not rerun for this proposal. Its prior evidence remains at its actual source/provenance; the unchanged driver has remote114 CRAPmax7.2, and MJS dryer is UNSUPPORTED. No tooling provider or formatter was installed.

## Proposed future comparison and current gap

The requested future shape is one admitted command-mode job, parts1, two fixed sources, four sequential logical shards per source, maxWorkers2. A120-minute/4GiB allowance is only a resource proposal, not a reservation or an invented run_tests parameter. The same Node,arch,CPU/memory quotas and configuration must hold across both variants. Driver identity checks and five-second load/memory records remain enabled. Each of the eight fresh source directories builds protocol and node before suites; preparation, checks and measured suite time remain separate. npm caches/worktrees start fresh per logical shard; host page caches and background load are observed, not controlled.

The prior bounds remain unchanged:700KiB final frame,50MiB per artifact,20 files total with18 evidence slots and2 reserved wrapper slots. Complete raw logs and journal/gzip are retained outside bounded console; incomplete/overflow/setup failure remains INVALID. Source archive type/path/integrity verification, actual file delivery/export and a common physical-host slot are prerequisites before any full run.

Current run_tests exposes branch/command/parts/minutes, but no input-files or durable author-readable output contract for this asset. The checked driver requires HH_OUT; the old observed runner's HH_IN/HH_OUT export was work-only. A source-only archive check does not close this live transport gap. No private fetch, run_work switch, new request field, environment-based authority or host fallback is proposed. Head must provide the actual supported command-mode asset/output/common-slot handoff, then decide separately on this concrete full comparison after preflight. The drafted command is not currently an executable supported request.

The old47fab branch, source archive66b0a5f7, diagnostic05c63819/54340764 pair, rejected run106 FAIL/HH_PAIR_INVALID and all six failures per variant stay unchanged. Historical103/0049 FAIL also remains. Even a future valid paired replay is a new controlled sequential comparison, not historical distributed wall101 or proof of the30% target against turn7.
