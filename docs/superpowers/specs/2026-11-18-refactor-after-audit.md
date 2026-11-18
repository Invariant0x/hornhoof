# Refactoring after the GPT-6.2 audits

Two independent static audits of 0.32.0, by GPT-6.2 Sol and GPT-6.2 Astra, are in docs/audits/. Finding IDs below are theirs: S, D, N, W, X, U, T for Sol, numbers for Astra.

## Already fixed, going into turn 33

These are done on the branches iv-fix-authority, iv-fix-approvals, iv-fix-limits and iv-fix-bugs and are being merged into one branch for turn 33 (task #1317). Do not redo them; build on them:

- authority: Sol S01, S02, S06, S44, D04; Astra 1, 6, 9, 31, 32, 35, 36;
- approvals: Sol S03, S04, D05; Astra 2, 14;
- limits: Sol S05, N05; Astra 3, 5, 7, 8, 26, 33;
- bugs: Sol S12; Astra 4, 10, 16, 28, 49, 54.

Astra numbers are those of its full finding list, as the fix branches cite them. Check each finding against those branches before you start; if a finding is only partly fixed there, finish it in your stream.

## Streams for turn 34

The owner asked to start them now, in parallel. Each stream is one whole task for one owner, end to end, on its own branch, with tests first where behaviour changes. Streams marked "now" start from main at once. Streams marked "after 33" start from the turn-33 branch once the audit fixes are merged there, because they touch the same files.

1. **Repository hygiene (now).** Sol D01, Astra 12, 13: move raw run artifacts and evidence out of the source tree (keep short reports), stop the browser test from writing screenshots into tracked docs. Sol D02, Astra 11, 24: replace the module map with an inventory of the current release and how to reproduce it; remove the staging guide's deleted modules and tables.
2. **Retire the outbound gateway (now).** Sol S09: the removed gateway still holds about 600 schema lines plus merge and SQL policy. Settle retention and upgrade needs, then drop the tables and their live rules in one migration (the branch iv-mail already has one commit that drops gateway tables; start from it). Sol S14: drop gateway-era template checks.
3. **Updater (now).** Sol U01: split the 2,897-line updater into its six operational paths around the existing persisted recovery state. Sol U03: the updater deletes old database dumps by count; make that irreversible retention explicit and checked against recovery coverage.
4. **Node cycles and terminals (now).** Sol N01, Astra 22: break the 17-file provider and terminal import cycle (providers own their launch and usage adapters). Sol N02: take view sessions and privacy handling out of TerminalHost before splitting turn delivery.
5. **Tests and build speed (now).** Sol X01, Astra 20: one formula for test workers and one for when work can start on a machine, with explicit profiles. Sol S13: reprofile the server files that take 80 to 136 seconds and move narrow assertions out of whole-app setup. Astra 23: one root test run builds the protocol three times; build it once. Astra 25: replace real sleeps with waiting on the condition. Sol S14: one product-policy check for templates, the loader tested separately.
6. **Server import cycles (after 33).** Sol S08, Astra 17: break the 90-file static import cycle, starting with the direct task engine and tracker edit cycle, cutting from the leaves inward (run constants, job lookup, tracker revision, repository refs). Sol S10: split the conversation queue (placement, delivery, recovery, dispatch) behind explicit interfaces. Astra 21: one shared keyed serializer instead of two. Sol S15: finish moving person offboarding out of the tracker startup backfill.
7. **Web: one task vocabulary (after 33).** Sol W01: the old task board and the new tracker share task trees and status under two vocabularies; consolidate task presentation and keep release grouping separate (the tracker states follow the owner's rule: waiting only for a person, in work, on a timer, failure). Astra 15: web and protocol keep separate copies of the company and department catalogs; publish one from the protocol.
8. **Old compatibility and admission rules (after 33).** Sol S11: set the supported node floor and retire pre-skill-file dispatch branches. Sol S07: turn scheduling still imposes plan-share, CPU and memory thresholds; keep only real provider availability and real resource exhaustion (the owner's rule: no limits Hornhoof invents for agents).

## Rules

- Behaviour stays the same unless a finding says it is wrong; each stream proves that with tests before and after.
- No new limits, approvals or time ceilings for agents.
- Whole suites and browser runs go to the test servers, not to anyone's own machine.
- Each stream ends with a code review and deletes the code, styles and duplicates it made unused.
