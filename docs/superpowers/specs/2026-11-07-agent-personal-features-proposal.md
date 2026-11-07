# Personal agent features proposal

This is the proposal requested for item 6a. It does not authorize implementing storage, API, UI or agent self-writing. The live company, its cards and the 0.8.1 candidate stay unchanged.

## Card and meaning

Place a section named **Personal features / Особенности агента** between the existing Skills and Instructions sections of the employee card. Keep three separate concepts visible:

| Card section | Meaning | Writer |
| --- | --- | --- |
| Role | One short identity sentence from a role template | The role template |
| Assignment | Why this employee was created and which work it owns | Orchestrator or department head; a person with card-edit access |
| Personal features | Preferences, techniques and working facts specific to this employee | The employee can append; an authorized person can edit or delete |

The personal section is an ordered list of plain-text entries. Show each entry's text, author and time. A person gets Edit and Delete actions on each entry and an Add action. Empty state: “No personal features yet.” Read-only card viewers see the entries without editing controls. Do not mix this field into the role editor or the shared skill checkboxes.

Example personal entries: “When a task names a command, keep that exact command in the check record”; “Use the project's existing vocabulary in explanations.” Assignment, tool permissions, secrets and another employee's instructions do not belong here.

## Storage and access

Use a dedicated `agent_personal_features` record keyed by company and employee, containing a revision and an ordered list of entries. Each entry has a server-generated ID, text, author kind/ID, creation time and update time. Deleting the employee follows the company's existing retention policy; a template reset preserves personal entries and the assignment.

The dedicated storage is preferable to putting this feature inside `agents.overrides`: the existing generic orchestrator SQL path can currently write overrides. Protect the new storage against generic SQL writes so it cannot bypass append-only behavior, access checks or the audit trail. All writes go through the explicit feature routes. No data migration or schema change is part of this proposal itself.

Reading follows current employee-card visibility within the company and department. Human editing and deletion require the existing card-edit permission. A head or orchestrator receives no new broad access merely because a skill or this personal section exists. An employee cannot read or change another employee's entries through the self-writing tool.

Proposed bounded values: at most 2,000 characters per entry and 8,000 characters in total. Return a clear limit error without dropping or shortening saved entries. Use a revision check for human edits/deletes; a concurrent change returns a conflict rather than overwriting it.

## Employee append

Expose one tool, `append_personal_features({ text, requestId })`, to a running employee. It has no employee, company, entry-ID or target parameter. Resolve the owner from the authenticated current job; reject an expired job or a job belonging to another employee. The server sets authorship and time.

The tool can append one bounded text entry. It cannot replace, reorder or delete entries, change the assignment, toggle skills, edit another employee, grant tools or change permissions. Scope `requestId` to that employee and reject reuse with different text; repeating the same request returns its original entry. Append atomically so simultaneous human edits or another job cannot lose an entry. Read-after-write returns the resulting revision and new entry.

Record successful and rejected writes in the existing audit mechanism with the actual actor and employee. Human deletion is an explicit action. Treat entry contents as instructions with the same authority as an ordinary enabled skill, subject to company instructions, task restrictions and server-side permissions; personal text cannot elevate its own authority.

## Delivery through the existing skill mechanism

Generate a reserved `personal-features` skill entry for this employee only. It is not a shared template, a role, a grant or a checkbox. Build it through the same renderer that creates `Part` and protocol `SkillFile { name, description, body }` entries. Its body contains this employee's current entries in order. When empty, omit the generated entry.

Normal file-capable nodes receive the generated SkillFile through `job.run` and their normal skill-file placement. Older nodes receive its body through the renderer's existing whole-instructions fallback. Do not concatenate it into a conversation prompt, patch the role text or write it into an unrelated shared skill override. Delivery must preserve the existing instruction-length failure behavior.

The normal job preparation must refresh the file when its body changes. Verify the delivered file body/hash, rather than relying only on the standing instructions hash, which does not include ordinary skill-file bodies. Do not force-restart an employee to apply a personal entry during active work.

## Verification required before implementation can be accepted

- Card rendering and human edit/delete work with existing department/company access, including read-only viewers and another company's IDs.
- Self-append derives its target from the current job; another target, expired job, forged authorship, replace/delete and generic SQL write attempts are refused.
- Same request ID is idempotent; different text with that ID is rejected; concurrent appends and human edits preserve data or produce an explicit revision conflict.
- Empty, over-limit and Unicode entries behave predictably; a template reset does not discard personal entries or assignment.
- The normal renderer and node delivery provide the generated skill only to its owner, update its body on a later job, and preserve whole-text fallback and length limits.
- No new tool grant or assignment change can be obtained from entry text.

## Requested scope decision

Confirm whether to implement this concrete design within task 707 after the proposal is reviewed, or leave implementation for a separately authorized continuation. Until that decision, only the independent role/skill restructuring and its existing-field assignment work proceed.
