# Task 1112 exclusions authorized by the head

Source: 76c4b7d571aba37c5eefd12cac4eeee4945c01e5, source merge base 77c5f226f7ef84de8876cf42da3312fe8da779ce. The head confirmed that iv-no-confirm is current policy and deleted outbound remains deleted. All standing department-head authority is retained. The per-channel ruleOf API remains current.

- apps/server/src/modules/outbound/tools-head.ts: excluded all head-standing-authority edits because upstream deleted the entire module.
- apps/server/test/outbound-department.test.ts: excluded the deleted module's tests, including the later a703fae11 foreign-head assertion.
- packages/protocol/src/approval-policy.ts: excluded DEFAULT_APPROVAL_RULE = new_kinds and the former single-argument ruleOf; retained current defaultRule and the channel argument, including explicit none rules.
- packages/protocol/test/approval-policy.test.ts: excluded the universal-default assertion and old ruleOf calls; retained current channel-specific default and explicit-rule tests.
- apps/server/src/modules/departments/approval-policy.ts: excluded the old generic-new-kinds description and old ruleOf expression; retained current per-channel expression. Existing commit-policy validation remains in the server.
- apps/server/src/modules/tools/approval-policy.ts: excluded descriptions of universal new_kinds and the deleted mode-none omission; retained standing head authority, current ruleOf calls and current per-channel descriptions.
- apps/server/test/approval-policy.test.ts: excluded the universal-new-kinds default expectation; retained the current none/every/new_kinds mapping and transferred all head-authority assertions. The additional first-kind/case-normalization scenario now uses spend, where new_kinds remains the default, instead of message. Its obsolete message-default expectation failed before this adaptation; no production policy was changed.
- apps/web/src/i18n/en.ts and apps/web/src/i18n/ru.ts: replaced the obsolete universal-new-kinds hint and reference to required outbound checks with an explanation of the current channel defaults.
- apps/web/test/ApprovalPolicy.test.tsx: updated only the default-hint expectation; retained preservation of explicit server-supplied rules.
- templates/skills/hh-head.md: excluded outbound_ catalog/autoSend instructions and universal-new-kinds wording. Retained the current mail/account workflow and added current-owner/CEO standing authority. The temporary card-history limitation from source 1112 is retained until task 1220.
- templates/skills/hh-questions.md: excluded the old human_only_action classification that would replace current iv-no-confirm wording; transferred the head-authority paragraph.
- templates/skills/mkt-publish-approval.md: excluded the outbound_propose/outbound_publish catalog edit because the gateway and workflow were removed; kept the current publication workflow.
- templates/skills/sal-outbound-approval.md: excluded the obsolete catalog-publication edit; kept current direct-mail records, stop handling and department approval rules.
- templates/skills/sup-support-policy.md: excluded the deleted catalog-publication instruction; kept the current direct-support workflow.
- templates/skills/sup-work-pipeline.md: excluded references to protected gateway checks/publication needs; retained current direct-support wording and transferred the head's authority to set the department description.

Mechanical conflicts combined the decision-context imports with machine access/inbox support, kept the current only() selection helpers, and transferred incoming no-fresh-human-message test calls. No migration is added by task 1112. Original docs/tasks/task-1112 artifacts remain historical source evidence, not a description of this adapted candidate.
