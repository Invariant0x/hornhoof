# Assistant attachment access and delivery failures

Task: #1096. Base: `418bf5e4ed9ddc1bb99b0e74afec28ac8935f350` (origin/main, 0.29.0).

## Cause and change

`assistants/files.ts` used `ownFile`, which required a named attachment from a turn of the one assistant's own agent, with no person and no operator case. Its refusal did not depend on a PDF or spreadsheet extension. A valid file from another agent, a task or a person could be visible to the owner in the interface and still receive `404 attachment_unknown` from the assistant route.

`tasks/attachments.ts` now exposes `attachmentForPerson`, extracted from the interface's existing task, chat, message and request checks. Both routes use it. `requireAssistant` already loads the active owner's current identity and rights for each request. The assistant route normalizes visibility refusals, foreign files, missing ids and invalid ids to the existing identical 404 response. Program screenshots and operator case attachments remain unavailable, including a screenshot with an accidental task link. The interface's separate operator case route remains intact. Downloads retain the stored bytes and media type, a safely encoded filename and streaming reads.

External delivery is performed by the assistant program, outside Hornhoof. `callSkill` receives its JSON `ok`, `text` and optional `data`; `persona_call` exposes `ok: false` to the model as `isError: true`. Failed calls now explicitly instruct the agent not to report success, to explain the reason and to tell the owner that a refused file delivery did not arrive. A successful download alone does not prove delivery. A failure the external program does not report cannot be detected here.

## Four reported production refusals

No individual log records, request times, attachment ids or attachment metadata were supplied in the task or its parent at implementation time. The report that four `file_unknown` failures occurred is insufficient to classify them individually:

- Refusal 1: unclassified, individual record unavailable.
- Refusal 2: unclassified, individual record unavailable.
- Refusal 3: unclassified, individual record unavailable.
- Refusal 4: unclassified, individual record unavailable.

The old `ownFile` restriction is reproduced in tests, but is not evidence that it caused every reported incident. Classification needs each request's time, installation version and attachment id, the attachment's origin and the owner's rights. The evidence request is recorded on #1096 and #1091. No production installation or private records were accessed.

## Verification

The regression file `apps/server/test/assistants-files.test.ts` checks exact bytes, stored type and filename for a PDF and xlsx from an accessible task; chat, message and request access; rights revocation with the same key; indistinguishable 404 responses for a private task, unreadable author/message, foreign company, missing/invalid ids and program screenshots; and an explicit refused-delivery answer using a recorded external-program response. Date is controlled; no Telegram request or real-time deadline is used. Existing own-agent downloads, key validation and operator exclusions remain covered in `assistant-agent.test.ts`.

On the unchanged production code at the base, five of six new tests failed for the expected reasons: accessible downloads returned 404 and the refusal lacked explicit outcome instructions. The negative access test passed. A preliminary run exposed a fixture expectation of 200 for key creation, whose actual status is 201; that fixture was corrected before recording the valid RED log.

After implementation, the five named files `assistants-files`, `assistant-agent`, `message-pictures`, `task-files` and `program-operator-attachments` passed 82/82 with one worker. The first concurrent run passed 81/82; the existing 10 MB upload case in `message-pictures` exceeded its unchanged 20 second test limit. Limiting the verification run to one worker resolved contention without changing a test or its limit. In that run all five files were under 30 seconds; the large upload case still took about 11 seconds. Cold setup and several existing integration cases exceed the 1 second per-test target and are reported as remaining timing concerns.

An additional negative case exposed a program screenshot accidentally linked to a visible task (200 instead of 404); the assistant now rejects unnamed ordinary attachments. Final exact-commit author checks, build results and complete RED/GREEN logs are attached to #1096. They prove only their named local scope. A full release run, independent Review and independent Security remain required before release.
