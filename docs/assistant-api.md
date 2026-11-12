# Assistant API

A personal assistant is an outside program, such as AvaClone, OpenClaw or any program that speaks HTTP, that acts in Hornhoof for one person of a company: its owner. It writes to the company's agents as its owner would, reads what they answer, and answers the requests that wait for its owner. It may do everything its owner may, and everything it does is marked as done through it.

This document is the whole contract. A program built from it alone works with Hornhoof.

## How an assistant comes to be

In Hornhoof, on the People screen, someone adds a person and ticks "This is an agent (assistant)". They choose its owner (the person it acts for), its program, and optionally its events address. On the assistant's card they then create a key. Hornhoof shows the key and a signing secret once; both go into the program's settings. A program may also take the company's address and the key as one text: the button "Copy for the assistant" there copies them for the person to send, for example in Telegram, as a first line "Connect to my company in Hornhoof.", then "Address: <address>" and "Key: <key>" on lines of their own (in Russian "Подключись к моей компании в Hornhoof.", "Адрес:" and "Ключ:"), never with the signing secret.

* The owner may set up their own assistant. A person who may edit people in People may set one up for anyone. Only the CEO sets up the assistant of the CEO or the CEO delegate, besides the delegate for their own.
* "Replace" makes a new key and a new signing secret. The ones before stop working at once.
* "Revoke" takes the key away. Nothing opens with it any more.
* A switched off assistant opens nothing, whatever key it has.
* The owner of an assistant cannot be changed. For another person, add another assistant.

## What an assistant may do

An assistant acts with its owner's rights as they are at the moment of each call. When the owner's access changes, the assistant's changes with it, at once.

* It writes to exactly the agents its owner may write to in the agent's window, the orchestrator among them when the owner's window shows it.
* It answers every request its owner may answer, whatever it is about.
* An agent weighs the assistant's words exactly as its owner's words in the window. What the owner may ask an agent for, the assistant may ask for too, managing the company included, for example people and their access, plans, machines or settings.
* The key opens only the calls below. For anything else, the assistant asks an agent in words, and the agent acts with the owner's rights.
* While its owner is switched off or gone, every call is refused with `403 assistant_owner_inactive`.

Everything an assistant does is recorded as done by its owner through the assistant. The agent's window marks its messages with the assistant's name, and an answered request records both.

## Calls

Every call goes to the company's Hornhoof address, for example `https://hornhoof.example.com`, under `/api/assistant/`. Bodies are JSON (`Content-Type: application/json`), in UTF-8. Ids are UUIDs. Times are ISO 8601 in UTC.

### Key

Every call carries the key:

```
Authorization: Bearer hha_<43 characters>
```

A key is `hha_` followed by 43 characters of base64url (`A-Z`, `a-z`, `0-9`, `-`, `_`). The key opens only the routes in this document. Every other route of Hornhoof answers it with `401`.

### Errors

An error answers with a status and this body:

```json
{ "error": { "code": "forbidden", "message": "A sentence for a person.", "reason": "assistant_agent_refused" } }
```

`code` is one of `validation` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `too_many` (429), `unavailable` (503). `reason`, where there is one, is stable and meant for programs; `message` is for people and may change. A program decides by status and `reason`.

| Status | `reason` | When |
| --- | --- | --- |
| 400 | none | The body or the query is not as below. `message` names the field. |
| 401 | `assistant_key_invalid` | No key, a key in another form, a replaced or revoked key, or an assistant that is switched off. |
| 403 | `assistant_owner_inactive` | The owner is switched off or gone. |
| 403 | `assistant_agent_refused` | The owner does not write to this agent. |
| 403 | `decision_not_allowed` | The owner does not take this decision. |
| 404 | `agent_unknown` | There is no such agent in the company, or it was removed. |
| 404 | `request_unknown` | There is no such request in the company. |
| 409 | `orchestrator_not_ready`, `agent_not_ready` | The agent cannot answer right now, for example while it has no plan to run on. Try again later. |
| 409 | `request_closed` | The request is answered already. |
| 400 | `task_invalid` | The answer does not fit the request: see "Answer a request". |

### GET /api/assistant/me

Who the assistant is, whom it acts for, and what that person is in the company now.

```json
{
  "assistant": { "id": "…", "name": "Ava", "title": "", "program": "avaclone" },
  "owner": {
    "id": "…", "name": "Olga", "title": "Head of development",
    "ceo": false, "ceoDelegate": false, "wholeCompany": false,
    "departments": [{ "id": "…", "name": "Development" }],
    "teams": [{ "id": "…", "name": "Payments", "departmentId": "…" }],
    "responsibleFor": [{ "id": "…", "name": "Development" }],
    "telegram": { "username": "olga_k", "id": 5550001 }
  },
  "company": { "name": "Acme" }
}
```

* `program` is `avaclone`, `openclaw` or `other`.
* `ceo` is true for the company's owner. `ceoDelegate` is true for the CEO delegate. `wholeCompany` is true when the owner sees the whole company: the CEO, the CEO delegate or a person with access to all of it.
* `departments` and `teams` are the places the owner was given access to. `responsibleFor` lists the departments the owner is responsible for.
* `telegram` is the owner's Telegram as it is in People now: `username` without the `@`, in lower case, and `id`, the account's number, typed in People or learned once one of the company's Telegram bots met the owner. Each is `null` while unknown, and both are always there. A program that serves several people binds the key to exactly one of them by this, so that nobody else acts with the owner's rights through it. It changes when the owner's Telegram changes, so read it again, for example when the program starts.

### GET /api/assistant/agents

The agents the assistant may write to now, in the order they were hired.

```json
{
  "agents": [
    { "id": "…", "name": "Orchestrator", "kind": "orchestrator", "role": null, "department": null },
    { "id": "…", "name": "Hana", "kind": "head", "role": { "en": "Head of development", "ru": "Руководитель разработки" }, "department": { "id": "…", "name": { "en": "Development", "ru": "Разработка" } } }
  ]
}
```

`kind` is `orchestrator`, `head` or `worker`. `role` and `department` are given in English and Russian, or are `null`.

### POST /api/assistant/messages

Writes to an agent for the owner, as the owner would in the agent's window.

```json
{ "agentId": "…", "text": "How are the leads this week?" }
```

* `text`: 1 to 20000 characters after spaces at both ends are trimmed. No other field is allowed.
* Answers `202` with the message's id. The agent's answer comes later, as events with that id.

```json
{ "message": { "id": "…", "agentId": "…" } }
```

The agent reads the message as the owner's own words, marked as written by the assistant, and is told who the owner is in the company. A message to an agent that is busy waits for it, as a person's does. If the message answers a question the agent asked the owner in its window, Hornhoof records it as the owner's answer given by the assistant.

### GET /api/assistant/events?after=&lt;seq&gt;&amp;wait=&lt;seconds&gt;

The assistant's events after a number, oldest first, at most 100 at a time. This is a long poll.

* `after`: a whole number, 0 or more; 0 when left out. Pass the `next` of the answer before.
* `wait`: whole seconds, 0 to 50; 0 when left out. When there is no event after `after`, Hornhoof holds the call for up to this long and answers as soon as one comes. With 0 it answers at once.
* More than 50, a negative number or any other parameter answers `400`.

```json
{
  "events": [
    { "seq": 41, "kind": "reply", "at": "2026-11-11T10:00:03.000Z", "data": { "messageId": "…", "agent": { "id": "…", "name": "Hana", "kind": "head" }, "text": "On it." } }
  ],
  "next": 41
}
```

* `seq` grows with every event of the company, so an assistant's own events have gaps between their numbers. Only the order matters.
* `next` is the `seq` of the last event in the answer, or `after` when there was none.
* An empty answer after the wait is `{ "events": [], "next": <after> }`. Call again.
* A full page of 100 means more may wait. The next call answers at once when they do.
* Events are kept for 30 days. A program that was away for longer reads what is left and lists the open requests with `GET /api/assistant/requests`.

The kinds of event and their `data`:

| `kind` | `data` | Meaning |
| --- | --- | --- |
| `reply` | `{ messageId, agent: { id, name, kind }, text }` | Words of the agent's answer to the assistant's message. A long answer comes as several replies, in order. |
| `reply_end` | `{ messageId, agent: { id, name, kind }, answered, failed }` | The answer to the message is over. `answered` is false when the agent said nothing; `failed` is true when its turn failed. |
| `request` | `{ request }` | A request now waits for the owner. `request` is as in `GET /api/assistant/requests`. |
| `request_closed` | `{ requestId, status }` | The request waits for the owner no more: it was answered, here or in Hornhoof, withdrawn, or no longer the owner's. `status` is the request's status now: `open`, `answered`, `approved`, `declined`, `withdrawn` or `resolved_internal`. |

#### When the answer to a message is over

An agent answers a message in a turn, and its words come as `reply` events while it works. A turn may go on in another turn, for example after the agent waited for a machine, so the end of the turn is not yet the end of the answer. Hornhoof sends `reply_end` once for each message, after its turn and every turn that goes on from it are over and 30 seconds passed with no new turn. After `reply_end` no more `reply` comes for that `messageId`.

* `answered`: whether any `reply` came for the message. False when the agent worked without a word for the owner, for example when it only acted on a task.
* `failed`: whether the last turn failed, for example when the agent's program broke off. The words that came before stay valid. The program may tell the owner and write again later.
* A program that shows a "typing" mark keeps it from the `202` of `POST /api/assistant/messages` to the `reply_end`.

When the assistant writes again to an agent before the `reply_end` of its earlier message, both messages wait on the same answer, and the words after the newer message come as replies once for each of them.

### GET /api/assistant/requests

The requests that wait for the owner now: the ones Hornhoof would show to the owner as theirs, oldest first.

```json
{
  "requests": [
    {
      "id": "…",
      "kind": "choice",
      "topic": "task",
      "text": "Which payment provider do we take?",
      "explained": "Bruno needs to know which provider to build the checkout on. Stripe is quicker, PayPal is known to more customers.",
      "options": ["Stripe", "PayPal"],
      "commit": null,
      "approval": null,
      "link": null,
      "task": { "id": "…", "number": 12, "title": "Checkout" },
      "agent": { "id": "…", "name": "Bruno" },
      "department": { "id": "…", "name": { "en": "Development", "ru": "Разработка" } },
      "askedAt": "2026-11-11T09:58:00.000Z",
      "answerable": true
    }
  ]
}
```

* `kind`: `question` (answer in words), `choice` (pick one of `options`, or answer in words), `approval` (approve or decline), `stuck` (the work is stuck: answer in words, or ask to try again).
* `topic`: what the decision is about: `task`, `employee`, `release`, or administering the company: `people`, `access`, `subscriptions`, `machines`, `repositories`, `public_link`, `updates`. `null` on old requests.
* `explained`: the orchestrator's plain words for people, or `null`.
* `commit`: the commit an approval is for, or `null`.
* `approval`: for an approval a department's rules asked for, `{ channel, kind, amount }` (what is sent, what kind of work, how much), or `null`.
* `link`: a web address that shows the work, or `null`.
* `agent` is `null` when the owner does not see the agent that asked. `department` is `null` for work of no department.
* `answerable` is true exactly when the owner may answer the request in Hornhoof. When it is false, the assistant may show the request to its owner, but neither of them answers it.

### POST /api/assistant/requests/:id/answer

Answers a request for the owner, the same way the owner answers it in Hornhoof. The body is one of:

| Body | For |
| --- | --- |
| `{ "answer": "Stripe." }` | A question, a choice or a stuck request: the answer in words. |
| `{ "pick": 0 }` or `{ "pick": 0, "answer": "Stripe, for speed." }` | A choice: the number of the option, from 0, with words if wanted. |
| `{ "approve": true }` or `{ "approve": false, "answer": "Not this week." }` | An approval. |
| `{ "retry": true }` | A stuck request: try again. |

No other field is allowed. Answers `200`:

```json
{ "request": { "id": "…", "status": "answered", "picked": null, "answer": "Stripe." } }
```

`status` is `answered`, `approved` or `declined`; `picked` is the option's number for a pick. A `request_closed` event follows. Refusals: `403 decision_not_allowed` when the owner does not take this decision, `409 request_closed` when it is answered already, `400 task_invalid` when the answer does not fit the kind (for example `approve` on a question, or a `pick` that is not an option).

## Wake

When the assistant's card has an events address, Hornhoof also wakes the program there each time a new event of the assistant is kept, so it need not hold a long poll open. A wake is a POST:

```
POST <events address>
Content-Type: application/json
X-Hornhoof-Signature: sha256=<64 hex characters>

{"type":"wake","after":40}
```

* The program reads `GET /api/assistant/events?after=40` (or after its own last `next`, if that is smaller) to get what is new. The wake itself carries no event.
* `X-Hornhoof-Signature` is `sha256=` and the HMAC-SHA256 of the exact body bytes, under the signing secret as a UTF-8 string, in lowercase hex. Check it against the raw body, before parsing it, with a comparison in constant time. Drop a wake whose signature does not match.
* Answer with any 2xx status, at once. Read the events after answering, not before.
* A wake that gets another status than 2xx, no answer within 10 seconds, or no connection, is tried again after 1 second, then 2, 4 and so on, doubling up to 5 minutes, 12 tries in all. A redirect is not followed and counts as a failed try. Wakes that come due meanwhile join the one that waits, with the smallest `after`.
* A wake never holds anything up in Hornhoof, and a lost one loses nothing: the events wait to be read.
* The events address is an `http` or `https` address of at most 500 characters. Use `https` unless the program runs on the same machine or network as Hornhoof.

Checking a wake, in Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromHornhoof(rawBody, header, signingSecret) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', signingSecret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

In Python:

```python
import hashlib, hmac

def is_from_hornhoof(raw_body: bytes, header: str, signing_secret: str) -> bool:
    expected = "sha256=" + hmac.new(signing_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

## Limits

| What | Limit |
| --- | --- |
| Message text | 1 to 20000 characters |
| Long poll wait | 0 to 50 seconds |
| Events in one answer | 100 |
| Events kept | 30 days |
| End of an answer after its turn | 30 seconds with no turn going on from it |
| Wake | 10 seconds to answer, 12 tries, pauses from 1 second doubling to 5 minutes |
| Events address | `http` or `https`, at most 500 characters |
| Key and signing secret | `hha_` and `hhs_`, each followed by 43 base64url characters |

## Example session

The owner, Olga, is responsible for Development. Her assistant Ava has a key.

```sh
H='Authorization: Bearer hha_6m0b…'
BASE=https://hornhoof.example.com

curl -s -H "$H" $BASE/api/assistant/me
curl -s -H "$H" $BASE/api/assistant/agents
# Hana, the head of Development, is among the agents. The orchestrator is not, as Olga's own window does not show it either.

curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"agentId":"8a3c…","text":"How far is the checkout?"}' $BASE/api/assistant/messages
# 202 {"message":{"id":"d41e…","agentId":"8a3c…"}}

curl -s -H "$H" "$BASE/api/assistant/events?after=0&wait=50"
# {"events":[{"seq":57,"kind":"reply","at":"…","data":{"messageId":"d41e…","agent":{"id":"8a3c…","name":"Hana","kind":"head"},"text":"Bruno has the payment form done and asks which provider to use."}}],"next":57}

curl -s -H "$H" "$BASE/api/assistant/events?after=57&wait=50"
# {"events":[{"seq":58,"kind":"request","at":"…","data":{"request":{"id":"f19b…","kind":"choice","topic":"task","text":"Which payment provider do we take?","options":["Stripe","PayPal"],"answerable":true,…}}},
#            {"seq":61,"kind":"reply_end","at":"…","data":{"messageId":"d41e…","agent":{…},"answered":true,"failed":false}}],"next":61}

# Ava asks Olga in her own chat, and Olga says Stripe.
curl -s -H "$H" -H 'Content-Type: application/json' -d '{"pick":0}' $BASE/api/assistant/requests/f19b…/answer
# 200 {"request":{"id":"f19b…","status":"answered","picked":0,"answer":null}}

curl -s -H "$H" "$BASE/api/assistant/events?after=61&wait=50"
# {"events":[{"seq":64,"kind":"request_closed","at":"…","data":{"requestId":"f19b…","status":"answered"}}],"next":64}
```

A program keeps `next` where it survives a restart, reads `GET /api/assistant/requests` when it starts, and then long polls, or waits for wakes, from the `next` it kept.
