# Task 1196: route declarations and agent views

Base: `9fe737f21ee6f4caf2c0cad80c086cfe791fdb79` on `turn-31`.
Integration base: `734fe6637056b022d506c8049a7d1c6e07dd8afe`, merged cleanly.
Bug fix, small task, access risk. No handler or production access policy changes.

The route audit must recognize `attachmentJobOf` on the upload route instead of
requiring the older `jobOf` call. The attachment permission remains tied to the
live job, agent, node and task. An own-task upload returns 201; using the same
permission for another task or a task in another company returns 403.

The current base has eleven missing routes, including the contacts route added
after the original list of ten. The head confirmed all eleven are in scope.

1. `GET /api/phones`: company phone inventory, without agent identities or task
   content; the connection address is visible only to the phone owner. List category.
2. `GET /api/phones/:id`: company-scoped phone metadata; another company gets
   403, and the connection address is visible only to the phone owner. Elsewhere,
   under the phone tests.
3. `POST /api/phones/probe`: a human or the orchestrator probes a machine of their
   company; a head acting through a person is refused. No agent or task data
   category.
4. `POST /api/phones`: a human or the orchestrator registers a phone on a machine
   of their company; a head acting through a person is refused. No agent or task
   data category.
5. `POST /api/phones/:id/stop`: the signed-in phone owner or the orchestrator
   acting for the CEO stops lending;
   this returns phone state, without agent identities. No agent or task data
   category.
6. `POST /api/phones/:id/resume`: the signed-in phone owner or the orchestrator
   acting for the CEO resumes lending, under the same company boundary. No agent
   or task data category.
7. `GET /api/phones/:id/live`: the signed-in phone owner or the orchestrator
   acting for the CEO reads the latest frame metadata. Elsewhere, under the phone
   and recording tests; not a public phone list.
8. `GET /api/phones/:id/live/image`: the same phone-owner or orchestrator check
   protects the live image. Elsewhere, under the phone and recording tests.
9. `GET /api/tasks/:id/phone-recordings`: a visible task of this company, with
   recordings filtered to agents the viewer can open. Elsewhere, under the
   recording tests.
10. `GET /api/phone-sessions/:id/frames/:sequence/image`: the recording belongs
    to this company, its task is visible and its agent is reachable. Elsewhere,
    under the recording tests.
11. `GET /api/outbound/contacts`: addresses belong only to the selected department
    of this company, for its owner, the CEO or delegate, or the orchestrator acting
    for the CEO. Its head may act on the
    word of an authorized person inside its own department. Another department's
    owner gets 403; a head acting outside its department gets 404. Elsewhere,
    under `outbound-department-access.test.ts` and `outbound-department.test.ts`.
    This entry grants no access beyond `manageDepartment` and `requireRunner`.

Requirement checks: `route-access.test.ts` covers complete access declarations;
`agent-view-table.test.ts` covers complete route placement and the phone list;
`attachment-token.test.ts` covers own-task uploads and the 403 task/company
boundaries. Neighboring attachment and task-file tests preserve existing upload
and download behavior.

The two requested baseline checks failed for the expected reasons on the original
base: the table listed these eleven missing routes, and the route audit reported
`POST /api/attachments` without an access declaration. The targeted run exited 1
after executing both checks. Its other cases were excluded by the name selector.
An earlier broad baseline run was stopped without a result. The original-base
server build passed. Final checks must use the merged candidate.
