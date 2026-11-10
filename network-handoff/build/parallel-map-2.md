# Parallel map 2: plans 5, 5b, 6, 7, 8, 9, 9b, 9c, 10, 11, 11b, 13

Date 2026-11-04. Read at: Hornhoof `batch-6` 38e531ae (`network` is 6 commits behind it), with the lanes `p2t5`, `p3t2` read for what
they add; relay `batch-7` 8c2090d (`main` is 1 behind). Nothing changed but this file. The only things run: read-only greps and
scripts over `schema.ts` and the tool names, and one scratch script (Ed25519 and a CRL through the installed `@peculiar/x509`).

Short names as in `parallel-map.md`: `m/` = `apps/server/src/modules/`, `s/` = `apps/server/src/`, `t/` = `apps/server/test/`,
`w/` = `apps/web/src/`, `wt/` = `apps/web/test/`, `n/` = `apps/node/src/`, `nt/` = `apps/node/test/`, `pp/` = `packages/protocol/`.
C = creates, M = modifies. "Paper" is what a task's Starts from line says; "real" is what it consumes or shares.
**[code]** means verified in the code; **[plan]** means only read in a plan.

## 0. In short

- **33 rows are ready now: 11 whole tasks and 22 clean parts of tasks.** No row needs a guess; every name it lacks is given below with its owner's text.
- **Start with six lanes:** peer (R1, R2, R3), merge (R4, R5, R6), decisions (R7, R8, R9), relay (R18, R19, R20), node (R24, R25), small (R23, R22, R13, R16).
- **The chain is the real serial thing, and it is short.** Eleven tasks are only tables. They can go as one lane right after 4 T1 (Q2). That takes "plan by plan" out of most of what follows: plans 6 and 7 can run side by side, and 8 T3, T4, T5 can run before plan 7 ends.
- **What stays serial:** `m/keeper/keeper.ts`, `follow.ts`, `worker.ts`, `w/screens/Machines.tsx`, `apps/updater/updater.sh` (section 3, hot files).
- **Nothing stops a plan today.** Four rulings first: plan 7's ruling 15 (Q1), the T1 lane (Q2), 11b T3's way of touching an agent's folder (Q4, a security gap in the plan's text), 9 T8's arm64 half (Q5).

## 1. Ready now

Ranked by how much later work each lightens. Each row is one writer's brief with the plan's header through Review Focus and the task's text. "Holds" is the part of the task that stays for later, as that task's remainder. Every row may land before anything calls it, as 3 T3's `sql-check.ts` did. Sec = security class (two readers in its batch).

"Exists" means on `batch-6`. A row stacked on another row starts when that one has handed in, on its commit.

### Rank 1 to 6: what opens the most

| R | Task | Files | Consumes, and does it exist | Must be given | Landing cost | Tested alone by |
|---|---|---|---|---|---|---|
| R1 | 5 T2, whole. Sec | C `m/network/authority.ts`, `t/authority.test.ts` | `@peculiar/x509`, `m/tls/x509.ts`: exist. `MachineRole` (5 T1): no | In `authority.ts`: `export type MachineRole = 'data' \| 'worker';` Owner's text, in `s/db/schema.ts`: `export const MACHINE_ROLES = ['data', 'worker'] as const; export type MachineRole = (typeof MACHINE_ROLES)[number];` | 5 T1 turns that line into `export type { MachineRole } from '../../db/schema.js';`. Importers stay | Real mutual TLS on loopback, no database |
| R2 | 5 T4, three files. Sec. Stacked on R1 | C `m/keeper/machine-keys.ts`, `certificate.ts`, `measures.ts`, `t/machine-keys.test.ts`, `t/keeper-certificate.test.ts`, `t/measures.test.ts` | `certFacts`, `needsRenewal` (R1). `ask` is injected, so no route is needed | None | Holds: `keeper.ts`, `s/keeper.ts`, `compose.yaml`, `Dockerfile`, `KeeperOptions`, their tests. They stay 5 T4, after 5 T3 | Temp folders, an `ask` that issues from a test authority |
| R3 | 5 T5, whole but one option. Sec. Stacked on R1, R2 | C `s/net/peer-server.ts`, `s/net/peer-door.ts`, `m/network/via.ts` (these lines only), `t/peer-server.test.ts` | `passThrough`, `serve`, `firstForwarded`, `Target`, `startingAnswer`: exist. `VIA` (5 T3): no. `holdMs` (4 T7): no | In `via.ts`: `export const VIA = 'x-hornhoof-via'; export const OWN_VIA = 'keeper'; export type Asker = { own: true } \| { own: false; machine: string };` `PeerDoor`'s options are `{ app: Target }` | 5 T3 adds `askerOf` to `via.ts`. After 4 T7, `holdMs?` is one more option passed on | Real TLS on loopback, echo app, TCP echo as `db` |
| R4 | 8 T2, whole but one test's half | C `m/merge/rules.ts`, `facts.ts`, `words.ts`, `t/merge-rules.test.ts` | `HIDDEN`, `SECRET`: exist | A set in the test, `LATER = applied, authority, certificates, computer_runs, machine_access, machine_online, machine_tickets, peer_secrets, person_keys, recovery_keys, tool_calls`: tables with a rule that no migration has made yet. The rule's checks skip those names | The set shrinks as each table lands (4 T1, 5 T1, 5b T1, 6 T1) and is gone at 7 T1. Holds: `openTestDb`'s export (see pre-flight) | PGlite for `factsOf`; the rest pure |
| R5 | 8 T4, whole. Stacked on R4 | C `m/merge/plan.ts`, `m/merge/read.ts` (these lines only), `t/merge-plan.test.ts` | `TableFacts`, `BOOKKEEPING`, `ENDS`, `ruleOf` (R4). The rest (8 T3): no | In `read.ts`: `export const HORIZON_MARGIN_MS = 86_400_000; export type Row = Record<string, unknown>; export type JournalRow = { id: string; xact: string; at: Date; tbl: string; op: 'insert' \| 'update' \| 'delete'; key: Record<string, unknown>; cols: string[]; old: Row \| null }; export function keyText(key: Record<string, unknown>): string; // JSON with the columns sorted` | 8 T3 adds its reading functions to `read.ts` | No database at all. A mutator target |
| R7 | 3 T4, the pure file. Needs 3 T2's `s/db/net.ts` (lane `p3t2`, its text below) | C `m/keeper/lease.ts`, `t/lease.test.ts` | `Term`, `LeaseKind`: in `p3t2`, uncommitted, same text as the plan's | `export type LeaseKind = 'normal' \| 'split' \| 'maintenance'; export type LeaseSync = 'copy' \| 'relay_off' \| 'alone'; export type Term = { number: number; machine: string; split: boolean };` in `s/db/net.ts` | Holds: the rest of 3 T4 (`lease-store.ts`, keeper). Already allowed by `parallel-map.md` section 2, ruling 6 | Pure table. A mutator target |

### Rank 7 to 14: pure decisions and the data of a backup

| R | Task | Files | Consumes, and does it exist | Must be given | Landing cost | Tested alone by |
|---|---|---|---|---|---|---|
| R9 | 10 T3, whole, with 10 T2's types. Stacked on R7 | C `m/keeper/takeover-step.ts`, `m/keeper/beats.ts` (`BEAT_MS`, `BEAT_WAIT_MS`, `Stance`, `Beat`, `Heard`, `parseBeat`), `t/takeover-step.test.ts`, `t/takeover-rows.test.ts`, `t/beats.test.ts` (`parseBeat` only); M `m/keeper/lease.ts`, `t/lease.test.ts` | `Route`, `SyncRecord`: exist. `Term`, `Clocks`, `LEASE_MS`, `LATE_MS`, `BACK_MS`, `Held`, `leaseValid` (R7) | The `Stance`, `Beat`, `Heard` text of 10 T2, in the task's own lines | `LeaseStep` only gains fields, so plan 3's keeper still compiles. Holds: `Beats` class (needs R3's `Peer`), peer-server and peer-link changes | Pure tables, section 4's rows replayed by second. A mutator target |
| R8 | 9c T3, whole. Needs `s/db/net.ts` | C `m/keeper/switch-step.ts`, `t/switch-step.test.ts` | `Term` | As R7 | 10 T5 and 11 T4 add their rows later, as their tasks say | Pure tables. A mutator target |
| R17 | 7 T2, whole. Sec. Stacked on R1, R2 | C `m/backups/bundle.ts`, `m/backups/store.ts`, `m/keeper/age-key.ts`, `t/bundle.test.ts`, `t/bundle-store.test.ts`, `t/age-key.test.ts`; M `apps/server/package.json`, `package-lock.json` | `certFacts`, `issuedBy`, `makeAuthority`, `issueCertificate` (R1); `MachineKey`, `HeldCertificate` (R2); `age-encryption` 0.3.1: in the lock | None. 8 T6 adds `fork` to `BundleReason` later | Lane rule for `npm install` (ruling 7 of `parallel-map.md`) and `npm ci` after landing | Temp folders, real age |
| R10 | 9 T7, `sync-step.ts`. Needs `s/db/net.ts` | C `m/keeper/sync-step.ts`, `t/sync-step.test.ts` | `LeaseSync` (as R7); `SyncRecord`: exists | As R7 | Holds: `sync.ts`, `slots.ts`, keeper, `lease-store.ts`. 9c T5 and T9 add rows later | Pure table. A mutator target |
| R11 | 9c T9, `update-steps.ts` | C `m/keeper/update-steps.ts`, `t/update-steps.test.ts` | `UpdaterStatus`: exists, with no `promise` step | In the sample's type: `step: UpdaterStatus['step'] \| 'promise'` | 9c T9 adds `promise` to the union in `control.ts` and drops the local `\| 'promise'`. Holds all else in T9 | Pure table |
| R12 | 11 T4, `split-step.ts` and the `takeover-step.ts` changes. Stacked on R9, R15 | C `m/keeper/split-step.ts`, `t/split-step.test.ts`; M `m/keeper/takeover-step.ts`, `m/keeper/beats.ts`, `t/takeover-step.test.ts` | R9's `Poll`, `Window`, windows and samples; R15's `LastNormal` | In `beats.ts`: `export type NormalView = { term: Term; leader: string; sync: string \| null };` (11 T3) | Holds: `switch-step.ts`, `taking.ts`, `lease.ts` changes, which need 10 T5's first | Pure tables. A mutator target |
| R13 | 9b T3, `score.ts` | C `m/copies/score.ts`, `t/copies-score.test.ts` | Nothing | None | Holds: `qualify.ts`, `order.ts` changes | Pure |
| R6 | 8 T3, the gate | C `s/db/gate.ts`, `t/gate.test.ts` | Nothing | None | Holds the test `gates the app's writes` and all wiring, until `s/db/sources.ts` (4 T1) lands | `AsyncLocalStorage`, no database |

### Rank 15 to 19: whole tasks in the relay and small ones nothing waits for

| R | Task | Files | Consumes, and does it exist | Must be given | Landing cost | Tested alone by |
|---|---|---|---|---|---|---|
| R18 | Plan 1 A1, whole. Sec. After `batch-7` lands | M `relay/relay.py` (`key_answer`, docstring line), `relay/test/test_keys.py` | `key_answer`, `store_link_key`, `read_json`: exist | None | Deploy stays David's. Paper start (plan 9 T3, deploy) is not real | `python3 -m unittest relay/test/test_keys.py` |
| R19 | 9c T12 (A2), whole. Same | M `relay/relay.py` (`SCHEMA`, new functions, `ADMIN_REPORTS`, `main`), `relay/hornhoof-relay`, `README.md`; C `relay/test/test_traffic.py` | `write`, `transaction`, `watch_frps`'s shape: exist | None | SOFT with R18 in `relay.py`, other places. Deploy stays David's | Fake `proc` and `sys` folders |
| R20 | 7 A1, whole. Same | C `relay/test/test_big_body.py` (`Caddyfile`, `frps.toml` only if it finds a limit) | `Stack(tmp, caddy=True)`, `client(via='caddy')`, `https_port`, `certificates.ca`: exist | None | None. About 70 s and 300 MiB: run by name on home-api | Real frps and Caddy |
| R23 | 5 A1, whole | M `m/subscriptions/credentials.ts` (`pushCredentials`), `t/credentials.test.ts` | `keyedNodes`, `deliver`, `held`, `mine`: exist. Paper start (5 T6) is not real | None | None | Its test file |
| R22 | 9 T3, the client half. Pairs with R18 | M `m/link/relay.ts` (`changeKey`'s `next`), `t/fake-relay.ts`, `t/relay-client.test.ts`, `t/fake-relay.test.ts` | Exist | None | Check at landing with R18: `invalid`, `same_key`, 200 `{ key }` the same in both | Its tests; many tests import the fake, so related runs wide |

### Rank 20 to 33: useful, each lightens one task

| R | Task | Files | Consumes, and does it exist | Must be given | Landing cost | Tested alone by |
|---|---|---|---|---|---|---|
| R24 | 11b T3, core. Sec. After Q4 | C `n/saved-work.ts` (`SAVE_*`, `savedTime`, `taskLabel`, `clonesOf`, `saveFolder`, `savedFolders`, `pushSaved`), `nt/saved-work.test.ts`; M `n/workspace.ts` (export `realGit`) | `Git`, `gitEnv`, `JobUser`: exist | None | Holds: `Saver` and `main.ts`, which need 11b T2's protocol | Real git, temp folders, a bare repository |
| R25 | 11b T4, all but `main.ts` | C `apps/node/hh-git.cjs`, `n/git-wrapper.ts`, `nt/hh-git.test.ts`; M `apps/node/Dockerfile`, `nt/image.test.ts` | Nothing | None | Holds: `main.ts`, after 11b T2 and the runNode split | Real git, two bare repositories |
| R27 | 5b T3, `peer-link.ts`. Sec. Stacked on R3 | C `s/net/peer-link.ts`, `t/peer-link.test.ts`; M `s/net/peer-door.ts`, `s/net/proxy.ts`, `t/peer-server.test.ts`, `t/proxy.test.ts` | `PeerServer`, `certFacts`, `HeldCertificate`, `MachineKey` (R1 to R3) | In `peer-link.ts`: `export type LinkPath = 'direct' \| 'relay';` Owner's text (5b T1): `export const LINK_PATHS = ['direct', 'relay'] as const; export type LinkPath = (typeof LINK_PATHS)[number];` | 5b T1 re-exports. Holds: `visit-client.ts` (2 T6's `configFor` head), `connect`'s `holdMs` case (4 T7) | Real TLS on loopback |
| R28 | 5b T7, 6 T2, 6 T5: the key's crypto. Sec | C `m/computer/owner-key.ts`, `m/keeper/owner-pin.ts`, `m/computer/grant.ts`, `w/owner-key.ts` (with `unlockKey`, `signGrant`), `w/ui/PasswordPrompt.tsx`, `t/grant.test.ts`, `t/owner-keys.test.ts` (`keyPrint`, `isP256`, the pin; routes later), `wt/owner-key.test.ts`, `wt/PasswordPrompt.test.tsx` | `api`, `mockApi`: exist | `export type Grant = { payload: string; signature: string };` in `w/owner-key.ts` until 6 T5 puts it in `w/types.ts` | Holds: `keys.ts`, `CommandBox`, `Setup`, `Shell`, `api.ts`, report's `pin`. `keyDefaults` set per test file until 5b T7 puts them in `wt/setup.ts` | WebCrypto, Map store, 1000 iterations |
| R15 | 11 T2, two files. Needs `s/db/net.ts` | C `m/keeper/internet-check.ts`, `m/keeper/last-normal.ts`, `t/internet-check.test.ts`, `t/last-normal.test.ts` | `PROVIDERS`, `Provider`: exist; `Term` | As R7 | Holds: `machineProviders` (`Sql`, 3 T4), `diskTotal`, keepers | Local HTTPS servers, temp folders |
| R16 | 9b T2, three files | C `m/keeper/round-trips.ts`, `throughput.ts`, `internet.ts`, their tests | Nothing | None | Holds: `measured.ts`, `sentBytes`, keepers | Fake clocks, local HTTPS |
| R14 | 9 T2, pure half | C `m/copies/qualify.ts`, `m/copies/order.ts` (constants, `Ranked`, `rankOf`), `t/copies-order.test.ts` (first group) | `MachineRole` (R1) | None | 9b T3 rewrites `rankOf`, so this one is partly thrown away. Holds `candidates`, `rank`, `Ranking` | Pure |
| R26 | 11b T1, `read-tools.ts` | C `m/tools/read-tools.ts`, `t/read-tools.test.ts` (`cutOff`, `callName`, the list) | `McpServer`, the 15 tools: exist | None | Holds: `mcp.ts`, `modeGate`, `state.ts`, `guardTools`, `front-calls.ts` | A bare `McpServer` |
| R29 | 5b T4, two files | C `m/keeper/addresses.ts`, `m/keeper/worker-pages.ts`, `t/addresses.test.ts` | `Refusal`: exists | `export type DataMachine = { machine: string; networkId: string; hostname: string \| null; addresses: string[]; peerPort: number \| null; webPort: number \| null };` (5b T2), in `worker-pages.ts` | 5b T2 moves it and re-exports | Temp folder, pure |
| R30 | 9 T4, door | C `s/net/db-door.ts`, `m/keeper/replica.ts` (`REPLICA_ROLE`, `PUBLICATION`, `replicaPassword`, `scramVerifier`), `t/db-door.test.ts` | Nothing | None | Holds: `ensureReplica`, `replicaReady` (`Sql`), `KEEPER_PORTS.db` | TCP on loopback, pure |
| R31 | 10 T10, word and banner | C `m/keeper/switch-word.ts`, `w/ui/SwitchBanner.tsx`, `t/switch-word.test.ts`, `wt/SwitchBanner.test.tsx`; M en, ru | `mockApi`: exists | None: the plan gives both answers whole | Mounted in `Shell.tsx` at 10 T10. 11 T8 adds lines | Pure; mocked fetch |
| R32 | 10 T6, cookie and question. Sec | C `s/auth/read-cookie.ts`, `w/ui/RecoveryQuestion.tsx`, `t/read-cookie.test.ts`, `wt/RecoveryQuestion.test.tsx`; M en, ru | `config.secret` is a `Buffer`: exists | `Question` (10 T6) as a web type, from the plan's text; `GET /api/recovery`: `{ question: Question \| null, canAnswer: boolean }` | Mounted in the layout at 10 T6. 11b T5 adds `here` | Pure; mocked fetch |
| R33 | 8 T9, the card | C `w/screens/MergeCard.tsx`, `wt/MergeCard.test.tsx`; M en, ru | `api`, `mockApi`: exist | `ConflictView` and the `merges` item, from 8 T8 and 8 T9, as web types | Mounted in `Tasks.tsx` at 8 T9 | Mocked fetch |
| R21 | 13 T12, relay half | M `relay/test/harness.py` (`Stack` options); C `relay/test/lab_stack.py`, `relay/test/test_lab_stack.py` | `Stack`, `route_of`: exist | None | Holds: `lab.Dockerfile` (a digest to pin) and the Hornhoof half. Keep `droplet_logging` in the signature | Free ports, no Docker |

Whole tasks: plan 1 A1, 5 A1, 5 T2, 5 T5, 7 T2, 7 A1, 8 T2, 8 T4, 9c T3, 9c T12, 10 T3.

**Not ready, on purpose.** 8 T3's `read.ts`, 8 T5: `net.merges` and the rest (8 T1). 5 T3: tables, `fromTunnel` (4 T3). 5b T2, 6 T2's `access.ts`, 7 T3: tables. `visit-client.ts`, `peer-client.ts`: `configFor`'s head (2 T6). `Backups.tsx`, `RestoreFromFile.tsx`: Q1 and many routes. Any `Machines.tsx` task: serial. 13 T1 to T7: `guide-words.test.ts` reads `en.ts` and `ru.ts` for strings plans 5 to 11b add, so its first test cannot pass and each row is rechecked against the code at landing anyway; writing them now saves nothing (Q6). 13 T9 to T11: `lab.ts` (5b T9).

### Lanes for today

| Lane | Rows, in order | Class | Note |
|---|---|---|---|
| Peer | R1, R2, R3, then R27 and R17 side by side | Sec, Opus | Opens the most |
| Merge | R4, R5, R6 | Opus for R5 | R4 gates 9 T1 in the chain |
| Decisions | R7 when 3 T2 lands, R8 beside it, then R9, R10, R11, R15, R12 | Opus | One writer per row. `takeover-step.ts` has one writer at a time |
| Relay | R18, R19, R20, each its own clone, when `batch-7` lands | Sec for R18 | Then R21 |
| Node | R25, then R24 after Q4 | Sec for R24 | `apps/node` has no other writer but the coming runNode split, and neither row touches `main.ts` |
| Small | R23, R22, R13, R16, then R29, R30, R26, R31 | Sonnet, or Antigravity for the simple | Web rows meet in en, ru: SOFT |

## 2. Pre-flight of those

Verified against the code unless a row says **[plan]**. Line numbers are at `batch-6`.

| R | Holds? | What to tell the writer |
|---|---|---|
| R1 | Holds | Ran on Node 22.23.2 with 1.14.3: an Ed25519 self-signed CA and a CRL with `cessationOfOperation` read back; OpenSSL taking that CRL is the task's own test. `toPem` at `m/tls/x509.ts:16` is private and holds the reason (no final newline breaks a chain): export it, do not copy it, or dryer says so. Import `x509.ts` first (`:5` sets the provider) |
| R2 | Holds | Leave out everything naming `KeeperOptions`. `keeper.ts` is in lane `p2t5` and later lanes; do not touch it. The test `keeps leading when its folder cannot be written` goes with T4's remainder |
| R3 | **Small drift** | `PassOptions` (`s/net/proxy.ts:6`) has no `holdMs`; it comes with 4 T7. `unreachable` is required and the plan does not name one: use `startingAnswer` (`proxy.ts:242`). `fromTunnel` is private at `s/auth/tunnel.ts:6` until 4 T3, so `askerOf` waits. Two `socketAddress` exist (`proxy.ts:234` takes a request, `m/tls/listener.ts:26` a socket) |
| R4 | **Small drift** | All 31 tables of today's `public` have a rule (script); 11 rules name tables not made yet: the `LATER` set. `openTestDb` is private at `t/helpers.ts:37` and a change to `helpers.ts` runs the whole server package (ledger): build `Query` from `createTestDb()`'s `$client`, as `t/db.test.ts:116` reads it, and leave the export to 8 T3. Columns checked by script: `CLOSING`, `SOFT_REFS`, the `number` and `task` columns hold for today's tables. `task_events.uuid` comes with 3 T2 (`p3t2`). New secret columns since the plan (`link_tls.account_key_enc`, `cert_key_enc`, `node_codes.command_enc`, `sign_in_attempts.*_hash`) match `_enc` and `_hash`. Migration names in tests read number + 11 |
| R5 | Holds | **[plan]** Ruling 5 and 6 are the task; no anchors. Keep to the types given, as 8 T3 fills `read.ts` |
| R6 | Holds | No code to meet. Leave `s/db/sources.ts` and `agent-sql.ts` alone |
| R7 | Holds | `s/db/net.ts` is uncommitted in `p3t2`; the types match plan 3 line for line. Stack on that lane's hand-in or wait for its landing |
| R8 | Holds | Only `Term`. Write the tables as they are; plan 10 and 11 rows come with their tasks |
| R9 | Holds | `Route` (`m/link/relay.ts:40`), `SyncRecord` (`:26`) exist and `Route` has the `known` the window reads. `Health`'s `DOWN` (`:46`) has `relayStarted: null`, which fits `Poll.health`. `Peer` is not needed for the types |
| R10 | Holds | `SyncRecord` has `state, copy, epoch, generation, at`, as "off stored" reads. `hold`'s rows are 9c T9's, not here |
| R11 | Holds | `UpdaterStatus` at `m/updates/control.ts:6`; no zod parses it, so 9c T9's widening is safe. The web's `UpdateStep` (`w/types.ts:513`) is separate |
| R12 | Holds | **[plan]** Only rows through `alone`, `leadBeat`, `mayTurnNormal`. The second-by-second rows that take `nextLeaseStep`'s kind wait for T4's remainder |
| R13 | Holds | **[plan]** Rulings 3, 5, 7, 9 are the task; pure, no anchors |
| R15 | Holds | `PROVIDERS` at `s/db/schema.ts:118` starts `claude, codex`, so the plan's expected list holds. `INTERNET_EVERY_MS` also exists in R16's `internet.ts` with another value: both as written, different files |
| R16 | Holds | Tests use local servers only; `DOWNLOAD_URL` and `PING_URL` are never fetched in a test |
| R17 | Holds | `age-encryption` 0.3.1 in the lock (`package-lock.json:3100`), `apps/node`, `apps/web`; `Encrypter.encrypt` takes a `ReadableStream`. `n/keys.ts:7` is the shape `ageKey` mirrors |
| R18 | **Small drift** | `MAX_BODY` is `relay.py:49`. `key_answer` (`:1605`) also serves the visitor key: only `visitor=False` reads `key`, and the visitor path keeps ignoring a body. `read_json` (`:1512`) can return a non-object: that is `invalid`. Add K to `Stack.private` in tests. Compare with `secrets.compare_digest`. Docstring line `:10` changes |
| R19 | **Small drift** | Tables go in `SCHEMA` (`relay.py:118`), not `init_db` directly. Both writes through `transaction()` (`:1158`). `ADMIN_REPORTS` (`:1813`), usage (`:1826`), docstring (`:14`), thread (`:1845`). The unit has only `ProtectSystem=strict`, so `/proc` and `/sys` read. "Warns once a day" needs one small round function, testable; `watch_traffic` loops it |
| R20 | **Small drift** | `Caddyfile:72-81` moved, and the plan's other cites too: `request_body`, `max_size`, `read_body` are still absent (grep), `vhostHTTPTimeout = 60` holds (`relay/frps.toml`). `MAX_BODY` is at `:49`, `:1515`. Name the module to `author-check-relay.sh` |
| R21 | **Small drift** | `Stack.__init__` (`harness.py:378`) now also has `droplet_logging`, which stays. Start it after `batch-7` lands, as p1 T10 changed `harness.py` |
| R22 | Holds | `changeKey` at `m/link/relay.ts:131`; `secretFrom` (`:140`) calls `call('POST', path, { key })` and `call` (`:97`) takes `body`. Fake's route at `t/fake-relay.ts:196` |
| R23 | Holds | The last path is `credentials.ts:89`, `held` is above it, `keyedNodes` imported at `:8`. `inOrder` in `n/main.ts:332-340` does what the plan says. David confirmed node keys (QUESTIONS 5) |
| R24 | **Gap** | See Q4. Otherwise holds: `n/runner.ts:104` is the agents' folder, `prepareRepo` clones at `<workDir>/<repoFolder>` (`workspace.ts:34`), `realGit` is private at `workspace.ts:16`, `gitEnv` at `:26`, git here is 2.47.3 |
| R25 | Holds | `childEnv` (`n/providers/process.ts:14`) puts `<tools>/bin` first, and terminals use it (`n/main.ts:712`). `COPY apps/node/hh-fs.cjs /app/apps/node/hh-fs.cjs` (`apps/node/Dockerfile:132`) is the pattern. The node's own git (`workspace.ts:39`) uses plain `PATH`, so it does not meet the wrapper |
| R26 | Holds | All 15 names exist (script; `view` at `m/tools/control.ts:92`, `pool` at `:255`). Step 1's proof can be done now, and rerun at T1's remainder: tools are added meanwhile (8 T8's) |
| R27 | **Small drift** | `configFor` is private (`m/link/client.ts:28`), `Client` is at `m/link/tunnel.ts:17`: hold `visit-client.ts`. `proxy.test.ts`'s second case needs `holdMs` |
| R28 | Holds | `w/api.ts:44` is the one client; `wt/setup.ts` has no key defaults yet. `ComputerCard.tsx`, `CommandBox.tsx` exist and are not touched |
| R29 | Holds | `isPrivate`'s ranges are 10/8, 172.16/12, 192.168/16, per 5b T2's report rule (plan line 514) **[plan]** |
| R30 | Holds | `net/db-door.ts` is new; **[plan]** `scramVerifier` follows RFC 7677 |
| R31 | Holds | `Shell.tsx:305` is where the update banner sits, for later. No mount here |
| R32 | Holds | `Config.secret` is a `Buffer` (`s/config.ts:9`) |
| R33 | Holds | **[plan]** `api-mock`'s `decisions()` change goes with 8 T9 |
| R14 | Holds | **[plan]** Text only, no anchors; `Candidate` is filled by `candidates`, which holds |

## 3. The order that really binds

### Migration chain

Each a plan's number + 11 (`parallel-map.md` section 6), and each lands alone. Now: `0055_link_tls` on `batch-6`, `0056_sources`, `0057_net` in `p3t2`, then 4 T1's `0058_steps`, `0059_calls`.

| Number | Task | Real need besides the one before |
|---|---|---|
| `0060_network` | 5 T1 | none |
| `0061_machines_join` | 5b T1 | none |
| `0062_computer_access` | 6 T1 | none |
| `0063_backups`, `0064_net_backups` | 7 T1 | `net` (3 T2) |
| `0065_merges` | 8 T1 | `net.backups` (`0064`); `t/fence-lint.test.ts` (plan 3). Its text says `0053` for the check it drops: read `0064` |
| `0066_copies` | 9 T1 | `m/merge/rules.ts` (R4) |
| `0067_server_order` | 9b T1 | `rules.ts` |
| `0068_switch` | 9c T1 | `rules.ts`; `net.ranking` as a pattern |
| `0069_takeover` | 10 T1 | `machines.copy_state` (`0066`), `net.handovers` (`0068`) |
| `0070_splits` | 11 T1 | `net.handovers`' `kind` (`0069`) |
| `0071_go_on_here` | 11b T5, its migration part | `net.handovers`' `reason`. Split from T5 |

**[plan]** 5 T1 and 8 T1 read whole; the others by their Files and Consumes lines, which name schema, `HIDDEN`, `CLOSED`, `rules.ts` and tests, and no app code of their own plan. The Q2 lane's writer reads each in full and stops if one says otherwise. See Q2.

### Plan tables

Tests are left out unless shared. "Chain" = waits only for the migration lane. Rn = section 1's row.

#### Plan 5

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0060`; M `s/db/schema.ts`, `s/db/agent-sql.ts` (`HIDDEN`), `m/tools/database.ts` (`CLOSED`) | chain | HARD chain |
| T2 | R1 | paper T1 | none |
| T3 | C `m/network/store.ts`, `routes.ts`, `via.ts`; M `s/app.ts`, `m/nodes/nodes.ts`, `routes.ts`, `m/testruns/pool.ts`, `runs.ts`, `s/errors.ts` | T1, T2; `fromTunnel` (4 T3) | SOFT `app.ts`, `errors.ts` |
| T4 | R2, then M `keeper.ts`, `s/keeper.ts`, `compose.yaml`, `Dockerfile` | T2, T3 routes; keeper of 3 T5, 4 T7 | HARD `keeper.ts`, `compose.yaml` |
| T5 | R3 | T2, T4's types; 2 T4. Paper T4 | none |
| T6 | C `m/link/peer-client.ts`; M `keeper.ts`, `m/link/tunnel.ts`, `lease-store.ts`, `t/fake-lease.ts` | T3, T4, T5; 2 T6's `TunnelKeeper` | HARD `keeper.ts` |
| A1 | R23 | today's. Paper T6 | none |
| T7 | runs all | | |

#### Plan 5b

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0061`; M schema, `HIDDEN`, `CLOSED` | chain | HARD chain |
| T2 | C `m/network/join.ts`; M `m/network/routes.ts`, `store.ts`, `via.ts`, `m/nodes/routes.ts`, `codes.ts`, `disconnect.ts`, `s/errors.ts`, `s/auth/tunnel.ts` | T1; 5 T3; 2 T6 | SOFT `nodes/routes.ts` |
| T3 | R27; C `m/link/visit-client.ts` | 5 T5; 2 T6 for the visit client. Paper T2 | SOFT `proxy.ts` |
| T4 | C `m/keeper/worker.ts`, `worker-config.ts`, R29; M `s/keeper.ts`, `keeper.ts`, `s/config.ts` | T2, T3; 5 T4; 4 T7's hold | HARD `keeper.ts` |
| T5 | C `m/network/follow.ts`; M `m/updates/*`, `join.ts`, `m/conversation/queue.ts`, `m/testruns/runs.ts`, `worker.ts`, `updater.sh`, stubs | T2, T4 | HARD `updater.sh`; SOFT `queue.ts` |
| T6 | C `compose.worker.yaml`; M `compose.yaml`, `Dockerfile`, `scripts/install.sh`, stubs, `n/main.ts` (`set-server`) | T2, T4, T5 | HARD `install.sh`, `compose.yaml`, `n/main.ts` |
| T7 | R28, then C `m/computer/keys.ts`; M `s/app.ts`, `s/errors.ts`, `m/people/routes.ts`, `worker.ts`, `m/network/routes.ts`, `w/ui/CommandBox.tsx`, `w/screens/Setup.tsx`, `w/api.ts`, `Shell.tsx`, en, ru | T1, T4, T6 | SOFT many |
| T8 | M `m/nodes/routes.ts`, `nodes.ts`, `w/screens/Machines.tsx`, `w/types.ts`, en, ru | T2. Paper T7 | HARD `Machines.tsx` |
| T9 | C `t/lab/machine.Dockerfile`, `lab.ts`, `join.test.ts`, `apps/server/vitest.lab.config.ts`; M both `package.json`, `t/pins.test.ts` | T6. Home-api | none |
| T10 | runs all | | |

#### Plan 6

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0062`; M schema, `HIDDEN`, `CLOSED` | chain | HARD chain |
| T2 | R28's `grant.ts`, then M `m/computer/access.ts`, `routes.ts`, `keys.ts`, `tools.ts`, `m/network/routes.ts`, `join.ts`, `m/tasks/decisions.ts`, `routes.ts`, `m/nodes/routes.ts`, `s/app.ts`, `s/errors.ts`, `m/events/stream.ts` | T1; 5 T3; 5b T2, T7 | SOFT `decisions.ts` with 8 T9 |
| T3 | M `m/computer/tools.ts`, `access.ts`, `m/tools/job.ts`, `m/conversation/live.ts`, `queue.ts`, `prompt.ts`, `routes.ts`, `m/tasks/wake.ts` | T2 | SOFT `queue.ts` |
| T4 | C `m/keeper/computer.ts`; M `keeper.ts`, `worker.ts`, `worker-config.ts`, `s/config.ts`, `m/network/routes.ts`, `compose.yaml`, `updater.sh` (comments), `t/lab/join.test.ts` | T2; 5, 5b keepers | HARD `keeper.ts`, `worker.ts` |
| T5 | R28's web part; M `w/types.ts`, en, ru | 5b T7. Paper T4 | SOFT en, ru |
| T6 | M `w/ui/ComputerCard.tsx`, `w/screens/AgentWindow.tsx`, `Tasks.tsx`, `Machines.tsx`, `Shell.tsx`, `w/types.ts`, en, ru | T2, T5. Paper T5 | HARD `Machines.tsx`, `Tasks.tsx` |
| T7 | runs all | | |

Plan 6 and plan 7 need each other only through `0062`'s tables (7 T7). They share `keeper.ts`, `worker.ts` and `Machines.tsx`, which land one at a time.

#### Plan 7

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0063`, `0064`; M schema, `HIDDEN`, `CLOSED` | chain | HARD chain |
| T2 | R17 | R1, R2. Paper T1 | lock |
| T3 | C `m/backups/types.ts`, `records.ts`, `holders.ts`, `recovery.ts`, `routes.ts`; M `s/app.ts`, `m/network/routes.ts`, `m/nodes/routes.ts`, `s/errors.ts` | T1, T2; 5 T3; 5b T2 `keeperAsker`, `onlineShare`; 2 T6 | SOFT |
| T4 | C `apps/updater/cutover.sql`, `carry.sql`, `t/carry.test.ts`, `t/real/restore-swap.test.ts`; M `updater.sh`, `apps/updater/Dockerfile`, `compose.yaml`, stubs | T1's tables. Paper T3 | HARD `updater.sh` |
| T5 | C `m/keeper/backups.ts`; M `s/net/peer-server.ts`, `keeper.ts` | T2, T3, T4; 5 T5 | HARD `keeper.ts` |
| T6 | C `m/keeper/holder.ts`; M `s/net/peer-link.ts`, `worker.ts` | T2, T3, T5; 5b T3, T4 | HARD `worker.ts` |
| T7 | C `m/backups/restore.ts`, `m/keeper/restore.ts`; M `routes.ts`, `backups.ts`, `keeper.ts`, `updater-status.ts`, `m/updates/control.ts`, `routes.ts`, `m/people/routes.ts`, `s/app.ts`, `s/errors.ts` | T2 to T5; 5b `disconnectMachines`; T1 of plan 6 | HARD `keeper.ts` |
| T8 | C `m/backups/total-loss.ts`; M `routes.ts`, `restore.ts`, `m/setup/routes.ts`, `keeper.ts`, `holder.ts`, `worker.ts`, `worker-config.ts`, `s/app.ts`, `s/errors.ts` | T2, T3, T7; 2 T6; Q1 for its last line | HARD `keeper.ts`, `worker.ts` |
| T9 | C `w/screens/Backups.tsx`, `RestoreFromFile.tsx`, `guide/backups.md`; M `Settings.tsx`, `Setup.tsx`, `Machines.tsx`, `Shell.tsx`, `w/api.ts`, `w/types.ts`, en, ru, `SECURITY.md`, `README.md`, `guide/README.md` | T3, T7, T8 | HARD `Machines.tsx` |
| T10 | C `t/lab/steps.ts`, `backups.test.ts`; M `t/lab/lab.ts`, `join.test.ts` | 5b T9, T9. Home-api | HARD `lab.ts` |
| T11 | runs all | | |
| A1 | R20 | p1 T9. Real | none |

#### Plan 8

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0065`; M `t/fence-lint.test.ts` | chain, 3's lint | HARD chain |
| T2 | R4 | today. Paper T1 | none |
| T3 | R6; C `m/merge/source.ts`, rest of `read.ts`, `t/merge-fixture.ts`; M `s/db/sources.ts`, `s/db/agent-sql.ts`, `t/helpers.ts` | T1, T2; 3 T3's `stripSettings`; 4 T1. **Not plan 7** | SOFT `helpers.ts`, `agent-sql.ts` |
| T4 | R5 | T2, T3's types | none |
| T5 | C `m/merge/apply.ts`, `check.ts` | T1 to T4; `withSource` (4 T1). **Not plan 7** | none |
| T6 | C `m/merge/kept.ts`, `merger.ts`; M `m/backups/restore.ts`, `routes.ts`, `types.ts`, `bundle.ts`, `m/updates/routes.ts`, `lease-store.ts`, `s/app.ts`, `s/errors.ts`, `updater.sh` | T3, T5; 7 T7 | HARD `updater.sh`; SOFT |
| T7 | M `updater.sh`, `m/keeper/backups.ts`, `keeper.ts`, `worker.ts`, `m/backups/types.ts`, `holders.ts`, `routes.ts` | T6; 7 T5, T6 | HARD `keeper.ts` |
| T8 | C `m/merge/task.ts`, `picks.ts`, `tools.ts`; M `m/tools/mcp.ts`, `merger.ts` | T2, T5, T6. Paper T7 | SOFT `mcp.ts` |
| T9 | R33; C `m/merge/routes.ts`; M `m/tasks/decisions.ts`, `routes.ts`, `s/app.ts`, `Tasks.tsx`, `Backups.tsx`, `w/api.ts`, `w/types.ts`, en, ru, `wt/api-mock.ts`, `guide/backups.md` | T6, T8; 7 T9 | SOFT `decisions.ts` with 6 T2 |
| T10 | C `t/real/merge.test.ts`, `t/lab/merge.test.ts`; M `t/real/pg.ts` | T1 to T9. Home-api | none |
| T11 | runs all | | |

#### Plan 9

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0066`; M schema, `rules.ts` | chain, R4 | HARD chain |
| T2 | R14; M `m/network/routes.ts`, `join.ts`, measures, reports, `s/app.ts` | T1; 5 T3; 8 T6's place | SOFT |
| T3 | C `m/copies/scope.ts`; R22; M `m/people/routes.ts`, `disconnect.ts`, `m/link/link.ts`, `order.ts`, `s/errors.ts` | T2; 5b T2 | SOFT `link.ts` |
| T4 | R30; M `peer-link.ts`, `peer-server.ts`, `visit-client.ts`, `keeper.ts`, `m/network/routes.ts`, `s/app.ts` | 5b T3; 5 T5; 3 T4's `Sql`. Paper T3 | HARD `keeper.ts` |
| T5 | C `m/copies/routes.ts`, `m/keeper/become.ts`; M `s/app.ts`, `worker.ts`, `join.ts`, `routes.ts`, `s/errors.ts`, `s/migrate.ts`, `updater.sh`, `compose.yaml`, `compose.worker.yaml` | T4; 7 T2; 5b T4 | HARD `updater.sh`, `worker.ts` |
| T6 | C `m/keeper/follow.ts`, `copy.ts`; M `s/keeper.ts`, `worker.ts`, `worker-config.ts`, `app-mode.ts`, `routes.ts`, `join.ts`, `s/main.ts`, `agent-sql.ts`, `updater.sh`, `t/real/pg.ts` | T4, T5 | HARD |
| T7 | R10; C `sync.ts`, `slots.ts`; M `keeper.ts`, `lease-store.ts`, `t/fake-lease.ts` | T4, T6; 3 T4; 5 T6 | HARD `keeper.ts` |
| T8 | C `t/real/pairs.test.ts`; M `t/real/pg.ts`, `pair.ts`, `.github/workflows/images.yml` | T4, T6, T7. Home-api; Q5 | none |
| T9 | M `copy.ts`, `follow.ts`, `m/merge/source.ts`, `merger.ts`, `check.ts`, `join.ts`, `s/app.ts`, `cutover.sql`, `carry.sql`, `m/backups/types.ts`, `restore.ts` | T6, T7; 8 T5, T6; 7 T4, T7 | HARD `copy.ts` |
| T10 | C `m/keeper/uploads.ts`; M `peer-server.ts`, `keeper.ts`, `follow.ts`, `worker.ts`, merge, routes, `join.ts`, `updater.sh` | T9; 7's paths | HARD |
| T11 | C `m/copies/view.ts`; M `m/nodes/routes.ts`, `w/types.ts`, `Machines.tsx`, en, ru | T1, T2, T7 | HARD `Machines.tsx` |
| T12 | C `t/lab/copies.test.ts`, `writer.ts`; M `lab.ts`, `steps.ts` | T1 to T11. Home-api | HARD `lab.ts` |
| A1 | M `keeper.ts`, `peer-link.ts` | 5b; T4 | HARD `keeper.ts` |
| T13 | runs all | | |

#### Plan 9b

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0067`; M schema, `rules.ts` | chain | HARD chain |
| T2 | R16; C `m/copies/measured.ts`; M `peer-server.ts`, `peer-link.ts`, `keeper.ts`, `worker.ts`, `state.ts`, `routes.ts`, `order.ts` | T1; plan 9 | HARD `keeper.ts` |
| T3 | R13; M `qualify.ts`, `order.ts` | T1; 9 T2; 5b's `onlineShare`. Paper T2 | HARD `order.ts` |
| T4 | M `order.ts`, `scope.ts`, `sync.ts` | T2, T3; 9 T3 | HARD `order.ts` |
| T5 | M `scope.ts`, `disconnect.ts`, `routes.ts`, `join.ts`, `copy.ts`, `worker.ts`, `follow.ts` | T4 | HARD |
| T6 | C `m/copies/priority.ts`; M `m/nodes/routes.ts`, `s/errors.ts` | T4 | SOFT |
| T7 | M `view.ts`, `m/nodes/routes.ts`, `w/types.ts`, `Machines.tsx`, en, ru, `w/theme.css` | T4, T6 | HARD `Machines.tsx` |
| T8 | M `t/lab/copies.test.ts` | T6. Home-api | none |
| T9 | runs all | | |

#### Plan 9c

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0068`, `t/switch-schema.test.ts`; M schema, `rules.ts` | chain | HARD chain |
| T2 | M `m/nodes/hub.ts`, `socket.ts`, `messages.ts`, `routes.ts`, `queue.ts`, `m/jobs/*`, `m/subscriptions/*`, `m/testruns/*`, `live.ts`, `m/tasks/reconcile.ts`, `wake.ts`, `follow.ts`, `s/main.ts`, `updater.sh`, `compose.worker.yaml`, `t/lab/copies.test.ts` | T1; 4 T4; 9 T5 | Wide SOFT: give it a quiet moment |
| T3 | R8 | `Term`. Paper T2 | none |
| T4 | C `m/keeper/promote.ts`, `t/real/switch.test.ts` | T1; plan 9's pair. Home-api | none |
| T5 | C `m/copies/move.ts`; M `order.ts`, `sync-step.ts`, `sync.ts`, `m/nodes/routes.ts`, `nodes.ts`, people, `m/updates/routes.ts`, `s/errors.ts` | T1, T3; 9b; 9 T7 | SOFT |
| T6 | C `m/keeper/taking.ts`; M `s/keeper.ts`, `follow.ts`, `keeper.ts`, peer routing | T3, T4; plan 9 | HARD `keeper.ts`, `follow.ts` |
| T7 | C `m/keeper/handing.ts`, `seed-view.ts`; M `keeper.ts`, `copy.ts`, `worker-config.ts`, `join.ts`, `updater.sh`, `peer-link.ts` | T3 to T6 | HARD |
| T8 | M `Machines.tsx`, `w/types.ts`, en, ru, `theme.css` | T5 | HARD `Machines.tsx` |
| T9 | R11; C `m/keeper/lead-update.ts`, `t/real/update-rollback.test.ts`; M `control.ts`, `keeper.ts`, `sync.ts`, `sync-step.ts`, `updater.sh`, stubs, `w/types.ts`, `UpdateProgress.tsx`, en, ru | T4; 9 T7 | HARD `updater.sh`, `keeper.ts` |
| T10 | C `m/keeper/updating.ts`; M `follow.ts`, `copy.ts`, `updater.sh`, `install.sh` | T9; plan 9 | HARD |
| T11 | C `t/lab/switch.test.ts`; M `lab.ts`, `steps.ts` | T6 to T8. Home-api | HARD `lab.ts` |
| T12 | R19 | p1 T10. Real | SOFT `relay.py` |
| T13 | runs all | | |

#### Plan 10

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0069`, `t/takeover-tables.test.ts`; M schema | chain | HARD chain |
| T2 | `beats.ts` rest; M `peer-server.ts`, `peer-link.ts`, `keeper.ts`, `follow.ts` | R9's types; 9c T6, T7 | HARD `keeper.ts`, `follow.ts` |
| T3 | R9 | R7. Paper T2 | none |
| T4 | C `m/keeper/proofs.ts`; M `keeper.ts`, `lease-store.ts`, `sync.ts`, `handing.ts`, `t/fake-lease.ts` | T2, T3; 9c | HARD |
| T5 | C `m/keeper/watch.ts`, `t/real/takeover.test.ts`; M `follow.ts`, `taking.ts`, `switch-step.ts`, `promote.ts` | T2, T3; 9c | HARD |
| T6 | R32; C `m/keeper/question.ts`, `m/recovery/routes.ts`; M `state.ts`, `follow.ts`, `keeper.ts`, `app-mode.ts`, `m/auth/routes.ts`, `s/auth/session.ts`, `lease-store.ts`, `s/app.ts`, layout, `w/api.ts`, en, ru | T3, T5 | HARD |
| T7 | C `m/keeper/led.ts`; M `copy.ts`, `follow.ts`, `keeper.ts`, `m/backups/routes.ts`, merge source, view, `updater.sh`, web, en, ru | T1, T5; 7, 8, 9, 9c | HARD |
| T8 | C `m/nodes/parked.ts`; M `messages.ts`, `m/tools/job.ts`, `read.ts`, `apply.ts`, `check.ts`, merger, `picks.ts`, `s/errors.ts`, `s/net/front-calls.ts` | T1, T7; plan 8; 4 T7 | SOFT `messages.ts` |
| T9 | M `m/link/link.ts`, `order.ts`, `join.ts`, `seed-view.ts`, link doors, `worker-config.ts`, `worker.ts`, carry, `restore.ts`, en, ru | T1; 9; 9c | SOFT |
| T10 | R31; C `m/network/switched.ts`; M `keeper.ts`, `follow.ts`, `worker.ts`, `s/app.ts`, layout, `w/api.ts`, en, ru | T2, T5, T6 | HARD |
| T11 | C `t/lab/takeover.test.ts`, `overlap.ts`; M `lab.ts`, `writer.ts` | all above. Home-api | HARD `lab.ts` |
| T12 | runs all | | |

#### Plan 11

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `0070`, `t/split-tables.test.ts`; M schema | chain | HARD chain |
| T2 | R15; M `measures.ts`, report route, `keeper.ts`, `follow.ts` | 5; 10 T2 | HARD `keeper.ts` |
| T3 | M `beats.ts`, `peer-link.ts`, `keeper.ts`, `follow.ts` | T1, T2; 10 | HARD |
| T4 | R12; M `switch-step.ts`, `taking.ts`, `lease.ts` | R9; 10 T5; T2, T3's types | HARD `takeover-step.ts` |
| T5 | C `m/keeper/alone.ts`; M `keeper.ts`, `watch.ts`, `taking.ts`, `promote.ts`, `follow.ts` | T1 to T4; 10 | HARD |
| A1 | M `t/watch.test.ts` only | T4, T5 | none |
| T6 | M `keeper.ts`, `proofs.ts`, `state.ts`, `order.ts`, `parked.ts`, `messages.ts`, `timers.ts` | T2 to T5; 10 | HARD |
| T7 | M `peer-link.ts`, `watch.ts`, `takeover-step.ts`, `alone.ts` | T3, T5; 10 | HARD |
| T8 | M `switch-word.ts`, keepers, `/api/machines`, `SwitchBanner.tsx`, `Machines.tsx`, `w/types.ts`, en, ru | T2, T3, T5; 10 T10 | HARD `Machines.tsx` |
| T9 | C `t/lab/splits.test.ts`; M `lab.ts`, `steps.ts` | all. Home-api | HARD `lab.ts` |
| T10 | runs all | | |

#### Plan 11b

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | R26; M `m/tools/mcp.ts`, `modeGate`, `state.ts`, `guardTools`, `front-calls.ts` | 2 T3; 4 T3, T7; 10's `CALL_WAITING` | SOFT |
| T2 | C `m/nodes/status.ts`, `net-state.ts`; M `pp/src/index.ts`, `socket.ts`, `hub.ts`, `messages.ts`, schema (`TASK_EVENT_KINDS`, no migration), `modeGate` | T1; 4 T4; 11's `split` | whole of all apps on `pp` |
| T3 | R24; `Saver`; M `n/main.ts` | T2's messages | HARD `n/main.ts` |
| T4 | R25; M `n/main.ts` | T2's `apart` | HARD `n/main.ts` |
| T5 | C `0071`, `m/recovery/here.ts`, `w/ui/GoOnHere.tsx`; M `question.ts`, `routes.ts`, `modeGate`, `keeper.ts`, `watch.ts`, `taking.ts`, `promote.ts`, `Shell.tsx`, `w/types.ts`, en, ru | T1, T2; 10 T6; 11 T5 | HARD chain, `keeper.ts` |
| T6 | C `m/network/split-side.ts`; M `queue.ts` | 11's handover. Paper T5 | SOFT `queue.ts` |
| T7 | C `m/tasks/away.ts`; M `reconcile.ts`, `engine.ts`, `tools.ts`, wake prompts, schema, `job.ts`, `mcp.ts`, `messages.ts`, `queue.ts`, `views.ts`, `m/merge/task.ts`, `timers.ts`, task page, `w/types.ts`, en, ru | T1, T2, T6; 8 T8; 10 | SOFT |
| T8 | C `t/lab/cut-off.test.ts` | all. Home-api | none |
| T9 | runs all | | |

#### Plan 13

| Task | Creates, changes | Consumes (from); paper | Collides |
|---|---|---|---|
| T1 | C `guide/network.md`, `wt/guide-words.ts`, `wt/guide-words.test.ts`; M `guide/README.md`, `README.md` | every string of 5 to 11b; `guide/backups.md` (7 T9) | none |
| T2 to T6 | M one or two guide pages each, `wt/guide-words.ts` | T1; strings. T6 needs 7 T9, 8 T9's `guide/backups.md` | HARD `guide-words.ts`, one writer |
| T7 | M `SECURITY.md`, `README.md`, en, ru, `wt/guide-words.test.ts` | 9 T11's `machines.copy` | SOFT |
| T8 | runs all | | |
| T9 | C `t/lab/netem.ts`, `lab-clock.cjs`, `compose-lab.ts`, `db-clock.Dockerfile`, `real-run.ts`, tests; M `machine.Dockerfile`, `lab.ts`, `writer.ts`, `t/pins.test.ts` | 5b T9; 10 T11. Paper T8 | HARD `lab.ts` |
| T10, T11 | C `t/lab/five.test.ts`, `clock.test.ts` | T9; 9c, 10, 11 | none |
| T12 | R21; C `t/lab/real-relay.test.ts`; M `lab.ts`, `compose-lab.ts`, `steps.ts`, `netem.test.ts` | T9; 11's `homes`. Paper T11 | HARD `lab.ts` |
| T13 to T17 | David's and Ivan's | | |

### Hot files

| File | Tasks, in landing order |
|---|---|
| migrations, `meta/_journal.json`, `s/db/schema.ts` | the chain above; then 11b T2, T7 (`TASK_EVENT_KINDS`, no migration). 11b T5's migration part goes with the chain |
| `HIDDEN`, `CLOSED` | 5, 5b, 6, 7 T1 in order |
| `m/merge/rules.ts` | R4; 9 T1; 9b T1; 9c T1 |
| `m/keeper/keeper.ts` | 2 T5, 2 T6, 3 T4, T5, 4 T7 (mapped); 5 T4, T6; 5b T4; 6 T4; 7 T5, T7, T8; 8 T7; 9 T4, T7, T10, A1; 9b T2; 9c T6, T7, T9; 10 T2, T4, T6, T7, T10; 11 T2, T3, T5, T6, T8; 11b T5. **27 later tasks: the true spine** |
| `m/keeper/follow.ts` | 9 T6, T9, T10; 9b T5; 9c T6, T10; 10 T2, T5, T6, T7, T10; 11 T2, T3, T5, T8 |
| `m/keeper/worker.ts` | 5b T4, T5, T7; 6 T4; 7 T6, T8; 8 T7; 9 T5, T6, T10; 9b T2, T5; 10 T9, T10; 11 T8 |
| `apps/updater/updater.sh` | 5b T5; 6 T4 (comments); 7 T4; 8 T6, T7; 9 T5, T6, T10; 9c T2, T7, T9, T10; 10 T7 |
| `scripts/install.sh` | 5b T6; 9c T10 |
| `compose.yaml` | 5 T4; 5b T6; 6 T4; 7 T4; 9 T5 |
| `w/screens/Machines.tsx` | 5b T8; 6 T6; 7 T9; 9 T11; 9b T7; 9c T8; 10 T7; 11 T8 |
| `s/net/peer-server.ts`, `peer-link.ts` | R3; R27; 7 T5, T6; 9 T4, T10, A1; 9b T2; 9c T7; 10 T2; 11 T3, T7 |
| `m/network/routes.ts`, `join.ts` | 5 T3; 5b T2, T5, T7; 6 T2, T4; 7 T3; 9 T2, T3, T5, T6, T9, T10; 9b T2, T5; 9c T7; 10 T9 |
| `m/nodes/routes.ts` | 5 T3; 5b T2, T8; 6 T2; 7 T3; 9 T11; 9b T6, T7; 9c T2, T5 |
| `m/nodes/messages.ts` | 9c T2; 10 T8; 11 T6; 11b T2, T7 |
| `m/copies/order.ts` | R14; 9 T3; 9b T2, T3, T4; 9c T5; 10 T9; 11 T6 |
| `m/keeper/takeover-step.ts`, `switch-step.ts`, `lease.ts` | R7; R8; R9; 10 T5; R12, 11 T4; 11 T7 |
| `m/keeper/copy.ts` | 9 T6, T9; 9b T5; 9c T7, T10; 10 T7 |
| `m/backups/routes.ts`, `restore.ts`, `types.ts` | 7 T3, T7, T8; 8 T6, T7; 9 T9; 10 T7, T9 |
| `s/app.ts`, `s/errors.ts` | Most server tasks. SOFT: add to lists at their own place |
| `w/i18n/en.ts`, `ru.ts`, `w/types.ts` | Every web task. SOFT; `i18n.test.tsx` at each landing |
| `t/lab/lab.ts`, `steps.ts` | 5b T9; 7 T10; 9 T12; 9c T11; 10 T11; 11 T9; 13 T9, T12 |
| `relay/relay.py`, `relay/test/harness.py` | p1 T10; R18; R19; R21 |

### Seams

| Rows or tasks | Check at landing |
|---|---|
| R1 and 5 T1 | `MachineRole` re-exported from `schema.ts`, `MACHINE_ROLES` the column's enum |
| R3 and 5 T3 | `VIA`, `OWN_VIA`, `Asker` the same; `peer-door` writes what `askerOf` reads |
| R3 and 4 T7 | `holdMs` through to `PassOptions` |
| R4 and each T1 | A table's rule exists when the table lands, `LATER` shrinks; `BOOKKEEPING` holds the new report columns |
| R5, R4 and 8 T3 | `read.ts` keeps R5's exports as they are |
| R7 and 3 T4's rest | `Held`, `Clocks` as `lease-store` and the keeper use them |
| R7 and R9 | Plan 3's table passes unchanged with the new inputs left out |
| R9 and 10 T2's rest | `Stance`, `Beat` are `Beats`' |
| R9, R12 and 11 T3 | `NormalView`, and `parseBeat` reading old beats |
| R8 and 10 T5, 11 T4 | `TakeSample.kind` and `foreign` added with their rows |
| R10 and 9c T9 | `hold` rows come first after `posting` |
| R11 and 9c T9 | `promise` in `UpdaterStatus`, the local union gone |
| R15 and R16 | Each `INTERNET_EVERY_MS` imported from its own file |
| R17 and 8 T6 | `BundleReason` gains `fork`; `Manifest` unchanged |
| R18 and R22 | `invalid`, `same_key`, 200 `{ key }`; `next` is 43 base64url, so `t/fake-relay.ts` refuses the same |
| R24 and 11b T2 | `Saved`, `net.state`'s `tasks`; slug `machineSlug`'s |
| R25 and 11b T2 | `apart` string or null |
| R27 and 5b T1 | `LinkPath` re-exported; path column's enum |
| R28 and 5b T1, T7 | `person_keys` fields are `StoredKey`'s; `KEY_ITERATIONS` the same on both sides |
| R31, R32, R33 and their tasks | The route's answer has the mocked shape |
| en, ru | Every new key in both; `i18n.test.tsx` |

## 4. Open questions for the lead

Each with a recommendation. Q1, Q2, Q4 and Q5 want a ruling in the ledger.

- **Q1. Plan 7's ruling 15.** Spec:748 says the restore screen lists plans sealed only to lost machines; the plan shows one line instead. **Recommend the plan's line, and tell David in `QUESTIONS.md`, as the spec binds.** Why: at that screen the survivors have not said hello yet, so a list would name plans that are fine, and the Plans tab already says "Signed in on <machines> only" once they have. Cost if wrong: one small route and a list on the last screen, in 7 T9, or later. Decide before 7 T9; it stops nothing earlier.
- **Q2. May the T1s go ahead as one lane?** After 4 T1, one writer takes 5 T1, 5b T1, 6 T1, 7 T1, 8 T1 and, once R4 lands, 9 T1, 9b T1, 9c T1, 10 T1, 11 T1 and 11b T5's migration part, in one or two batches with one whole-suite run each. **Recommend yes.** It ends the one thing that keeps plans in a line: 5 T3, 5b T2, 6 T2, 7 T3, 7 T4, 8 T3, 8 T5 then wait only for code they really use. Tables nobody uses change nothing, and nothing ships before the series' merge. Cost if wrong: a table's shape found wrong later takes a further migration rather than a change in its plan's own one, and the "number + 11" rule then shifts by one for what follows. Each T1's shape is exact in its plan, so that is unlikely.
- **Q3. Split tasks for lanes.** `parallel-map.md`'s ruling 6 said yes once writers are idle, for three named pieces. **Recommend yes for every row here,** with one rule: a part lands with its own tests, its ledger line says `part`, and the remainder stays the plan's task with its Done when. A `Done when` that lists tests of the remainder runs at the remainder.
- **Q4. 11b T3 touches agents' folders as the node. A security gap in the plan's text.** `n/agent-fs.ts:8` says agents can put a link anywhere in their folders, and `86a5e8fa` made skills find repositories as the agent's user for that reason. The plan has `clonesOf` read those folders, takes `user` from `stat` of the folder, and copies `.git/index` and removes the copy without saying as whom. On a node that runs as root, a link at `<key>/<name>`, at `.git/index` or at `.git/hornhoof-index-<pid>` would have the node read or write what it points at, and a link to a folder of another owner would run git, with that clone's own config, as that owner. **Recommend this ruling for R24:** on a root node, `lstat` each level, refuse a link, refuse uid 0, run all as that folder's agent user, never root; do the index copy and its removal as that user too. `AgentFs` (`read`, `write`) is text only and the index is binary, so a small copy step run as the user is needed. Readers: two, as security class. Cost if wrong: one more helper.
- **Q5. 9 T8's arm64 half.** The task's Done when is "on the team lead's Mac", both architectures by Docker Desktop's emulation; here it would be home-api, and Ivan's real pair is an amd64 Debian and an arm64 Mac, so it matters. Installing QEMU's handlers changes that host's kernel for everything on it, outside `hnb-`. **Recommend:** when plan 9 nears, read `/proc/sys/fs/binfmt_misc` on home-api; if `qemu-aarch64` is there, run both; if not, run amd64 pairs, do not install anything, and hand the arm64 run to David in `QUESTIONS.md`. Not checked here: I did not go to home-api.
- **Q6. Plan 13's guide tasks now?** **Recommend no,** until 11b's strings land (section 1). They are also a good last job for Antigravity or Sonnet. Plan 13 T12's Hornhoof half and `lab.Dockerfile` wait too.
- **Q7. `MachineRole`, `LinkPath`, `DataMachine` declared in the first file that needs them, then re-exported by their owner's task.** **Recommend yes,** in preference to touching `schema.ts`: a lane on `schema.ts` meets the chain and runs nearly the whole server package. Cost: one line each.
- **Q8. R20's slow test.** 70 s and 300 MiB per run, in every `discover`. **Recommend keep it as the plan has it.** Per-task checks name their modules, so it runs only at plan and batch checks, on home-api.
- **Q9. R14 is partly thrown away by 9b T3.** **Recommend last,** or leave it to plan 9 unless writers are truly idle.
