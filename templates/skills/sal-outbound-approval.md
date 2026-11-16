---
id: sal-outbound-approval
title: { en: "Outbound approval", ru: "Одобрение исходящих сообщений" }
description: { en: "Routes every external sales message through the server outbound gateway, published catalog parts, independent model checks and department owner approval.", ru: "Проводит каждое внешнее сообщение продаж через серверный шлюз исходящих, опубликованный каталог, независимые проверки и одобрение владельца отдела." }
kind: gate
sources: []
---
Use this ability to validate or carry out an assigned external commercial message: email, direct message, follow-up, sequence or proposal. Every such message goes through the server outbound gateway ("outbound_submit" and "outbound_status"). Sending credentials stay on the server and are never read by agents.

1. **Published sources**: reference only published template, price, discount, terms, claim, link and segment revisions for the account, channel and language. Do not paste unapproved prices, free-form URLs, secrets or recipient personal data. Never substitute another language silently. Propose missing parts with "outbound_propose"; your department's head publishes them with "outbound_publish" under the department's rules, in any turn with its named owner's rights or the CEO's when none is named. No fresh human message is needed for that catalog decision.
2. **Server checks**: the server verifies consent, suppression, daily account and domain limits, exact monetary arithmetic and unsubscribe links. Required certified independent-vendor model checks use a fresh context; missing checks are not passes.
3. **Exact human authority**: where policy, price rules or an escalated check requires approval, wait for the department owner's explicit approval, or the CEO / CEO delegate when no owner is set. A channel whose policy has autoSend on sends a direct message without a yes to each one; its price rules and escalations still ask. The server binds it to exact rendered bytes or the exact approved approach: channel, template revision, segment and language. Silence is not approval. Public items always require per-item approval; approach approval does not waive it.
4. **Safe delivery**: dispatch only within the assignment and approved scope. Read status; an `unknown` result holds quota and the sending account until a human checks the receiving side. Never resend blindly.
5. **Restricted commitments**: custom prices, discounts, legal terms, contract changes and unapproved delivery promises require the authorized human decision. A human signs contracts.

Return revisions, check and approval references, and delivery state. Selecting this ability grants no sending account, consent or commercial authority.
