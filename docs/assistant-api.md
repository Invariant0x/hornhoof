# Assistant API

A personal assistant is an outside program, such as AvaClone, OpenClaw, Hermes Agent or any program that speaks HTTP or MCP, that acts in Hornhoof for one person of a company: its owner. It writes to the company's agents as its owner would, sends them files of any kind, reads what they answer with the files they attach, and answers the requests that wait for its owner. It may do everything its owner may, and everything it does is marked as done through it.

This document is the whole contract. A program built from it alone works with Hornhoof.

## How an assistant comes to be

In Hornhoof, on the People screen, someone adds a person and ticks "This is an agent (assistant)". They choose its owner (the person it acts for), its program, and optionally its events address. On the assistant's card they may also give its skills address, and its owner may pick the plan its own agent thinks on: see "The assistant's own agent". On the card they then create a key. Hornhoof shows the key and a signing secret once; both go into the program's settings. A program may also take the company's address and the key as one text: the button "Copy for the assistant" there copies them for the person to send, for example in Telegram, as a first line "Connect to my company in Hornhoof.", then "Address: <address>" and "Key: <key>" on lines of their own (in Russian "Подключись к моей компании в Hornhoof.", "Адрес:" and "Ключ:"). For an AvaClone assistant whose card has an events or a skills address, a last line "Secret: <signing secret>" (in Russian "Секрет:") follows, as the program checks Hornhoof's calls with it; for any other program the text never has the signing secret. For OpenClaw and Hermes Agent the window also shows the settings that connect the program, ready to copy into its file: see "Connecting OpenClaw" and "Connecting Hermes Agent".

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

## The assistant's own agent

An assistant may have an agent of its own in Hornhoof that thinks for it. A program such as AvaClone keeps its persona, its memory and its chat with the owner, and sends the owner's words to this agent to answer.

* Only the owner picks the plan the agent thinks on, on the assistant's card in People, and only one of the owner's own personal plans. The first plan picked makes the agent; another plan moves it there. With "No plan" it stays without one and cannot answer.
* Only the owner sees the agent and writes to it, in its window or through the assistant. Nobody else does, the CEO included, and the orchestrator does not change it. It is not an employee: it has no department or role, takes no tasks and is not counted on the map.
* Its card in Hornhoof cannot be edited, reset or removed (`409 assistant_agent_card`). Its plan changes on the assistant's card.
* It reads a message exactly as the program sends it, with nothing added but a line for each file that came with it, naming the file and the command that opens it. It keeps its conversation from one message to the next, so `text` need carry only the new words. With each message the program may also send `freshText`, its whole conversation: the persona, the facts about the owner and everything said so far. The agent reads `freshText` in place of `text` only when its turn starts a new session, for example its first turn, after it moved to another plan or machine, after its skills address was set or cleared (see "Skills"), or after its owner cleared its conversation in its window; otherwise Hornhoof leaves it aside. A machine whose Hornhoof node is older than the server does not tell a cleared conversation, and its agent reads `text` then. Its window shows `text`.
* Its answer is the text for the owner, in the `reply` and `reply_end` events of the message, as for any agent.
* Its owner may also write to it in its window, and its answer to that stays in the window. When the owner asks there to be written to in their chat, the agent sends those words with the tool `tell_owner` (`text`, 1 to 50000 characters): Hornhoof keeps each call's words as one `reply` with `messageId` `null` and no `reply_end`, and wakes the program as for any event. The program shows these words to the owner, and never sends them back as a turn.
* In Hornhoof it acts with the owner's rights, through the tools in "MCP" below; `send_message` does not write to itself. While the assistant's card has a skills address, it asks the program for the program's own skills with `persona_call`, and gives the program files by their ids: see "Skills" and "GET /api/assistant/attachments/:id".

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

Where there is a `reason`, `message` says to the owner why, in one neutral phrase that reads after what did not go, such as "<file name> did not come: " (in Russian "<file name> не дошел: "): in Russian when the call's `Accept-Language` starts with `ru`, and in English otherwise. For example, with `Accept-Language: ru`, the owner reads "Отчет.pdf не дошел: такого файла в Hornhoof нет, его удалили через 30 дней, или вам его там не открыть." from:

```json
{ "error": { "code": "not_found", "message": "такого файла в Hornhoof нет, его удалили через 30 дней, или вам его там не открыть.", "reason": "attachment_unknown" } }
```

| Status | `reason` | When |
| --- | --- | --- |
| 400 | none | The body or the query is not as below. `message` names the field. |
| 401 | `assistant_key_invalid` | No key, a key in another form, a replaced or revoked key, or an assistant that is switched off. |
| 403 | `assistant_owner_inactive` | The owner is switched off or gone. |
| 403 | `assistant_agent_refused` | The owner does not write to this agent. |
| 403 | `decision_not_allowed` | The owner does not take this decision. |
| 404 | `agent_unknown` | There is no such agent in the company, or it was removed. |
| 404 | `request_unknown` | There is no such request in the company. |
| 404 | `attachment_unknown` | There is no such file visible to the owner: see "GET /api/assistant/attachments/:id". In a message, a file not sent for that agent with `POST /api/assistant/files`. |
| 400 | `file_empty` | The file sent has no bytes. |
| 413 | `file_too_big` | The file sent is over 50 MB, and this Hornhoof keeps no bigger files: its machine has no `FILES_DIR`. |
| 413 | `attachment_invalid` | Hornhoof has no room left for the company's files. |
| 410 | `file_lost` | A file over 50 MB is not on the machine that serves Hornhoof now: see "Big files". |
| 410 | `file_link_expired` | A file's link from a `reply` is older than 7 days: see "GET /api/files/&lt;link&gt;". |
| 409 | `orchestrator_not_ready`, `agent_not_ready` | The agent cannot answer right now, for example while it has no plan to run on, or the message has no `agentId` and the assistant has no agent of its own yet. Try again later. |
| 409 | `request_closed` | The request is answered already. |
| 400 | `task_invalid` | The answer does not fit the request: see "Answer a request". |

### GET /api/assistant/me

Who the assistant is, whom it acts for, and what that person is in the company now.

```json
{
  "assistant": { "id": "…", "name": "Ava", "title": "", "program": "avaclone", "agentId": "…", "agentReady": true },
  "owner": {
    "id": "…", "name": "Olga", "title": "Head of development",
    "ceo": false, "ceoDelegate": false, "wholeCompany": false,
    "departments": [{ "id": "…", "name": "Development" }],
    "teams": [{ "id": "…", "name": "Payments", "departmentId": "…" }],
    "responsibleFor": [{ "id": "…", "name": "Development" }],
    "telegram": { "username": "olga_k", "id": 5550001 }
  },
  "company": { "name": "Acme" },
  "contract": 3
}
```

* `contract` is the version of this API the server keeps. 3 supports attachment downloads with `GET /api/assistant/attachments/:id`, files sent with `POST /api/assistant/files` and named in a message's `files`, the `files` an agent attaches to a `reply` with a link to each, `message` in the owner's language, and adds `byOwnAgent` to `reply` and `reply_end`. It keeps the message limits of 2: `freshText` and up to 50000 characters of `text`. A server that gives no `contract` keeps the first version: it refuses a message with `freshText` (400) and takes up to 20000 characters of `text`. Send `freshText` only to a server that gives 2 or more.
* `program` is `avaclone`, `openclaw`, `hermes` or `other`.
* `agentId` is the assistant's own agent, or `null` until its owner picks a plan for it. `agentReady` is true while that agent can answer now: it has a plan, and the plan is ready on a machine that is online. Read it again from time to time, for example every minute, to tell the owner when the agent stops being ready.
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

`kind` is `orchestrator`, `head`, `worker` or `assistant`, the own agent of one of the owner's assistants. `role` and `department` are given in English and Russian, or are `null`.

### POST /api/assistant/messages

Writes to an agent for the owner, as the owner would in the agent's window.

```json
{ "agentId": "…", "text": "How are the leads this week?", "freshText": "…", "files": ["…"] }
```

* `agentId`: the agent to write to. Without it, the message goes to the assistant's own agent; while there is none, the call answers `409 agent_not_ready`.
* `text`: 1 to 50000 characters after spaces at both ends are trimmed. It may be left out when `files` has a file; the agent then reads the files' names as the words.
* `freshText`, optional: 1 to 200000 characters after the same trimming. The whole conversation for the assistant's own agent, which reads it instead of `text` when its turn starts a new session: see "The assistant's own agent". Hornhoof leaves it aside for any other agent.
* `files`, optional: up to 10 ids from `POST /api/assistant/files`, each sent for this same agent. The agent gets each file as a file its owner sent from its window: its name and the command that opens it, and the window shows it with the message. No other field is allowed.
* Characters are counted as JavaScript counts a string's length, in UTF-16 code units. Hornhoof never cuts a text: a longer one answers `400`. The whole body may be up to 2 MiB, so both texts fit even when every letter is written as a `\uXXXX` escape; a bigger body answers `413`.
* Answers `202` with the message's id. The agent's answer comes later, as events with that id.

```json
{ "message": { "id": "…", "agentId": "…" } }
```

The agent reads the message as the owner's own words, marked as written by the assistant, and is told who the owner is in the company. A message to an agent that is busy waits for it, as a person's does. If the message answers a question the agent asked the owner in its window, Hornhoof records it as the owner's answer given by the assistant.

### POST /api/assistant/files?name=&lt;file name&gt;&amp;agentId=&lt;id&gt;

Sends a file for a message to an agent, as its owner adds one in the agent's window. Any file goes: a photo, a video, a voice message, an archive, a table, of any type and any format. The body is the file's raw bytes, under the `Content-Type` the program has for it, or `application/octet-stream`; Hornhoof keeps the bytes as they came and reads no type from them but a PNG, JPEG or WebP picture's.

```
POST /api/assistant/files?name=IMG_0042.heic&agentId=8a3c…
Authorization: Bearer hha_…
Content-Type: image/heic

<the file's bytes>
```

* `name`: the file's name, which the agent and the window show. Without it a file is called `file`, or `picture.png` (`.jpg`, `.webp`) for a picture.
* `agentId`: the agent the message goes to. Without it, the assistant's own agent, as for a message.
* Answers `201` with the file's id and the name it is kept under. Name the id in `files` of the next `POST /api/assistant/messages` to the same agent; until then the file goes nowhere.

```json
{ "file": { "id": "3f0c9a6e-…", "name": "IMG_0042.heic" } }
```

* A file of any size goes, while the company has room for it: see "Where files are kept".
* Refusals, each with words for the owner in `message`: `400 file_empty` for no bytes, `413 attachment_invalid` when Hornhoof has no room left for the company's files, and for the agent the same as for a message (`404 agent_unknown`, `403 assistant_agent_refused`, `409 agent_not_ready`).
* When a file is refused, tell the owner "<file name> did not come: " and the words of `message`. When the program still sends the rest of the message, add a line to `text` naming the file that did not come and why, so the agent knows of it too.
* Hornhoof keeps a file 30 days after it was sent, as every file of a message.

### Where files are kept

Every file, of any size, goes into the company's file store as it comes, never whole in memory. The store keeps it sealed on every machine that keeps the company's data and on the machines picked to keep its backups, so losing one machine loses no file. The database keeps only its name, size and hash.

* When the machine Hornhoof runs on lacks a file, it asks the machines that hold it. If none of them answers within 30 seconds, every download of it, by link too, answers `503 file_away`. Try again once the machine is back.
* A file kept on one machine before the store, whose machine is gone, answers `410 file_lost`.
* A `reply` of an older Hornhoof may say `big: true` of a file. Nothing else differs: give the owner its `url` as for any file.

### GET /api/assistant/events?after=&lt;seq&gt;&amp;wait=&lt;seconds&gt;

The assistant's events after a number, oldest first, at most 100 at a time. This is a long poll.

* `after`: a whole number, 0 or more; 0 when left out. Pass the `next` of the answer before.
* `wait`: whole seconds, 0 to 50; 0 when left out. When there is no event after `after`, Hornhoof holds the call for up to this long and answers as soon as one comes. With 0 it answers at once.
* More than 50, a negative number or any other parameter answers `400`.

```json
{
  "events": [
    { "seq": 41, "kind": "reply", "at": "2026-11-11T10:00:03.000Z", "data": { "messageId": "…", "agent": { "id": "…", "name": "Hana", "kind": "head" }, "byOwnAgent": false, "text": "On it." } }
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
| `reply` | `{ messageId, agent: { id, name, kind }, byOwnAgent, text, files }` | Words of the agent's answer to the assistant's message. A long answer comes as several replies, in order. `files` is there only when the agent attached files to these words: see below. |
| `reply_end` | `{ messageId, agent: { id, name, kind }, byOwnAgent, answered, failed }` | The answer to the message is over. `answered` is false when the agent said nothing; `failed` is true when its turn failed. |
| `request` | `{ request }` | A request now waits for the owner. `request` is as in `GET /api/assistant/requests`. |
| `request_closed` | `{ requestId, status }` | The request waits for the owner no more: it was answered, here or in Hornhoof, withdrawn, or no longer the owner's. `status` is the request's status now: `open`, `answered`, `approved`, `declined`, `withdrawn` or `resolved_internal`. |

`files` in a `reply` lists the files the agent attached to its answer with `hh-attach --chat`, each as `{ id, name, url }`, and `big: true` for a file over 50 MB, and `text` may then be empty. Download each with `GET /api/assistant/attachments/:id` and pass it on to the owner under its name. `url` downloads the same file for 7 days with no key and no sign-in, for the owner to open on a phone: give it to them next to the file, and in place of a file their chat does not take, such as one over the 50 MB a Telegram bot sends. When one cannot be downloaded or delivered, tell the owner plainly that it did not arrive and why, and write it to the agent with `POST /api/assistant/messages`, so both know.

`byOwnAgent` is true when the assistant's own agent sent the original message through `send_message`, and false when the assistant program sent it through HTTP or MCP. It names the sender of the original message, not the agent answering it. The value stays the same in every `reply` and the `reply_end` for that message, including after a restart or continued turn. A direct `tell_owner` reply has `byOwnAgent: true`. Events kept before contract 3 retain their earlier data; old events are not rewritten. Pending answers started before the update use false.

`messageId` is `null` in a `reply` only when it holds words the assistant's own agent (`data.agent.id` is the `agentId` of `GET /api/assistant/me`) sends its owner on its own, with `tell_owner`, and answers no message of the program. No `reply_end` follows it. Show every such reply to the owner as it is, and never send it back to the agent as a message.

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

### GET /api/assistant/attachments/:id

Downloads a file its owner may download in Hornhoof now, by its attachment id. This includes files on tasks, in agent chats and in messages or requests, and files the assistant's own agent put there. The ids come in a `reply`'s `files` and in a skill's arguments: see "Skills". The call carries the key as every call does.

```
GET /api/assistant/attachments/3f0c9a6e-…
Authorization: Bearer hha_…
```

Answers `200` with the file's bytes exactly as they were kept, and these headers:

```
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 512
Content-Disposition: attachment; filename="_____ ___ cafe.pdf"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D0%B5%D1%82%20%D0%BC%D0%B0%D0%B9%20caf%C3%A9.pdf
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'
```

* `Content-Type` is the type Hornhoof kept the file with. A file uploaded by `hh-attach` is kept as `image/png`, `image/jpeg` or `image/webp` for a chat picture, and `application/octet-stream` for any other file.
* `Content-Disposition` carries the file's name twice. `filename*` is the whole name in UTF-8, percent-encoded (RFC 5987); take it. `filename` is the same name in plain ASCII for a program that does not read `filename*`: a letter with marks goes without them, and any other letter, a quote, a backslash or a line break goes as `_`.
* The same file downloads as often as the program asks for it while its owner still has access. Downloading it removes nothing. Ordinary task and chat retention rules apply.
* Each download uses the same visibility rule as the owner's interface, with the owner's current rights. An unavailable file, a file of another company, an id nothing has and something that is no id at all all answer the same `404 attachment_unknown`, with the same body and headers, so the answer never tells whether such a file exists. Hornhoof's screenshots of agent programs and operator case files remain unavailable through this route, even when the owner may see the case in the interface.
* No key, a key in another form, a replaced or revoked key, or an assistant that is switched off answer `401 assistant_key_invalid`, as for every call, before the id is looked at; an owner who is switched off or gone `403 assistant_owner_inactive`.

### GET /api/files/&lt;link&gt;

The `url` of a file in a `reply`. It downloads that one file with no key and no sign-in, so the owner opens it on a phone, and it works for 7 days after the reply was made. Hornhoof signs it with the company's secret, so a link changed in any way opens nothing.

```
GET /api/files/eyJmIjoiM2YwYzlhNmUt….Jx0v…
```

* Answers `200` with the file's bytes and the headers of `GET /api/assistant/attachments/:id`.
* After the 7 days it answers `410 file_link_expired`; ask the agent for the file again. A big file not on the machine that serves Hornhoof now answers `410 file_lost`. A link changed in any way, signed for anything else, or of a file Hornhoof no longer keeps answers `404 attachment_unknown`. The words in `message` follow the phone's `Accept-Language`.
* Anyone who has the link opens the file until the 7 days end: pass it only to the owner.

## MCP

A program that is an MCP client, such as OpenClaw, Hermes Agent, Claude Code or Codex, may take the calls above as MCP tools instead of making them itself.

* The address is the company's Hornhoof address and `/api/assistant/mcp`, over Streamable HTTP. Every request is a POST with the key, `Authorization: Bearer hha_…`, as every call carries it. There are no sessions, and `GET` and `DELETE` answer `405`.
* A request without a valid key answers `401 assistant_key_invalid`, and one while the owner is switched off or gone `403 assistant_owner_inactive`, before any tool runs.

| Tool | Arguments | Does what this call does |
| --- | --- | --- |
| `who_am_i` | none | `GET /api/assistant/me` |
| `list_agents` | none | `GET /api/assistant/agents` |
| `send_message` | `agentId`, `text`, `freshText` optional | `POST /api/assistant/messages` |
| `read_events` | `after`, `wait`, both optional | `GET /api/assistant/events` |
| `list_requests` | none | `GET /api/assistant/requests` |
| `answer_request` | `requestId`, and `answer`, `pick`, `approve` or `retry` as in the call's body | `POST /api/assistant/requests/:id/answer` |

* A tool checks what the call checks, acts with the same rights and answers with the call's JSON, as text. Files go only over the calls above: `send_message` takes no `files`.
* `send_message` also gives `next`: the number of the assistant's newest event before the message. Its answer comes after it, so `read_events` with `after` set to `next` reads the answer.
* A refusal comes back as a tool error (`isError: true`) whose text is the call's error body, `{ "error": { "code", "message", "reason" } }`, with the same `reason`. Arguments that do not fit the tool's schema are refused in words before the call.
* `read_events` with a `wait` holds the tool call as the long poll holds the call, for up to 50 seconds. Give tool calls at least 60 seconds in the program's settings.
* The assistant's own agent has these tools inside Hornhoof, with two more: `tell_owner` (`text`), see "The assistant's own agent", and, only while the assistant's card has a skills address, `persona_call` (`name`, `arguments`), see "Skills". The address `/api/assistant/mcp` offers neither.

## Skills

When the assistant's card has a skills address, the assistant's own agent asks the program to do what only the program can do, for example to look at the owner's calendar, with the tool `persona_call`. The program tells the agent which skills there are and what they take, in its messages; Hornhoof does not check the names.

* The agent has `persona_call` among its tools, and its instructions tell it of the tool, only while the card has a skills address. Without one it neither sees the tool nor hears of it, and is told to promise no skill of the program and to ask its owner to set nothing up for one. The list of tools is made anew from the card as it is at each request for it, so the next list after the address is set or cleared shows the change.
* The agent's program reads the list as it connects to Hornhoof's tools. Setting or clearing the address changes the agent's instructions too, so its next turn starts its program anew in a new session, which reads the list again, and reads the message's `freshText` when the program sends one. A change from one address to another changes nothing of that: the agent goes on in its session, and its calls go to the new address.
* A call of `persona_call` while the card has no skills address, for example from a list read before the address was cleared, is refused in words the agent reads (`This assistant has no skills address, …`), and nothing is sent.

Hornhoof sends each call as this POST and holds the tool call until the answer:

```
POST <skills address>
Content-Type: application/json
X-Hornhoof-Timestamp: 1763000000
X-Hornhoof-Signature: sha256=<64 hex characters>

{"messageId":"d41e…","name":"calendar_today","arguments":{}}
```

* `messageId` is the message of `POST /api/assistant/messages` whose answer the agent is working on, or `null` when it was not answering one, for example when its owner wrote in its window.
* `X-Hornhoof-Timestamp` is the time of the call in whole seconds. `X-Hornhoof-Signature` is `sha256=` and the HMAC-SHA256 of the timestamp, a dot and the exact body bytes, under the signing secret as a UTF-8 string, in lowercase hex. Check it against the raw body, before parsing it, with a comparison in constant time, and drop a call whose signature does not match or whose timestamp is more than 5 minutes from the program's clock.
* Answer with a 2xx status and this JSON, within 120 seconds and at most 100 KB:

```json
{ "ok": true, "text": "Two meetings today: 11:00 with Oleg, 15:30 with the bank.", "data": { "meetings": 2 } }
```

* The agent reads `text`, followed by `data` as JSON when there is `data`. With `ok` false, it reads these as a failure of the skill, with an explicit instruction not to report success, to explain the reason, and for a refused file delivery to tell the owner the file did not arrive.
* Any other status, a redirect, no answer within 120 seconds, a bigger answer or a body without `ok` and `text` is a failure the agent reads in words. Hornhoof does not try a call again; the agent decides.
* The skills address is an `http` or `https` address of at most 500 characters. Use `https` unless the program runs on the same machine or network as Hornhoof.

### A file for a skill

A skill may take a file the agent makes or has, for example a report to put in the owner's calendar, or to send in the owner's chat when the agent answers no message of the program. A file the agent attaches while it answers a message of the program goes to the owner by itself, in the reply's `files`. The file goes to a skill by its id:

1. In its turn, the agent puts the file in Hornhoof with `hh-attach --chat FILE` (any file; one over 50 MB is a big file), which prints the file's name and its id. Its instructions tell it to.
2. The agent calls `persona_call` with that id in the skill's arguments, under the name the program's message gives for it, for example `{"name":"send_file","arguments":{"attachmentId":"3f0c9a6e-…"}}`.
3. The program downloads the file with `GET /api/assistant/attachments/3f0c9a6e-…` and its key, takes the name from `Content-Disposition`, and answers the skill's call.

Hornhoof serves the bytes; the assistant program performs the external delivery. A successful download is no proof that a file reached Telegram or another destination. The program returns `ok: false` when it refuses delivery, and says in `text`, in words, what did not happen and why, for example "The file did not reach Telegram: it is over 50 MB." rather than a code such as `file_unknown`; the agent receives that refusal through `persona_call` as an error, with instructions to tell the owner the file did not arrive. Hornhoof cannot detect a delivery failure the program does not report.

The program may download the file again, for example when it tries again. Hornhoof keeps the file 30 days after the agent put it, as every file of an agent's chat.

## Wake

When the assistant's card has an events address, Hornhoof also wakes the program there each time a new event of the assistant is kept, so it need not hold a long poll open. A wake for AvaClone and other programs is this POST; OpenClaw and Hermes Agent take it in their own form, below:

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

### A wake for OpenClaw and Hermes Agent

A wake of these programs starts a turn of their model, which costs and may write to the owner. So Hornhoof wakes them only for an event worth a turn: a `reply_end` or a `request`. A `reply` or a `request_closed` waits for the next wake, whose `after` is then the smallest. Tries, pauses and redirects go as above.

OpenClaw, at its wake hook:

```
POST <events address>
Authorization: Bearer <signing secret>
Content-Type: application/json

{"text":"New events wait for you in Hornhoof after number 40. Read them with the Hornhoof tool read_events, with after 40, and tell your owner what they need to know.","mode":"now"}
```

* The events address is the gateway's address and `/hooks/wake`, for example `http://192.0.2.10:18789/hooks/wake`, and the signing secret is the hook's token (`hooks.token`).
* OpenClaw puts the text into the agent's main session and runs it as soon as the session is free ([webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks), [hooks settings](https://docs.openclaw.ai/gateway/config-hooks)).

Hermes Agent, at its webhook route:

```
POST <events address>
Content-Type: application/json
X-Webhook-Timestamp: 1794448160
X-Webhook-Signature-V2: <64 hex characters>
X-Request-ID: hornhoof-<assistant id>-40

{"type":"wake","after":40}
```

* The events address is the webhook's address and the route, for example `http://192.0.2.10:8644/webhooks/hornhoof`.
* `X-Webhook-Signature-V2` is Hermes' generic V2 signature: the HMAC-SHA256 of the timestamp, a dot and the exact body, under the signing secret as a UTF-8 string, in lowercase hex. The timestamp is in whole seconds, and Hermes takes it within 5 minutes of its own clock.
* `X-Request-ID` is the same on every try of one wake, so Hermes runs it once.
* The route's `prompt` puts the number in place of `{after}` and runs it as a new turn; its answer goes where the route's `deliver` says ([webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks)).

## Connecting OpenClaw

1. In People, add the assistant for its owner and choose the program OpenClaw. For wakes, give the events address: the address at which Hornhoof reaches OpenClaw's gateway, then `:18789/hooks/wake`, for example `http://192.0.2.10:18789/hooks/wake`. The gateway listens only on its own computer unless `gateway.bind` says otherwise, so Hornhoof reaches it over a private network or through a reverse proxy with HTTPS. Without an events address, OpenClaw still has the tools, but nobody wakes it.
2. On the assistant's card, make the key. The window shows "Settings for OpenClaw". Copy them.
3. Put them into `~/.openclaw/openclaw.json` on the computer where OpenClaw runs, next to what is there: the `hornhoof` server under `mcp.servers`, and the `hooks` block. OpenClaw takes both without a restart.
4. Ask OpenClaw, for example in Telegram, who you are in Hornhoof. It answers with `who_am_i`.

The settings, with the company's address, the key and the signing secret in place:

```json5
{
  mcp: {
    servers: {
      hornhoof: {
        url: "https://hornhoof.example.com/api/assistant/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer hha_…" },
      },
    },
  },
  hooks: {
    enabled: true,
    token: "hhs_…",
  },
}
```

The `hooks` block is there only when the card has an events address. OpenClaw's own pages: [MCP servers](https://docs.openclaw.ai/tools/mcp), [MCP transports](https://docs.openclaw.ai/cli/mcp/transports), [webhooks](https://docs.openclaw.ai/automation/cron-jobs/webhooks).

## Connecting Hermes Agent

1. In People, add the assistant for its owner and choose the program Hermes Agent. For wakes, give the events address: the address at which Hornhoof reaches the computer Hermes runs on, then `:8644/webhooks/hornhoof`, for example `http://192.0.2.10:8644/webhooks/hornhoof`. Without an events address, Hermes still has the tools, but nobody wakes it.
2. On the assistant's card, make the key. The window shows "Settings for Hermes Agent". Copy them.
3. Put them into `~/.hermes/config.yaml` on the computer where Hermes runs, next to what is there: the `hornhoof` server under `mcp_servers`, and the `hornhoof` route of the webhook under `platforms`. Where the file has `platforms` already, `webhook` goes under it. Then start Hermes' gateway again, so it reads them.
4. The answer to a wake goes to the home chat of Hermes in Telegram (`deliver: telegram`), and with `mirror_to_session` into that chat's conversation too, so the owner answers it there. For another chat, set `deliver_extra` with its `chat_id`, or another program in `deliver`.
5. Ask Hermes, for example in Telegram, who you are in Hornhoof. It answers with `who_am_i`.

The settings, with the company's address, the key and the signing secret in place:

```yaml
mcp_servers:
  hornhoof:
    url: "https://hornhoof.example.com/api/assistant/mcp"
    headers:
      Authorization: "Bearer hha_…"
platforms:
  webhook:
    enabled: true
    extra:
      routes:
        hornhoof:
          secret: "hhs_…"
          prompt: "New events wait for you in Hornhoof after number {after}. Read them with the Hornhoof tool read_events, with after {after}, and tell your owner what they need to know."
          deliver: telegram
          mirror_to_session: true
```

The `platforms` part is there only when the card has an events address. Hermes' own pages: [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [webhooks](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks).

## Limits

| What | Limit |
| --- | --- |
| Message text | 1 to 50000 characters, or none with files |
| Files of a message | up to 10, of any size, kept 30 days; one over 50 MB on one machine only |
| A message's `freshText` | up to 200000 characters |
| A message's body | 2 MiB |
| Long poll wait | 0 to 50 seconds |
| Events in one answer | 100 |
| Events kept | 30 days |
| End of an answer after its turn | 30 seconds with no turn going on from it |
| Wake | 10 seconds to answer, 12 tries, pauses from 1 second doubling to 5 minutes |
| Events address | `http` or `https`, at most 500 characters |
| Skills address | `http` or `https`, at most 500 characters |
| Skill call | 120 seconds to answer, at most 100 KB |
| A file of the own agent | any size, from `hh-attach --chat`, kept 30 days; one over 50 MB on one machine only |
| A file's link in a `reply` | 7 days |
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
# {"events":[{"seq":57,"kind":"reply","at":"…","data":{"messageId":"d41e…","agent":{"id":"8a3c…","name":"Hana","kind":"head"},"byOwnAgent":false,"text":"Bruno has the payment form done and asks which provider to use."}}],"next":57}

curl -s -H "$H" "$BASE/api/assistant/events?after=57&wait=50"
# {"events":[{"seq":58,"kind":"request","at":"…","data":{"request":{"id":"f19b…","kind":"choice","topic":"task","text":"Which payment provider do we take?","options":["Stripe","PayPal"],"answerable":true,…}}},
#            {"seq":61,"kind":"reply_end","at":"…","data":{"messageId":"d41e…","agent":{…},"byOwnAgent":false,"answered":true,"failed":false}}],"next":61}

# Ava asks Olga in her own chat, and Olga says Stripe.
curl -s -H "$H" -H 'Content-Type: application/json' -d '{"pick":0}' $BASE/api/assistant/requests/f19b…/answer
# 200 {"request":{"id":"f19b…","status":"answered","picked":0,"answer":null}}

curl -s -H "$H" "$BASE/api/assistant/events?after=61&wait=50"
# {"events":[{"seq":64,"kind":"request_closed","at":"…","data":{"requestId":"f19b…","status":"answered"}}],"next":64}
```

A program keeps `next` where it survives a restart, reads `GET /api/assistant/requests` when it starts, and then long polls, or waits for wakes, from the `next` it kept.
