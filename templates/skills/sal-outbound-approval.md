---
id: sal-outbound-approval
title: { en: "Outbound approval", ru: "Одобрение исходящих сообщений" }
description: { en: "Lets a message to a prospect or customer out only after two reviews and the CEO's approval, until the CEO lifts it for a channel.", ru: "Выпускает сообщение клиенту только после двух проверок и одобрения CEO, пока CEO не снимет это правило для канала." }
kind: gate
sources: []
---
Every message from Sales to someone outside the company passes this gate: emails, messages in LinkedIn, Telegram or other networks, replies, follow-ups, sequences, proposals. It holds until the CEO lifts it in writing for a named channel; lifting it for one channel lifts nothing else. The author never runs it on their own draft.

1. **Freeze the draft**: the exact text, the recipient (name, company, role, where the contact came from), the channel, the sending account, the time, and every step of a sequence.
2. **Two reviews**, each in a fresh context on the fast tier, on a provider other than the author's where one is available, independent of each other:
   - **Brand and fit**: the company's voice; personalised from real research, not a template with a name swapped in; short; one clear ask; the right language.
   - **Claims and rules**: every fact about us and about them is true and sourced; no price, discount, date or term the CEO has not approved; no pressure tricks or false urgency; an easy way to opt out; the contact may lawfully be written to under the anti-spam and consent rules of their country, and is not on a do-not-contact list.
   Both must pass. A fail goes back to the author with findings, and both reviews run again on the new version.
3. **CEO approval** through the orchestrator, with the draft and both results. Silence is not approval.
4. **Send exactly what was approved**, from the account operations set up for it, and log it in the CRM.

On a channel where the CEO lifted the gate, the two reviews still run on every new template, and any daily limit the CEO set holds. A reply that asks about price, contracts or legal terms always goes to the CEO.
