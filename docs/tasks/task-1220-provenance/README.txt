Task 1220: provenance clarification

This evidence-only branch does not change task-1220 or its candidate b0b972aa75fbfa31a6f0b0decf500858ea68278a. No tests, builds or quality commands were repeated for this clarification.

Primary records

The original author session retained timestamped tool calls and tool outputs. tool-events.jsonl contains the relevant original command, mutation and completion records, with their source line numbers and call ids. It is an extract, not a newly invented per-run receipt. Unrelated session data is excluded. The source commands include the shell wrapper, working directory, patches, migration generation and the candidate commit command.

provenance.json binds each original raw-log SHA-256 to that command and its actual terminal exit receipt. The raw logs are identical to their entries in task-1220-checks-b0b972aa7.zip, attachment c039adc7-8795-4f99-85a0-795e7b158f59, SHA-256 75072b731f299fb5902caeee26da17d410f1c95fa01cf52a6478edc9a3ad47fd. They were not edited to add headers. git-history.txt was read during this audit; it establishes commit order, not a source fingerprint taken at test launch.

Working states

- The earlier head-migration-green.log is a failed attempt: exit 1, three failures. It is not used as PASS. The head test expected one applied event after adding team removal and expected forged authorship fields to be accepted; the migration seed lacked model. The original repair is recorded at 08:01:51 UTC.
- server-core-green-2.log started on HEAD dd4b7b628f7e08160ca728827542d64f588b7aa5 with uncommitted task changes. Its runner says 08:01:56 UTC; terminal receipt is exit 0, 41 passed. The server sources, migration files and server tests already matched the final candidate. Subsequent recorded writes affected AgentCard.tsx, the browser scenario/config and the plan only.
- changeAuthor was extracted at 08:02:27 UTC, during the core run. This changed only apps/web/src/ui/AgentCard.tsx: the Messages type import, the new helper and replacement of the inline ternary. It did not change server code.
- callers-green.log started in the 08:04:18 tool frame, runner 08:04:22, on the same HEAD with working changes, after that extraction. It ended with exit 0, 124 passed. Its server inputs matched the candidate. Only the browser API fixture and the plan were edited later.
- browser-green-2.log was launched in the 08:05:57 tool frame, after the last browser fixture/plan patch and before the candidate commit in that same ordered frame. All 24 candidate paths already had the final candidate bytes. HEAD moved from dd4b7b628 to b0b972aa7 at 08:06:01, during this process; committing changed no source bytes. The process ended with exit 143 after twelve individually passed cases. It is not a full-process PASS.
- browser-remaining-1.log and browser-remaining-2.log started on HEAD b0b972aa75fbfa31a6f0b0decf500858ea68278a at the 08:10:07 and 08:12:23 tool frames. No tracked source was edited afterwards. Their real terminal receipts show exit 0, eight passed and four passed.

The provenance JSON contains exact commands, working directories, session ids and original completion responses. recordedAt on a launch is the enclosing tool-frame timestamp, not a separately measured shell process start. Completion timestamps are when the retained receipt was read, not a fabricated process-end time.

Reconstruction and limits

The three *-from-candidate.patch files and snapshot hashes were computed now by reversing the exact later recorded text patches, in memory, from the pinned candidate. They are explicitly retrospective. They are not hashes captured at launch or an independent test run. Applying one to an isolated copy of the candidate reconstructs the described earlier tracked-file state.

The reconstructed core state differs from the candidate in four paths: AgentCard.tsx, browser config, browser scenario and the plan. The callers state differs in only the browser scenario and the plan. The earlier full card run also precedes the server fixture repairs and has six differing paths. All credited browser parts have no tracked-path difference from the candidate.

There was no per-run filesystem snapshot or commit/command header in the original test logs. The source-equivalence conclusion relies on the ordered author-write record and Git history being complete; it is not presented as a tamper-proof filesystem capture. Tests owns the decision about what that evidence proves.

One correction to the old manifest: card-refactor.log shows one passed case and 63 filtered cases, but session 17245 has no retained completion poll. The old manifest's exit 0 for that filtered run was inferred from the green log and wrapper, not directly captured. Its process is no longer retained. Do not use that field as a terminal receipt. The final full web-coverage.log has 64 passed with an observed exit 0 on the final candidate and covers changeAuthor; it is the applicable post-refactor proof. The earlier full card-green-2.log has its genuine exit 0 receipt attached separately, and remains explicitly pre-refactor.
