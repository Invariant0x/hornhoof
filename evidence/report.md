# Task64: six jobs, READY/accept/done/pane correlation

## Result and limits

Reviewed source: `bd696b0724385b6b11da53a24ada2f188b031217`. This is a diagnostic report, not a product fix, not a change to the 120 second budgets, and not an addition to #14 or #62. The historical server phase is **UNKNOWN for all six selected jobs**. The published evidence supports a compaction timing association, not a causal timeout, kill, OOM or dead-pane conclusion.

Inputs are the safe values in #64/#12 and the accepted #39 diagnosis. The selected eleven-job JSON is not an exhaustive collector snapshot. Its named Codex path was unavailable here, so there was no repeated filesystem search. Agent IDs were checked against a current `company` read; that read does not attest a historical subscription, provider assignment, node version or CLI version. No raw tails, reasoning, credentials or environment snapshots were used.

Durations below were recomputed from the published UTC values. `response_not_observed` means only that a response was absent from the bounded observation. Public `failed/agent_failed` is an outcome, not an exit code, signal, kill or host phase.

## Per-case evidence

Common gap **G**: no per-job host phase/`goesOn`, READY start/end/result, prompt paste/Enter/ack, accept start/end/result, pane probe value/query result, wire cursor/session/native-turn join, or attested historical node/CLI version. The closest existing producers are mapped below.

| Case | HH job and agent | Start -> failure UTC, seconds | Exact available native/source join | Phase and concrete gap |
|---|---|---|---|---|
| F4ec | `4ecda2c7-6620-4cff-8be3-ee701329abb1`; Frontend `2e1c0f89-4419-4a89-a329-7e59f0943ae2` | 03:16:24.745 -> 03:18:26.925; 122.180 | Ops compaction request 03:16:29.400; HH failure 117.525 s later; `response_not_observed`; next log record config turn6.1 at 03:18:33.382. Selected11 HH job/event join. | UNKNOWN; G. The next config record and absent response do not prove process death or a timeout branch. |
| F8c | `8c716fba-0f20-4244-a247-88a84a656534`; Frontend `2e1c0f89-4419-4a89-a329-7e59f0943ae2` | 04:12:56.009 -> 04:14:58.164; 122.155 | Compaction request 04:13:00.675 -> response 04:15:03.186 = 122.511 s; reported stream 102.7 s is another interval. Response is 5.022 s after HH failure. Selected11 HH job/event join. | UNKNOWN; G. A later compaction response does not identify READY, accept, done or pane state at HH failure. |
| A | `d6b23636-3d86-44d4-a722-ae86de819284`; Architect `9be8a973-8c8f-4f7f-ba04-12066e05e812` | 04:12:56.010 -> 04:14:58.276; 122.266 | Selected11 HH job/event join and Ops bounded compaction association; `response_not_observed`. Exact native request/turn is not published. This is not cancelled backend job `d6b1e53c`. | UNKNOWN; G plus exact native request/turn correlation. |
| R | `33f7c99d-5204-4b98-a3f4-1a98c2629919`; Reviewer `100edb09-da27-4868-9646-5c0118b9934e` | 04:12:56.019 -> 04:14:58.375; 122.356 | Selected11 HH job/event join and Ops bounded compaction association; `response_not_observed`. Exact native request/turn is not published. | UNKNOWN; G plus exact native request/turn correlation. |
| H | `976d9002-e947-4394-8d19-a145b35d3bba`; Head of operations `658c7274-0cc3-44a7-af27-71eb7ef9dee5` | 04:12:56.021 -> 04:15:01.866; 125.845 | Compaction response 04:14:16.522, 45.344 s before HH failure. Exact native request/turn is not published. Selected11 HH job/event join. | UNKNOWN; G. Completed compaction does not select the later failure phase. |
| D | `4a7d01d1-9509-428d-be46-e477b17232a0`; DevOps `fbb993b2-da33-4b5d-8304-a3e5ebf15d61` | 04:51:15.992 -> 04:53:17.559; 121.567 | Selected11 HH job/event join and Ops bounded compaction association; `response_not_observed`. Exact native request/turn is not published. | UNKNOWN; G plus exact native request/turn correlation. |

F8c/A/R/H HH starts span 12 ms. The separate Ops CLI request span of 588 ms is not the HH start span. The five other quota-linked HH jobs in the selected eleven are outside this six-case table. Backend native12 and Frontend native9 remain unattributed to an HH job. Kimi job `9522dbd8` completed successfully after a 113.082 s compaction, so compaction alone does not choose failure.

## Actual source map

The map applies to the reviewed source snapshot. It does not prove that every historical incident ran this exact node image or CLI build.

| Path | Existing behavior and wait origin | Observation that would distinguish it |
|---|---|---|
| Dispatch and outer budget | `apps/server/src/modules/conversation/queue.ts:22-24` sets conversation `TURN_TIMEOUT_MS` to 7,200,000 ms. `apps/server/src/modules/jobs/dispatch.ts:36-53` sends the job and timeout. The separate 120,000 ms at `dispatch.ts:8-10` is for test jobs. | HH `startedAt` is not the start of either host 120 s wait. Need node receive/launch and phase timestamps correlated to `jobId`. |
| Terminal outer timeout | `apps/node/src/main.ts:181-207` routes terminal work through `TerminalHost`; `main.ts:200` passes `untimed=true`. `apps/node/src/runner.ts:164-165` therefore does not wrap the terminal run in `withTimeout`. `host.ts:229-230` uses `input.timeoutMs` only while waiting for an earlier busy turn. | A roughly 122 s terminal failure is not explained by the 2 hour conversation budget. Need the actual host return path. |
| READY wait | `apps/node/src/terminal/host.ts:179-185` defaults `readyMs=120000`. After launch/watch, `ready()` starts a new budget at `host.ts:436-454`. Kimi READY is `/context: \d+%/` at `host.ts:134-138`; alive is checked before the screen at `host.ts:439`. Failure returns through `host.ts:283-287`. | `ready.wait.start/end`, result (`matched`, `deadline`, `signed_out`, `pane_dead`, `query_error`), and proof whether paste occurred. A stale context footer in history is not a current READY observation. |
| Screen and pane probe | `apps/node/src/terminal/tmux.ts:85-89` issues `display-message -p ... #{pane_dead}` and treats nonzero or query failure as not alive. `tmux.ts:115-118` captures 200 lines and returns an empty string on capture error. This snapshot does not retain exit status or signal here. | Need probe UTC, `pane_dead`, query success/error, and, when separately implemented, exit status/signal. Boolean `alive=false` alone conflates dead pane and probe failure. |
| Prompt send and accept wait | `host.ts:299-304` pastes, waits 300-3000 ms, sends Enter and marks busy. Only then does the accept budget start at `host.ts:308-316`. Its expiry has the explicit `The program did not take Hornhoof's prompt within ...` result at `host.ts:313`. `tookPrompt()` has a separate default 4000 ms retry interval at `host.ts:424-431` and also returns true on end, abort or not alive. | Paste/Enter UTC, accept start/end/result and ack source. The prefix can be lost from a retained tail, so its absence is not a negative proof. |
| Prompt ack and wire | Kimi hook `prompt` sets `a.took` at `host.ts:595-600`. Actual wire `turn.prompt` maps to `started` at `apps/node/src/terminal/transcripts.ts:155-166`, then `host.ts:530` sets `busy` and `took`. `host.ts:457-465,477-480` finds wire by session and uses `LineTail`; `transcripts.ts:6-31` tracks byte offsets and returns no lines when size <= offset. The accepted #39 synthetic shrink result is not evidence that historical compaction rewrote wire. | Ack source (`hook` or `wire.turn.prompt`), session ID, native turn ID if present, wire path hash, offset/size before/after and record type. No raw wire or prompt is needed. |
| Done loop and dead pane | After accept, `host.ts:318-349` has no READY/accept 120 s deadline. Wire failure becomes `a.failure` at `host.ts:531-543`; the loop returns `agent_failed` at `host.ts:326-328`. A false alive probe reaches `host.ts:343-347` and also returns `agent_failed`. | Need `done.wait.start`, last ack/wire cursor, pane probes and final reason. Absence of an accept prefix cannot distinguish done-loop wire failure from dead pane or READY. |
| Result persistence | `apps/node/src/runner.ts:175-183` creates `job.done` and keeps only the last 4096 output bytes; `packages/protocol/src/index.ts:11-12` defines that bound. `apps/server/src/modules/nodes/messages.ts:100-119` stores status, generic error and bounded tail. | Existing API metadata cannot reconstruct an unrecorded host phase. Need a correlated phase event before the generic `job.done`. |

## Differential fixture on actual source

Command, run from the worktree:

```sh
node --experimental-transform-types --experimental-loader ./evidence/source-loader.mjs ./evidence/phase-fixture.mjs
```

The fixture imports the actual `TerminalHost`, `Tmux`, Kimi program and transcript code. A loader supplies only missing package/constants stubs, with no package installation. `node:test mock.timers` controls Date/setTimeout/setInterval. The actual `Tmux.alive()` implementation runs against an isolated `run()` stub returning `pane_dead` and screen values. The actual `LineTail`/`findKimiWire` reads one synthetic `turn.prompt` record. No real tmux, network, CLI or model call occurs.

Final output: `PHASE_FIXTURE_PASS scenarios=3 READY_ACCEPT_DEAD_PANE_DISTINCT modelCalls=0 networkCalls=0`.

| Synthetic branch | Actual observed signature |
|---|---|
| READY wait, live pane, no READY footer | `agent_failed`; launch=1, prompt paste=0, Enter=0, pane_dead=false, accept prefix=false. This is distinguishably before prompt accept. |
| Prompt accept wait, live pane, no wire start | `agent_failed`; launch=1, prompt paste=1, Enter=20, pane_dead=false, accept prefix=true: `The program did not take Hornhoof's prompt within 2 s.` |
| Done loop after actual wire accept, then pane_dead=1 | Fixture observed `tookBeforeDead=true`; `agent_failed`; prompt paste=1, Enter=1, pane_dead=true, accept prefix=false. |

The first harness attempt stopped with `ERR_MODULE_NOT_FOUND: zod` from an unused `state.ts` import. A local loader-only zod stub fixed module loading. The final run passed all assertions. The fixture demonstrates branch distinguishability on actual source, not historical reproduction of any of the six jobs and not proof that an old footer, wire shrink or dead pane caused them.

## Minimal future correlated trace contract

This is a **planned interface for a separate implementation brief**, not an existing recorder and not a change made by #64. Do not add it to #14 or #62 under this report.

Every record should carry a small common envelope:

```json
{
  "trace": "hh-terminal-phase-v1",
  "jobId": "existing HH UUID",
  "agentKey": "existing agent UUID",
  "sessionId": "existing or null",
  "nativeTurnId": "existing or null",
  "atUtc": "event UTC",
  "phase": "launch|ready|accept|done",
  "event": "wait_start|wait_end|paste|enter|ack|pane_probe|wire_read|finish",
  "result": "bounded enum or null",
  "nodeVersion": "attested or null",
  "cliVersion": "attested or null"
}
```

Use bounded additional fields only for the relevant event:

- Launch: `goesOn`, `sameSession`, `hashMatch`; nearest producer `host.ts:248-277`, with `jobId` passed from `main.ts:181-200`. Current `TermJob` does not carry the owning HH job ID.
- READY/accept waits: `budgetMs`, `startedAt`, `endedAt`, and result enums from the actual branches at `host.ts:436-454` and `host.ts:308-316`. Accept ack additionally records `source=hook|wire.turn.prompt|ended|aborted|pane_dead|unknown`.
- Pane probe: `paneDead`, `queryOk`, bounded `queryErrorCode`, and optional `deadStatus`/`deadSignal` only when an independently approved producer actually supplies them. Nearest producer `tmux.ts:69-89`; do not infer exit metadata from this boolean.
- Wire read: `pathHash`, `offsetBefore`, `offsetAfter`, `sizeBefore`, `sizeAfter`, `recordType`, and `nativeTurnId` when present. Nearest producers `transcripts.ts:6-31,155-183` and `host.ts:457-543`. A token count is not a lifecycle event.
- Finish: `reason=ready_result|accept_result|wire_completed|wire_failed|pane_not_alive|cancelled|signed_out`, plus the existing public outcome. Nearest producers `host.ts:283-349`, `runner.ts:175-183` and `nodes/messages.ts:100-119`.

Do not record prompt text, screen contents, raw wire, reasoning, auth, environment or full paths. Keep enums and numeric bounds fixed, use a path/session hash where correlation needs it, and preserve the original event order per job. The minimum useful causal sequence is `jobId + ready result + paste/accept result + final pane probe + wire cursor/session + attested source versions`.

## Conclusion

The six historical cases remain phase-unknown. The fixture proves that READY wait, prompt accept wait and an actual dead-pane branch can be distinguished with existing code when the right observations exist. It does not choose any of them for the incidents. A cause-specific fix or timeout change is not justified by this cohort. The next safe step is a separately approved correlated trace producer, followed by a future controlled run; this report neither runs that producer nor closes #12 as fixed.
