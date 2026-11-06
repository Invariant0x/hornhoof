# Fixed source pair proposal for378/222

Status: proposal only. The independent source-preparation stage is complete with concerns;378/222 are not complete. The first head-authorized bounded preflight353 failed at ordinary source fetch before either half started. Head then authorized one replacement offline bounded preflight using the existing archive committed to this temporary branch; it passed as369/part1 at3dc9da87604d33257f323cee65f5e3a37a5f85c2. No full suite, work run or full paired replay was started. No acceleration percentage or whole-suite GREEN is claimed.

## Pinned sources and composition

| Variant | Branch | Exact40SHA |
| --- | --- | --- |
|CONTROL|task-378-fixed-control|6d0c79b0ced4ab2fc4f771a46479680664d6b663|
|OPTIMIZED|task-378-fixed-optimized|b98035e6d1b6b75715a5839ff0a4ea243878e65a|

CONTROL starts at the preserved05c63819 control. It adds only two reviewed test changes: the css.test.ts hunk from441/c7116367cf1005c7656dda180a283170e2d143a4 and the timers.test.ts hunk from489/93e6798ffd77adc433e8e2f1b897c8a6ad65a6a8 relative to12bef523. This does not merge those tasks' feature histories, current theme changes,460,565 or other new turn8 features.

OPTIMIZED is a child of this fixed CONTROL. Its tree delta is byte-for-byte the old05c63819..54340764 optimization patch,28 paths: the preserved controlled clocks and file splits plus their existing documentation. Both new sources therefore have identical CSS/timer fixes. The existing shared408/374/409 fixes remain in their common original integration base. The JSON records their provenance and every path/hash.

Local read-only Git metadata confirms the ancestry, identical hashes for all15 driver configuration inputs and both shared fix files, and the identical binary optimization patch. This is source provenance, not a test or runtime result. Ordinary push and ls-remote readback confirmed both full SHAs. No force, main merge or rights/ref workaround was used.

## Source and driver artifacts

- New source archive: fixed-sources-6d0c79b0-b98035e6.tar.gz,11211338bytes, SHA256 `037b48a88284eebfca0f52c909731b338ab74cc45fe33972b882398614e5752d`, attachment378 `7f16d32c-5439-46a0-b3da-b025b380a258`. It contains an offline bare source.git for the two exact sources, constructed without a remote credential configuration. Packaging/hash was local metadata; remote369 subsequently verified ordinary checkout delivery, all14 safe members, hash and both source refs.
- Unchanged checked driver: edc370c5c1472453649d26cd81ccda3b6ee41347, archive51200bytes, SHA256 `c856c8b8d2217d56f1b8c3740e616374a5a966de2a78f6f7a65415a06161307d`, existing attachment378 `79371b56-ed45-4bf5-945c-9367d8948ab2`. Source checks114/138 remain their original receipts and were not repeated.
- Execution harness branch stays task-378-driver-candidate at6e53d43312e96a8bdab629dd91f3618e078c2af8. Its driver/evidence bytes are those checked above. This proposal lives on a separate task branch so that execution identity does not move.

Do not execute the old wrapper in the driver bundle: it still names the old diagnostic pair/archive. The initial archive-based command body is in2026-11-06-fixed-pair-command.txt. Static remote347/1 passed bash-n and shellcheck on7cbfef0a, without executing that body. Head subsequently replaced this proposal with the ordinary Git/stdout route below. No separate asset transport is awaited or built.

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

The initial HH_IN/HH_OUT proposal is superseded. Head directed one ordinary run_tests command-mode preflight: driver from task-378-fixed-pair-proposal, both sources from their published Git refs via normal fetch, and stdout JSON/hashes in the native tests log. Both halves must run sequentially within one part; full replay needs a later separate decision. The source archive remains a preserved optional artifact, not a prerequisite or a new transport project.

## Actual preflight353

Native353/part1 ran once on platform-selected home-api at exact7cbfef0a51e9f437600fc3fb6c4087e7f000378d,03:12:32.050..03:12:35.499UTC. It failed/exit1. The ordinary Git fetch was its only completed command:

```sh
git fetch --no-tags origin \
  refs/heads/task-378-fixed-control:refs/remotes/origin/task-378-fixed-control \
  refs/heads/task-378-fixed-optimized:refs/remotes/origin/task-378-fixed-optimized
```

Fetch exited128 in511ms: `fatal: could not read Username for 'https://github.com': terminal prompts disabled`. The bounded script finished in519ms with complete:false. Neither source worktree/install/build/test half started. The branch clone and previous source publication succeeded; this failure is the subsequent origin fetch inside353. No credential, remote/ref, runner or work fallback was attempted, and no repeat was created.

Observed actual context: Linux6.8.0-147-generic/x64,Node22.23.4,8 logical CPUs,cpuset0-7,cpu.max=max100000,memory.max=max. All three samples gave load[2.35,2.30,2.44]; free memory91009654784..91034234880bytes, cgroup memory.current215252992..215744512bytes, no recorded OOM events. These are preflight conditions, not performance conditions.

The complete native tests-353-1.log was fetched/read. Its six JSON records include the final result. The3813bytes before the result match its declared count; all83 raw fetch-output bytes are recoverable and match SHA256 `2e554a39e2bb4414b5e2c3f5a90ebc87b405b5b8231d692704ec6df4580e8f60`. No stdout truncation was observed in this preflight. Full command, log digest, decoded failure and resource samples are in2026-11-06-preflight-353.json; the native run record retains the exact executable command.

The353 outcome was followed by head's separately authorized replacement offline preflight below. Its earlier permission was used;353 remains failed. No full pair can be accepted from this result, and no additional execution is started automatically.

The old47fab branch, source archive66b0a5f7, diagnostic05c63819/54340764 pair, rejected run106 FAIL/HH_PAIR_INVALID and all six failures per variant stay unchanged. Historical103/0049 FAIL also remains. Even a future valid paired replay is a new controlled sequential comparison, not historical distributed wall101 or proof of the30% target against turn7.


## Authorized replacement offline preflight

Head's 2026-11-06T03:16:56.189Z decision supersedes the ordinary fetch assumption. The existing source archive above is now tracked at `docs/superpowers/reports/fixed-pair-assets/fixed-sources-6d0c79b0-b98035e6.tar.gz` on temporary `task-378-fixed-pair-proposal` only. This branch must never merge into turn-8 and is to be removed after222, not during this preparation.

The new diagnostic `scripts/benchmarks/linux-fixed-preflight.mjs` is separate from the unchanged edc driver. It checks the pinned archive hash and safe member paths/types before extraction into a fresh temporary directory, verifies both exact40SHAs and ancestry, and imports objects only from that local bare repository. It never fetches origin or reads Git credentials. No new API fields, transport or work run is used.

One command-mode part will execute both halves sequentially. Each has a fresh worktree and empty npm cache, then npm ci, protocol build and node build as separate preparation stages. It runs only timers.test.ts, css.test.ts and check-command.test.ts, with maxWorkers2, original assertions and deadlines, expecting14/3/6 cases per half. Every stage retains complete raw output as base64 plus byte count/hash in stdout; resource records appear before/after stages and every five seconds. The stdout budget stays700KiB. Identity/quota drift, output overflow, setup failure or missing counts makes the result incomplete/failed. This is a bounded setup/fixture preflight, never an accepted performance result.

After ordinary publication and exact SHA readback, the single authorized command is:

```sh
set -e
# run_tests checks out the exact published proposal SHA recorded in the native run.
node --check scripts/benchmarks/linux-fixed-preflight.mjs
node scripts/benchmarks/linux-fixed-preflight.mjs
```

The forthcoming native receipt must name the exact proposal SHA, run/part, elapsed preparation/test times and observed machine/load facts. The one replacement preflight subsequently passed as369/part1 at3dc9da87604d33257f323cee65f5e3a37a5f85c2; see2026-11-06-preflight-369.md/json. On failure, preserve the full log and report the precise blocker to head without another attempt. Full replay remains unauthorized, and353/106/103/0049 retain their actual failure states.


## Completed replacement369 and remaining decision

369/part1 passed on exact3dc9da87604d33257f323cee65f5e3a37a5f85c2: local archive/ref validation and both sequential23-case halves, all16stages0, body46622ms. Actual Linuxx64/Node22.23.4/16CPUs/cpuset0-15/cpu.max=max100000/memory.max=max stayed stable across37 samples; observed load1 0.45..1.37. All16 raw stage payloads, byte counts/hashes and the complete59898-byte pre-result stdout were reconciled. Full native log60848bytes. This is the one authorized replacement preflight, not full comparison or acceleration evidence.

The companion369 report/JSON has exact commands, stage times and all resources. Full-size raw evidence retention via the native stdout route is not proved by this small result; the checked full driver still expects output storage, and the old wrapper must not run. Head's separate decision on a concrete final command/resource/common-slot remains required. No additional run is authorized by this PASS.


## Compact full-run preparation after head's369 review

Head accepted369 only as a scheme preflight, prohibited the full pair pending the exception decision through the orchestrator, and requested one compact-output job proposal. The complete new proposal is2026-11-06-compact-pair-proposal.md and its command draft2026-11-06-compact-pair-command.sh.txt: onepart/minutes120/both fixed sources/four sequential logical shards each/maxWorkers2, unchanged checked driver, all numeric records and hashes in native log. No new run or authorcheck was started. Full raw journal remains worker-local rather than exported; the proposal states why that limits raw audit while retaining numerical review. New command-format/unit/lint verification is NOT_RUN, not inherited from114/138 or369. Await head's exception/command/resource decision with wait_for.
