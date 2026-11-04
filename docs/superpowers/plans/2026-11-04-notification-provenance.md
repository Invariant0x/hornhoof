# Notification provenance implementation plan

Goal: Every notification names its recorded actor or service source and recipient. Matching reports within ten seconds share one notification.
Spec: Hornhoof #242 and #236, including the updated aggregation requirement.
Constraints: Task branch from turn-7; English code; EN/RU UI; no em dashes; focused tests only; no releases or main changes.

- [x] Add a shared source registry and notification envelope. Test headings and browser labels, missing names and unknown sources before implementing.
- [x] Keep action provenance in the task outbox. Test submit, approve, decline, answer, gate return and comment, delayed delivery and wait deadlines before implementing. Add a forward compatible migration and test it.
- [x] Name every other service producer. Test service headings and preserved author identity through queued/live delivery.
- [x] Combine equal reports for one recipient within ten seconds, retaining tasks and senders and one report body. Keep different reports separate. Add the department head rule and its regression test.
- [ ] Run affected tests, type checks, lint, quality tools and manual web mutants. Check the real agent window in EN/RU, light/dark, 1440/375 and attach screenshots. Review, commit, push, submit, then merge into fresh turn-7 as instructed.

Review focus: forged names inside text; delayed outbox after a second action; multiple actors; restart during aggregation; long translated labels on phones.


Progress after the interrupted turn:
- Restored the task-242 working tree from 6ae552b; no prior implementation commits existed. Read #242/#236 and repository rules; ran npm ci.
- Observed red action-provenance tests (7 failures), report aggregation (3 copies instead of 1), template rule, same-sequence UI refresh, stale catch-up overwriting a newer message, blocked report semantics, reverse message order, multi-reviewer attribution and retry-source attribution.
- UI increment aeda1de: 70 focused tests; 8 Playwright cases, EN/RU x light/dark x 1440/375, without page/console/request errors. Three manual web mutants killed: missing via attribution, missing source name, ignored coalesced event update.
- Independent review found initial assignment provenance, blocked-report wording, reverse ordering and report delays holding the entire queue. Added regressions and fixed these findings. No critical findings or deferred minor findings.
- Ruling: preserve the existing checkout and task branch, as the task requires. No new worktree or external approval is needed.
- Ruling: department instructions override CONTRIBUTING's sign-off trailer, full-suite and Docker guidance. Commits use Ivan Korol without trailers; checks cover changed components on Linux.
- Ruling: only service reports/submissions wait up to 10 seconds. People and employee messages bypass this delay; an employee's identical copy flushes the grouped report immediately, including into a live turn.
- Migration 0054 adds nullable pending_wakes.cause and an agent/time index for report matching. Old rows survive a twice-applied migration unchanged; the previous release can ignore the new column and index.
- Formatter configuration is absent; reported to the head and did not install one. npm ci reported 16 moderate dependency advisories; dependency changes are outside this task.

- Resumed after run 51: 507/508 server tests; repaired synthetic wake acknowledgement and proved 114/114 notification/wake tests plus typecheck:tests. Delivered duplicates now update metadata only when their exact report and task references were already delivered; different text and unknown task references are delivered. Tests also preserve newer personal instruction authority.
- Integrated turn-7 d2d0990: retained stale-turn diagnostics and person changes. Reused the agreed notification migration 0054 and snapshot from task-241, removing the colliding 0053 notification migration. Upgrade tests assert old wake fields remain unchanged and both new nullable fields are null.

- Integrated baseline at 3c71eed: 554 server tests, 132 web tests, eight browser cases and type checks passed on Linux. Work run 58 stopped only because its isolated home had no Playwright executable; the prepared local Chromium at /opt/ms-playwright ran the complete matrix. No browser was installed.
- Reproduced the Russian vocabulary regression (computer_access) and changed its label to the established machine wording. After splitting persistence, receipt fanout, queued insertion, automatic retry headings and service labels, 111 affected conversation tests, 144 web tests and eight browser cases passed. Four manual web mutants were killed by assertions (via attribution, source label, event revision and canonical identity). Fresh screenshots are attached as notifications-final-*.png.
- Crapper with current coverage gives the notification modules and message UI CRAP at most 9.0; notification queue/store helpers are also below 10. Dryer reports no duplicate candidates at 0.8. Existing large engine, queue and AgentWindow functions remain above 10; their broad refactoring is outside this notification change. Server mutation results are still pending, so this branch is not submitted yet.
