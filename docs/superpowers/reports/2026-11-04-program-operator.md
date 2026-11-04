# Program operator verification

Task #245 implements part A of #234. The rewritten task body overrides the original design proposal. The role and procedure from #246 are integrated; the role uses the independent protocol export.

## Behavior

- `program_screen`, `program_keys` and the operator reporting form require the current Operations employee, running operator job, company and assigned case. The target is an existing personal agent program. Every key is journaled with its actor, reason and outcome; permission decisions include the native question. Denials go to the target department head with a case picture.
- Five evidence-based reasons create durable cases. Assignment clocks start before readiness; queued/held transport acceptance is not uptake. First own activity permanently disarms the initial activity clock. Finalized live failures retain their identity through fallback. Unknown outcomes cannot mask a later known failed run or duplicate an already consumed incident.
- The node permits six individual menu keys only after a fresh snapshot and short preparation lease. Native evidence, question identity, case revision and pane generation are rechecked in the agent input lane. Protected screens and known secrets, including wrapped/encoded secrets, are withheld before transmission. Escape, text and paste are refused.
- Evidence and compound observer transitions commit before publication/ACK. Key intent commits before the write; an uncertain write is never retried. A lost `agent.unheard` is repaired from durable delivery evidence and an exact source digest, with a transactional fallback marker and job-row authority lock.
- Pre-work recovery is bounded and leaves the pane available to its owner. Owner recovery creates or adopts one continuation; recorded original words prevent a second paste. Operator timeout before server expiry still preserves that recovery path. Cancellation during readiness remains cancellation, without a failure payload. Exact source activity follows an owner continuation, including a typed turn that finishes before its server acknowledgement. Late proof does not clear a newer native question. A repaired program with no session ID is reused; actual physical replacement retires the old clocks.
- Generated migration `0057_program_operator` follows 0054 notification provenance, 0055 waits and 0056 obsolete wakes. It contains common structures only. Forward migration preserves existing company, people, subscription, agent, job, event and attachment bytes; repeated migration is harmless.

## Checks

Full logs and independent review reports are attached to task #245. Commands ran on Linux with Node 22, npm ci after the renderer dependency merge, and no Docker or release workflow.

| Check | Evidence |
| --- | --- |
| Protocol | `npx --no-install vitest run --root packages/protocol test/program-operator.test.ts --maxWorkers=1`: 12 passed; protocol build exit 0. |
| Server | Explicit 26-file affected cohort on the merged branch: all 492 passed. The earlier procedure-wording failure was corrected; all 58 template checks also passed separately. No assertion was removed or weakened. |
| Node | Explicit 47-file affected cohort on the merged branch: all 672 passed. An earlier readiness-cancellation regression was reproduced and fixed; its separate 26-test cohort also passed, including the unchanged response deadline and no-prompt/panel assertions. |
| Durable fallback and migration | Five-file foundation cohort with coverage: all 32 passed, 100% measured lines. Lost unheard/source-late tests first failed, then passed; invalid source text and digest never create a replacement. |
| Native owner/question flow | Actual Linux tmux with deterministic provider fixtures: approval, denial, stale-question refusal, key/start race, owner recovery once, original paste once and harmless source replay. Final source/host/controller coverage cohort: 160 passed across seven files, after red regressions for source binding, physical replacement and delayed owner acknowledgement. |
| Types/build | `npm run typecheck:tests`, node production tsc and server build exit 0. Built server includes both bundled fonts and their license. |
| Lint | ESLint on 72 changed TypeScript files exit 0. Final cancellation host/test check exit 0. Whitespace checks exit 0. |
| CRAP | Every new feature module and 24 new host helpers below 10; maximum 9.889. Foundation max 9.3; control server max 9.0. Existing large integration functions were not rewritten for this feature. |
| Dryer | Threshold 0.8 across node operator modules, server operator modules and protocol: no duplicate candidates. Host/controller comparison also clean. |
| Independent review | Eight initial tools findings and the later fallback, cross-job authority, timeout-ordering, pending-prefix and wrapped-secret findings were corrected. Follow-up source review has no remaining important/blocking finding. Review did not substitute for test execution. |

The earlier loaded server cohort had a 20-second tasks-wake timeout. Its isolated repeat and later complete server cohort passed it without a threshold change. An earlier Antigravity receipt failure under coverage was followed by successful isolated and integrated receipts; the final cancellation failure above had a reproduced code cause and a specific fix.

The CEO's updated rule moves mutator to turn review. No new mutator run was started after that instruction. Earlier selected controller results were 24 killed and seven survivors; these are retained for the turn reviewer, not presented as exhaustive mutation success. Other completed bounded reports are retained too.

## Limits

Provider compatibility uses deterministic native fixtures and source formats, not a new paid/live capture of every installed provider binary. A visual operator still judges unseen dialogs; code blocks known protected states and native working states.

Local file tests prove complete snapshots, rollback, permissions and Linux fsync ordering, not survival of an actual power cut. Directory flush failure after rename is uncertain and reported. Compact retired-case identities remain permanently retained; legacy orphan action records are conservatively retained.

Shared database locks and node-local short leases serialize ordinary role revocation through input dispatch. A server crash or lost database lock after dispatch cannot provide instantaneous global revocation of an already authorized packet. PGlite cannot prove PostgreSQL multi-connection scheduling. The protocol has no trusted total epoch across physical instances of the same job; stale prior-job instances are rejected using the current job/node identity.

Main is not an integration target. Task #245 targets turn-7 under its stated submission workflow.
