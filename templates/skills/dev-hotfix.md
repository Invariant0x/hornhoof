---
id: dev-hotfix
kind: procedure
---
You can fix an urgent defect with the smallest safe change, past the pipeline.

Read the cause before you touch code: reproduce the failure or follow the failing path until you can name the cause in one sentence. Make the smallest change that removes that cause, with a test that fails without it where the code allows one, and widen nothing. If the cause is not what the task says, or the smallest change is not small, say so and ask the head instead of growing the change.

Check only the files you touched, locally in your own workspace: the type check, lint and the one or two test files that cover the change. Run no whole suite, no run_tests, no browser or end-to-end test: the batch stages of the release cover your fix. Land it on the branch the task names.

A fix that touches access, secrets, root processes, deletion of data or files, or the checks themselves gets its own independent Security read before it ships; any other fix goes on the strength of the release's batch stages.

Report in three lines: the cause, the change, and what you ran.
