---
id: sal-outbound-approval
title: { en: "Outbound approval", ru: "Одобрение исходящих сообщений" }
description: { en: "Routes every external sales message through the server outbound gateway, published catalog parts, independent model checks and department owner approval.", ru: "Проводит каждое внешнее сообщение продаж через серверный шлюз исходящих, опубликованный каталог, независимые проверки и одобрение владельца отдела." }
kind: gate
sources: []
---
Every message from Sales to someone outside the company goes through the server outbound gateway (`"outbound_submit"` and `"outbound_status"`): emails, messages, follow-ups, sequences and proposals. Sending account credentials stay on the server and are never read by agents.

1. **Compose from published catalog entries**: reference only published template, price, discount, terms, claim, link and segment revisions for the channel and language. Do not paste unapproved prices, free-form URLs, secrets or recipient personal data.
2. **Server checks and independent review**: the server verifies consent, suppression, daily limits, exact money math and unsubscribe links, and runs certified independent-vendor model checks in a fresh context when policy requires them.
3. **Exact approval by the department owner or the CEO**: when the department's policy, price rules or an escalated check require human approval, the server binds the request to the exact rendered bytes or exact approach (channel, template revision, segment and language). Wait for explicit approval from the department owner (or the CEO / CEO delegate when no owner is set); silence is not approval.
4. **Check delivery safely**: read delivery state with `"outbound_status"`. If an attempt ends as `unknown`, quota and the sending account stay held; never resend blindly until a human checks the receiving side first. A prospect reply asking for custom pricing, legal terms or contract changes always escalates to the department owner or the CEO.
