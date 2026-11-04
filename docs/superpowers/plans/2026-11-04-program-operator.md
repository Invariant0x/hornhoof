# Program Operator Implementation Plan

> **For agentic workers:** Use executing-plans to implement these tightly coupled increments with test-first checks. The task and selected design are already approved by the department head.

**Goal:** Let the Operations program operator inspect an incident's agent program and apply one guarded menu key, with durable receipts, four precise invocation reasons, audit and bounded escalation.

**Architecture:** Nodes own program evidence, monotonic delivery clocks, snapshots and the final key guard. The server owns durable deliveries, evidence deduplication, cases, action intents, pictures and routing. Preserve existing conversation delivery and queue semantics; add an independent protocol subpath without changing protocol/index.ts or tools/mcp.ts.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres/PGlite, tmux, Vitest, resvg PNG rendering.

**Spec:** Hornhoof #245 body (head decision, 2026-11-04), selected #243 design-243-codex.md downloaded to ../task-245-evidence/design-243-codex.md. The task body overrides the design wherever they differ.

## Global Constraints

- PROGRAM_OPERATOR_ROLE = 'OPS-PROGRAM'. Role, company, assigned case and target checks run in each handler, independently of removable grants.
- Keys: Enter, Up, Down, Left, Right, Tab, one per fresh snapshot. No Escape, control keys, text or paste.
- A case lasts 600000 ms from opening; actions do not extend it. Snapshot lifetime 30000 ms, one read per second and at most 20 key actions per case.
- Assignment receipt alarm at 60000 ms from node attempt, including readiness. Initial assignment is never pasted into an unknown screen.
- First activity alarm at 300000 ms after an assignment receipt, permanently disarmed by the first own event. Screen/status changes are not activity.
- Three consecutive finalized unsuccessful live deliveries trigger once per streak; taken resets it. Preserve delivery identity on fallback/requeue. held, queued and agent.said(ok) do not prove taken.
- Startup exit within 60000 ms of actual launch/launch failure, before own activity; exclude normal completion, cancel, update, intentional restart and offline machines.
- Pending evidence and execution intent survive reconnect/restart. A lost action result is unknown, never an automatic key retry.
- Only pre_work or an authenticated, current harmless input wait permits keys. Permission/consent/login/payment and thinking/tool/retrying never do. Revalidate after awaits immediately before tmux write in the agent's serialized lane.
- PNG is the existing pane, bounded to 1 MiB; cells at most 64 KiB. Redact on node before send and server before storage; use bundled Latin/Cyrillic monospace font.
- Missing operator/plan or a stuck operator escalates immediately. Pre-work deadline ends that job once with agent_failed; working turns remain running. Escalated recovery holds automatic continuation until safe owner recovery.
- Source program_operator follows #242 metadata. Read operator role from persisted data; do not import part B's subscription module.
- Structural generated migrations only, no company data/access grants. Coordinate migration order after #242/#241.
- English code/comments/commits, no em dashes; EN/RU human text where shown. Commit as Ivan Korol without trailers. Only focused tests, Linux, no Docker or release workflow; submit then merge turn-7, never main.

## Review Focus

- Evidence replay/out-of-order channels cannot reopen a consumed incident or move a monotonic deadline.
- Live fallback may create a next-turn assignment but must not count one live delivery twice or lose audit identity.
- Permission arriving during an awaited snapshot/key check must prevent the actual tmux key.
- Disconnect after key execution must not repeat the key when the same action is retried.
- Operator unavailability/deadline must not poison a whole subscription or cancel a working target.

### Task 1: Add the independent protocol

**Files:** packages/protocol/src/program-operator.ts, packages/protocol/package.json, packages/protocol/test/program-operator.test.ts.

**Interfaces:** Strict OperatorNodeMessage/OperatorServerMessage schemas, delivery metadata, reason/key enums, role/bounds; local transport wrappers consume these without editing index.ts.

- [ ] Write tests for valid delivery/launch/case/snapshot/key/ack frames and strict rejection of malformed IDs, oversize cells, invalid phases, Escape/control/text and bounds.
- [ ] Run `npm test -w packages/protocol -- test/program-operator.test.ts`; expect failure before implementation.
- [ ] Implement schemas and subpath export with the exact values above; preserve old frame parsing in later wrappers.
- [ ] Repeat focused tests and `npm run build -w packages/protocol`; expect exit 0.
- [ ] Commit the protocol increment.

### Task 2: Durable node evidence and final key guard

**Files:** new apps/node/src/terminal/operator-observer.ts, operator-control.ts and focused tests, then host.ts/program-restart.ts hooks.

**Interfaces:** Observer records launch/attempt/receipt/activity/finalized uptake and replays an acknowledged durable outbox. Controller receives case capabilities and returns snapshots/results using a per-agent lane and current evidence state.

- [ ] Write fake-clock tests at 59999/60000 and 299999/300000; queued vs taken, activity before receipt, hours of silence after first activity, cancellation/exit exclusions, duplicate replay and persisted elapsed state.
- [ ] Write guard tests for every denied state/key, fresh snapshot/instance/hash/generation, protected screens, action conflict/replay/unknown and redaction before send; add a real Linux tmux event-race test.
- [ ] Run these tests red; implement bounded durable storage, observer and controller; run green.
- [ ] Integrate provider hook/log receipts and initial assignment attempt before ready. Preserve the pane while waiting for an operator; paste the assignment once after recognized readiness, and retain pending-word ownership until a receipt.
- [ ] Run the new tests plus affected terminal-host receipts/setup/say/watch suites; commit.

### Task 3: Server persistence, evidence validation and case lifecycle

**Files:** apps/server/src/db/schema.ts, generated drizzle migration, new modules/program-operator/{deliveries,evidence,cases,recovery}.ts and focused tests.

**Interfaces:** ReserveDelivery returns {id,ordinal}; acceptEvidence validates node ownership/instance/prerequisites and acks only after commit; case creation/routing/expiry is durable and idempotent.

- [ ] Write tests for four reasons and unmet prerequisites, ordered live streak with taken reset, duplicate/out-of-order facts and restart, one open case per instance, no operator/plan and operator self-failure, exactly one wake/outcome at expiry, harmless old-schema migration data preservation.
- [ ] Run red; implement company/agent locks, bounded evidence, unique keys, ordered outcomes and transactional case/wake insertion with source program_operator.
- [ ] Generate a structural migration after incorporating coordinated #241/#242 schema history; test fresh and forward migration.
- [ ] Implement safe recovery continuation: hold automatic requeue after escalation, resolve on matching receipt, owner readiness creates/adopts one continuation, late old receipt prevents duplicate paste.
- [ ] Run focused lifecycle/recovery tests green; commit.

### Task 4: Transport and conversation integration

**Files:** node connection.ts/main.ts; server nodes/hub.ts/messages.ts; conversation/queue.ts/live.ts/unheard.ts; agents/timers.ts; tasks/failures.ts.

**Interfaces:** Additive operatorDelivery metadata in job.run/agent.say, programOperatorV1 hello capability, authenticated operator frame transport and RPC responses. Existing old nodes retain existing schemas/behavior.

- [ ] Write tests for optional metadata preservation through parsing, old-node refusal, durable reconnect/ack and wrong-node responses; prove a comment uses the common live path and survives fallback with the same live delivery ID.
- [ ] Run red; wire wrappers/RPCs and host routes, reserve delivery identity before dispatch and retain pending source data.
- [ ] Replace the old three-in-an-hour unheard alarm with finalized ordered streak evidence; retain requeue behavior and suppress duplicate notifyFailure.
- [ ] Wire deadline checks and escalated-case failure/hold handling while preserving #239 failure/state/tail and #241 delivery changes.
- [ ] Run affected connection/hub/message/live/unheard/queue/failure/timer tests green; commit.

### Task 5: Screenshots, operator tools and audit

**Files:** new server modules/program-operator/{screen,actions,report}.ts; tools/program-operator.ts; tools/watch.ts; tasks/attachments.ts; renderer dependency/font/license and lockfile; focused tests.

**Interfaces:** program_screen, program_keys and narrow tell_orchestrator registration only for OPS-PROGRAM; persisted intent before send; case-bound picture authorization for assigned operator/orchestrator.

- [ ] Write tests for role/grant/current employment and case ownership, cross-company/self/login/API-only targets, PNG signature/dimensions/nonempty bytes/Cyrillic/redaction, action journal/refusal/unknown and exact-once needs_owner/failed report with picture.
- [ ] Run red; install the approved renderer dependency and bundle the font/license, then npm ci. Implement bounded SVG text rendering with control/OSC stripping and two-stage masking.
- [ ] Register tools from watch.ts, recheck live identity/case on every handler; persist request/journal before dispatch, resolve the outcome and target/operator audit after reply without retrying an uncertain write.
- [ ] Run tools/picture/attachment/audit and relevant watch-tools tests green; commit.

### Task 6: Integration proof and finish

**Files:** focused integration tests, evidence logs and any coverage-driven fixes within the assigned feature.

- [ ] Prove unknown-screen recovery end to end: no paste, one case at 60 s, one safe key, one assignment paste and actual receipt; real tmux race sends no key after program starts.
- [ ] Run security review of every capability boundary, action idempotency, sensitive-screen path, attachment authorization and durable evidence path. Record residual visual-classification risk plainly.
- [ ] Run focused coverage, crapper <10, dryer threshold 0.8 and mutator from repository root on changed lines; do not weaken surviving checks.
- [ ] Run protocol/server/node tsc, lint, typecheck:tests and all affected suites after final changes; retain complete output. Whole-branch independent review, fix blocking findings with red/green tests.
- [ ] Push task-245, submit the evidence, merge fresh turn-7 after resolving peer changes and submit the merge. Keep main untouched.
