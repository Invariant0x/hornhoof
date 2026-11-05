# Preparation replay package for #399

Status: **UNFIT for measurement**, preparation artifact only. No measurement or
speedup is reported. This is a measured-replay proposal for turn-7 source on
current hardware, not historical timing. The audit driver is executable; a
measured execution adapter is not implemented or accepted by this package.

## Pins and workload

| Subject | Immutable identity |
| --- | --- |
| Turn-7 baseline source | `f289196b97c9d6fea391248d76e422214f2638ad` |
| Candidate product source | `06f67aebce8bb2653d87c787535e1dd93a620405` |
| Fixture base | `bb6882c520a0180f28610fbf8690a2ae52a56050` |
| Audit driver | This package's task-399 commit, recorded in its evidence receipt |
| Fixture bytes | `apps/node/test/fixtures/preparation-replay-files.json` |
| Fixture variations | `apps/node/test/fixtures/preparation-replay-pins.json` |

`git ls-remote origin refs/heads/turn-7 refs/tags/v0.7.0 refs/heads/main`
returned the baseline's full SHA for all three refs on 2026-11-05. The release
commit's subject is `Release 0.7.0: planned node updates wait for running turns,
direct screen links, agent pictures and the program operator`. Ref movement
later does not change this pinned baseline. The external package carries a
fixture Git bundle, its SHA256 and the full variations' commit IDs. Creating
those Git objects did not install dependencies or execute preparation.

The service-free fixture installs one local vendored npm dependency, builds a
generated protocol file, prepares a 1 MiB immutable template and independently
checks installed dependency value, protocol source hash, migration hash and
template payload hash. It contains no network dependency, browser, database,
project suite or artificial sleep. It is a preparation workload, not a claim of
native UID, service or image integration.

The complete useful workload, common to both proposed paths, is:

```sh
npm ci --offline --install-links --ignore-scripts --no-audit --fund=false
node prepare.cjs build
node prepare.cjs environment
node prepare.cjs ready
```

The candidate manifest uses these same argv commands. A warm candidate restores
validated independent copies and runs the same readiness check. No result from
this workload has been produced yet; even offline npm lock compatibility is
NOT_RUN, rather than inferred from the JSON parser.

## Actual admission boundary

At candidate source 06f67 the required outer owner is
`apps/node/src/main.ts:508 testOne` -> `check-runtime.ts:29 runQueuedPart` ->
`check-queue.ts:27 withCheckSlot` -> `CheckClient.acquire` -> authenticated
`check.acquire` -> server `nodes/check-slots.ts:37 receiveCheckRequest` ->
`queueFor(ctx).acquire(machineKey,actor)`. The server's `machineKey` uses trusted
node/machine identity. The lease precedes `tests.started`, all checkout/cache/
preparation, the command and cleanup; it remains held until `runPart` settles.
The part-user mutex inside it is a UID resource, not a second global admission.

The eventual measured adapter must run as ONE explicit command-mode `run_tests`
part under this existing outer lease, including bootstrap and cleanup. It must
not import a private coordinator, request a nested slot, call run_work, wrap an
unadmitted local command, or treat an env variable/admission JSON as authority.
The audit driver refuses `measure` unconditionally, before inspecting such data.

Observed live node606 at 2026-11-05T22:29 has no four check modules or kind=check
bridge route in the files read by Ops. Its actual deployed build40, bridge
build40, raw hello build, image digest and common physical-slot admission are
unavailable. Ops file SHA256 values are not Git commits or image identities.
This observation is limited to that context. Source run121 does not establish
the live call chain. No new /check request is part of this package. Any needed
update retains #464, real four-CLI and CEO exact-commit approval requirements.

## Adapter and equivalence requirements

The baseline has no product mode. A proposed baseline adapter must call its
actual `tests.ts::runTests` with the pinned fixture branch/SHA checked before
and after its shallow clone, explicit command above and a no-browser fixture.
It must not add a fictional cache/product implementation to old code.

The candidate adapter must use the actual pinned `readTestEnvironment`,
`checkoutCommit`, `prepareDependencies` and `prepareEnvironment` APIs, followed
by identical readiness. Description and mirror fill belong to measured
preparation; a pre-read must not secretly warm them outside the interval.
Helpers do not acquire another global slot. Builders must follow the real
minimal-input/restore/settlement contract. Running a helper as the same UID as
its cache owner is a different experiment from production's distinct builder
and job users. It cannot be reported as the full part's preparation speedup.

No executable adapter satisfying both these conditions and the actual outer
lease has been supplied by this artifact. This is an additional explicit
incompleteness alongside unavailable live admission, not an Ops PASS claim.
Before accepting percentages, verify equal useful output and included work;
if they differ, publish raw durations as **incomparable**, without a speedup.

## Phases and policy for the future run

Use monotonic nanoseconds for durations and UTC for audit/load correlation.
Record raw timestamps, PID, fixture/source/driver SHA, npm/Node/Git versions,
lockfile hash, tool hashes, run ID, part ID, actual host/machine identity,
platform/architecture, available CPUs, memory, cgroup CPU/memory limits and
load before/during/after. Sample load periodically and at phase boundaries.
Container hostname is not a verified physical-host identity.

| Interval | Start and end; policy |
| --- | --- |
| Bootstrap, excluded | Pinned source checkout, npm ci and protocol/node compilation; still inside outer slot |
| Checkout/description | Before actual old clone or candidate description/mirror access through exact checkout |
| Dependencies | Before install/cache lookup through validated private restore |
| Environment | Before each build/template lookup through validated private restore |
| Readiness | Before `prepare.cjs ready` through successful child close and matching output hashes |
| Cleanup, separate | Child settlement and removal; slot remains held through it |
| Preparation total | Checkout start through readiness completion; never includes queue wait or bootstrap |

For both variants record the same instrumentation boundaries. Timestamp/log
calls and validation cost remain inside each interval; do not subtract guessed
instrumentation overhead. Preserve both aggregate and phase durations. Old
source has no historical phase data; this package cannot reconstruct it.

Use Linux/Node 22.23.4/npm 10.9.9 as the first proposed tool pins (observed in
run121, not yet a benchmark environment). Freeze actual Git version and binary
hashes when a compatible machine is selected; unavailable versions stay null.
Do not assume run121's machine/load/cgroup for a later run.

Use private variant cache roots and private HOME/TMPDIR/npm cache per attempt.
Use the local fixture file:// repository and no measured registry traffic.
Never share candidate caches with baseline, source-bootstrap caches or author
quality caches. Cold means absent experiment-owned application caches, not
dropped kernel page cache. Do not flush host OS caches. Warm means a second
candidate attempt over the same scope/runtime and unchanged bytes. Baseline
still performs its actual fresh clone/install; do not invent a cache for it.

Predeclare two blocks with reversed variant order (baseline,candidate then
candidate,baseline), fresh variant roots per block and serial cases below.
Do not call a first observation warm or discard a failed/cancelled sample.
No CPU/machine name is pinned; the platform chooses a compatible free machine.
If the same physical machine, runtime or workload cannot be established,
comparisons are incomparable. Aggregate only matched successful samples; for
comparable samples reduction is `100 * (baseline - candidate) / baseline`.
A zero baseline, missing readiness or failed sample has no percentage.

| Case, starting from the block's warm base | Candidate expectation; baseline repeats actual preparation |
| --- | --- |
| Cold then warm base | Cold misses; warm dependency/build/template hits |
| Ordinary source edit | Dependency/build/template hits |
| Rebuild with identical generated bytes | Build miss; dependency/template hits |
| Changed generated protocol bytes | Build/template miss; dependency hit |
| Changed migration bytes | Template miss; dependency/build hit |
| Changed lock bytes | New dependency key and dependent environment keys; old cache retained |
| Missing generated output | Explicit failure, no cache-hit or percentage claim |

Each invalidation case forks from warm base in its own copied experiment cache
namespace; one case must not warm another. Report actual keys/hits and outputs,
not expected-table entries as observations. Fixture variants are pinned in the
bundle, but their execution and expectations have NOT_RUN status.

## Read-only command and remaining work

The complete audit command, run through targeted command-mode `run_tests`, is:

```sh
set -euo pipefail
npm ci
npm run build -w @hornhoof/protocol
node --experimental-strip-types apps/node/test/preparation-replay.ts plan
```

`measure` exits nonzero. There is no claimed runnable measurement command in
this package. The existing authorcheck receipt records its separate exact
SHA-pinned types/lint/affected coverage/crapper/dryer command. Whitespace and
ESLint style are separate; formatter capability is NOT_CONFIGURED.

Next: implement and review the equivalent adapter without a new runner/queue,
receive actual deployment/admission evidence through the existing Ops route,
and obtain permission for the single targeted preparation measurement. Native
UID/builder/PG17/image tests and final turn integration remain outside this
preparation artifact. No full suite or measurement is authorized by this file.
