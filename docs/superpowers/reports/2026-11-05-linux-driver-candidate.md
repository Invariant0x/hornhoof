# Paired driver candidate, 2026-11-05

This is a checked tooling candidate for tasks 378/222, not a performance result or an approved full run. `acceptedPerformanceResult` remains `false`. No new full suite, run_work or paired replay was started. Run106 remains failed/exit1 and HH_PAIR_INVALID, with 6319 passing and six failing cases per 6325-case variant. Historical run103 and migration0049 failures remain unchanged. The 30% target against turn7 is still unproved.

## Pinned package

The checked code is `task-378-driver-candidate` at `edc370c5c1472453649d26cd81ccda3b6ee41347`. Later documentation commits do not change these code bytes.

`driver-candidate-edc370c5.tar` is 51200 bytes, SHA256 `c856c8b8d2217d56f1b8c3740e616374a5a966de2a78f6f7a65415a06161307d`. It contains four driver/test modules and the unchanged offline wrapper, five regular files plus five directories. Remote run138/part1 reproduced the exact archive bytes from this Git commit, verified every payload against its Git blob, and found zero unsafe paths/types or payload mismatches. It did not extract or run the wrapper.

| File | SHA256 |
| --- | --- |
| `scripts/benchmarks/linux-pair.mjs` | `763cf461e67290355858d6f3064f2c6c9c14c93dfad0ae66255230110a6de293` |
| `scripts/benchmarks/linux-pair-evidence.mjs` | `ee255d499893cbbc814b016bee3806ceebaf3395f0924e570961ca7d66001ec9` |
| `scripts/benchmarks/linux-pair.test.mjs` | `2f160fab8f16834da31ac7a7f31da6c61b3b8a397fad664557997be055a126ef` |
| `scripts/benchmarks/linux-pair-evidence.test.mjs` | `fa1745a535e1b4e035d3de0c0b2aa78530b8be3dae5fae55a0baf3437e2ffa2c` |
| `docs/superpowers/reports/2026-11-05-linux-pair-offline.sh` | `8f0b7a4dc8ca8a9a790b9a882deb5a9f8bff724f9c726aed83315c62aaef20d8` |

The original branch remains `task-378` at `47fab392236820f33fa38f71e23653db8fa63d76`. Its reviewed driver SHA256 is `3f18d46d4d629302c7bdbeb3396b742395cc0b418640fcdda2ada0f6cb2a72ac`; its fixture SHA256 is `c51df1376a705d25474e9be0e73444483371e3b037b88f6691b6e721bce5e136`. Both were read back from that commit during this handoff.

The original `pinned-sources.tar.gz` is still 11281217 bytes with SHA256 `66b0a5f749b0a43db012cbcc8fa60f1ca102a74f9edc2ab31da384a104f787d6`, task378 attachment `5c46c034-074a-4b04-a6b1-0d69f0ea0003`. Its sources remain CONTROL `05c63819d59c0cbba044132c89c503f30cb49856` and OPT `54340764df895693cabdad4027fdad2ffcf48e38`. This is the old diagnostic pair, without later CSS441 or pending timers489 fixes. It is not a proposed new acceptance pair. The old archive and run106 reports/logs were not replaced.

## Behavior and boundaries

Each of the eight fresh logical-source directories now runs lockfile installation, protocol build, then node build before any CLI/suite command. All 24 preparation commands have their own phase and `preparationMs`, separate from 26 suite commands/`suiteMs` and 12 ancillary checks/`checksMs`. The suite still uses two workers, four sequential logical shards per source, the same assertions, counts and original timeouts. No check was removed. Failed preparation stops suite execution for that fresh source and marks the pair incomplete.

Raw child bytes are written to the stage log and evidence journal before post-command quota checks or timing parsing. The journal retains original exit status, signal, duration, full output, base64 bytes and SHA256. Malformed timing records produce an invalid stage; quota drift records the completed stage and aborts further execution. Neither can produce a valid comparison.

The journal and its gzip representation use bounded parts of at most 50 MiB (52428800 bytes). Eighteen evidence-file slots reserve the existing two wrapper files within the runner's 20-file limit; other existing regular files reduce available slots. Normal small cases retain both plain and gzip evidence. If only the complete gzip representation fits, the plain chunks stay in a private subdirectory and every byte remains available in the transmitted gzip parts. If the complete gzip representation cannot fit, finalization is INVALID and the original journal remains intact. Optional fixture limits can only lower the real limits. The unchanged final-frame budget is 700 KiB (716800 bytes), including the newline; oversized metadata is rejected, never trimmed. The compact final frame lists encoding/order, byte counts and SHA256 for complete artifact parts.

The driver observes identity/quotas and five-second load/memory snapshots. It retains fresh worktrees and empty npm caches per logical shard. Host page caches and background load are not controlled. Sequential logical-shard elapsed time is not the old four-machine distributed wall time.

Only the four MJS modules and task documentation differ from preserved47fab. The offline wrapper, apps/packages code, assertions, package files, lockfiles, installer and foreign timers/CSS files are unchanged in this candidate.

## Remote evidence

All new T2 checks below used the platform-selected compatible built-in Linux x64 node, Node22.23.4, hostname `4b437a4f2c1e`, cpuset `0-15`, `cpu.max=max 100000`, `memory.max=max`. No machine was selected by name. Full native receipts, exact command scripts, LCOV and complete logs are in the accompanying evidence archive. Composite run/part IDs are used because the task API does not expose a separate part UUID.

| Run/part | Exact commit | Scope and result |
| --- | --- | --- |
| 111/1 | `ef327d905b5dc02a8e4c250ce3a553cd2082f254` | Expected RED: npm ci exit0, all six transport/completed-stage regressions failed for the intended assertions; exit1. |
| 114/1 | `edc370c5c1472453649d26cd81ccda3b6ee41347` | Mini fixtures 22/22 pass, zero failed/skipped; four syntax checks, ESLint, CRAP exit0. Dryer exit0 but no MJS files analyzed. |
| 138/1 | `edc370c5c1472453649d26cd81ccda3b6ee41347` | Archive-only check: exact SHA256/51200 bytes, five payloads match Git, zero unsafe paths/types; exit0. |

Run114 finished at 22:02:13.607 UTC. Its stage durations were installation3590 ms, mini fixtures/coverage45160 ms, syntax18/18/14/17 ms, ESLint530 ms, CRAP2300 ms and dryer96 ms. Every stage exit code was zero. Observed load1 was0.32..0.91, minimum free memory8056147968 bytes, maximum cgroup memory.current1039388672 bytes across27 resource samples. These are the miniature authorcheck's conditions, not paired-performance conditions. Run111 observed load0.72..0.98 across4 samples; run138 observed1.14 across2 samples and its check took100 ms.

Run114 coverage reports100% lines in all four modules, evidence100% branches, driver87.50% branches and96.77% functions. Maximum reported CRAP is7.2 against the unchanged threshold10. Dryer printed `No source files to analyze.`: its exit0 is not duplication evidence. No formatter or coverage provider was installed. This increment contains MJS only, so Node syntax and scoped ESLint are its language checks; no changed TypeScript package requires a new tsc run.

The critical remote commands were:

```sh
# RED111, after npm ci; expected exit1, six assertion failures
node --test --test-name-pattern='transport|completed-stage' \
  scripts/benchmarks/linux-pair-evidence.test.mjs scripts/benchmarks/linux-pair.test.mjs

# GREEN114, after npm ci; 22 pass, zero failed/skipped
node --test --experimental-test-coverage \
  '--test-coverage-include=scripts/benchmarks/linux-pair*.mjs' \
  --test-reporter=tap --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
  scripts/benchmarks/linux-pair.test.mjs scripts/benchmarks/linux-pair-evidence.test.mjs
```

The full `authorcheck-114.sh` also records syntax/ESLint/CRAP/dryer commands and before/during/after resource facts. `authorcheck-138.sh` contains the exact archive reconstruction and independent payload/path/type checks. These are narrow authorcheck commands, not full replay commands.

## Evidence limits and next decision

The miniature fixtures execute real Git/worktrees/files and real child Node CLIs. Their package/build commands are stand-ins: node preparation copies a variant-specific tiny source into dist, then a real child consumes it. They prove fresh-artifact order and failure handling, not the production compiler or entire suite. The earlier real protocol+node build and three selected CLI cases retain their original diagnostic provenance. They were not repeated or relabeled remote.

The earlier16-case checks and run106 data-only repack were local before the new T2 policy. They remain local evidence at their actual earlier state. The repack retained2067 recovered records plus the original invalid marker, with `acceptedPerformanceResult:false`; it does not supersede run106. The later remote22-case check is the proof for the final code here.

Command-mode run_tests has no input-files/HH_IN/HH_OUT delivery parameter. Thus run138 reconstructs and checks the same pinned code archive bytes remotely; it does not exercise live work artifact transfer or revalidate the original ignored source asset remotely. The transport boundary is tested by small lower-limit fixtures and the actual runner's console truncation implementation. No private queue, local T2 fallback or additional full run was used.

The preserved wrapper's entrypoint is `bash docs/superpowers/reports/2026-11-05-linux-pair-offline.sh`, requiring the original source asset in HH_IN and durable HH_OUT. In the checked code commit it would still replay the old diagnostic05c63819/54340764 pair. It was packaged for inspection and was not executed. A new acceptance command cannot be pinned honestly until timers489 has a fix and a common source pair also includes CSS441 identically. Then prepare that pair's source archive, confirm the exact driver/resource/common slot, and obtain the head's separate decision on one concrete full comparison. Do not launch the old wrapper as a new acceptance run.

Review disposition: both Important findings (transport bounds and loss of completed-stage evidence) have remote RED111 -> GREEN114 evidence. No Critical or Minor findings were reported. Review excluded old clock/split code, foreign timers/CSS, live machine availability/artifact delivery, final packaging and full production performance. Those remain respectively earlier scoped evidence, owners489/441, an explicit untested delivery boundary, archive-only138 proof and pending head acceptance. No re-review or blind replay was started.

Task378/222 remain unfinished while timers489, a new common fixed source pair, resources/common slot and an explicit full-run decision are pending. No claim of a green6325-case suite or 30% acceleration is made.
