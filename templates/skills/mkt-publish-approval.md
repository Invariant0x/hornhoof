---
id: mkt-publish-approval
title: { en: "Publish approval", ru: "Одобрение публикации" }
description: { en: "Routes public posts, pages and announcements through the server outbound gateway, published catalog sources and per-item owner approval.", ru: "Проводит публичные посты, страницы и объявления через серверный шлюз исходящих, опубликованный каталог и поштучное одобрение владельца." }
kind: gate
sources: [affaan-m/ECC skills/operator-approval-loop/SKILL.md]
---
Use this ability to validate or carry out an assigned public publication: a post, announcement, newsletter or external page. Every such item goes through the server outbound gateway ("outbound_submit" and "outbound_status"). Publishing credentials stay on the server and are never exposed to agents.

1. **Published sources**: select the registered audience, language and published template, claim, price, terms and `https:` link revisions. Each language is a separate submission; never substitute another language silently. Propose missing sources with "outbound_propose"; your department's head publishes them with "outbound_publish" under the department's rules, in any turn with its named owner's rights or the CEO's when none is named. No fresh human message is needed for that catalog decision.
2. **Server checks**: the server renders the exact bytes, rejects unapproved claims, prices, secrets or personal data, and enforces consent, suppression, unsubscribe and applicable account or domain limits. Required independent-vendor model checks run in a fresh context with valid certification; unavailable checks do not count as a pass.
3. **Exact human approval**: every public item requires explicit approval of its exact rendered content from the department owner, or the CEO / CEO delegate when no owner is set. Campaign, approach or batch approval never waives per-item approval. Silence is not approval.
4. **Frozen revision**: dispatch only the approved bytes through the server and within the assignment's authority. Any wording or source change creates a new revision requiring a new approval.
5. **Delivery and correction**: read delivery state. An `unknown` result requires destination verification before retrying. Notify the authorized owner promptly of a live error with a proposed correction; never delete or overwrite public records without approval.

Return the submission revision, check outcomes, exact approval reference and delivery state. This ability does not grant account access or authorize publication outside the assignment.
