# How outbound messages leave

The dispatcher is the only thing that sends. It runs on the server's own minute, whatever any agent does, and reads an account's
settings itself. No tool, view, job, log or model ever gets them. Design: task #403, sections 8 and 9.

## Sending accounts

A department's owner, the CEO or the CEO delegate sets an account up, in person: a model cannot, even in a turn answering them.

| Route | What it does |
| --- | --- |
| `POST /api/outbound/accounts` | `{channelId, label, config}`. Seals the settings. They never come back. |
| `GET /api/outbound/channels/:id/accounts` | Names, states, generations and who writes from each. No settings. |
| `POST /api/outbound/accounts/:id/rotate` | `{config}`. New settings at a new generation. Reservations made under the old ones end. |
| `POST /api/outbound/accounts/:id/revoke` | For good. Its settings are erased. |
| `POST /api/outbound/accounts/:id/bind` | `{agentId}`. Its one author from now on, at a new binding generation. |
| `POST /api/outbound/accounts/:id/release` | Nobody writes from it any more. |
| `POST /api/outbound/attempts/:id/settle` | `{outcome, evidence}`. A person's word on an attempt whose end is unknown. |

SMTP settings: `{host, port, security: "tls" | "starttls", username, password, from, eventKey?, ca?}`.
HTTPS settings: `{endpoint, signingKey, readback?, ca?}`. A key has at least 32 characters.

The sender domain, which the daily limits count by, is read from `from` or from the endpoint's host, and an account keeps it.

An account has one author and an author has one account. Neither changes while an attempt of the account is reserved, on its way
or unknown. What the last author queued does not move to the next one: its next look ends it with `stale_binding`.

A refused sign-in marks the account `invalid` until someone rotates its settings, so a wrong password is not tried over and over.

## What each outcome means

| Outcome | Meaning | What follows |
| --- | --- | --- |
| `accepted` | The transport took it. Not proof that anyone received it. | Counts as sent. |
| `definitely_not_accepted` | There is proof it did not leave. | Its place in the day's limit comes back. |
| `unknown` | It may have left: a lost connection, a timeout, a crash. | It keeps its place and closes the account for new sends. Nothing sends it again. |

An unknown attempt ends by a webhook's read-back, or by a person's `settle`. SMTP has no way of asking, so a person settles those.
A worker gone past its five-minute lease only ever becomes unknown.

## The HTTPS channel, from the receiver's side

One `POST` to the configured endpoint, with no redirects followed and no address outside public ones reached:

```
content-type: application/json
idempotency-key: <attemptId>
x-hornhoof-timestamp: <unix seconds>
x-hornhoof-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>" with the signing key>

{"attemptId": "...", "recipient": "...", "subject": "...", "text": "..."}
```

The receiver takes a message with a 2xx and `{"attemptId": "<the same>", "receipt": "<up to 512 characters>"}`. Any other 2xx body is
`unknown`. A 4xx says it was refused, except 408, 409 and 425, which are `unknown`, as is a 3xx or 5xx.

With `readback: true` the server asks about an unknown attempt each minute: a `GET` to the endpoint with `?attempt=<attemptId>`, signed
over the attempt id. A 200 with the same body as above means it took the message. Anything else leaves it unknown, so a message the
receiver never got still takes a person's `settle`. Only set `readback` on a receiver that keeps a durable record by attempt id.

## What came back after a message left

A provider reports deliveries, bounces, refusals and complaints to `POST /api/outbound/accounts/:id/events`, signed as above with the
account's key: `signingKey` for HTTPS, `eventKey` for SMTP. An account with no key takes no events.

```
{"events": [{"attemptId": "...", "kind": "delivered" | "bounce" | "refusal" | "complaint", "providerEventId": "...", "occurredAt": "<ISO time>"}]}
```

An event counts once by its `providerEventId`, and only for this account's attempts.

Once the channel's policy window holds at least `minimumSample` accepted messages, more complaints, refusals or bounces than its limits
stop the channel at a new generation. Nothing new leaves after that stop commits; what was already handed over cannot be called back. Only
a person reopens it. Each stop is told once to the department's head and the orchestrator, by generation.

## Model checks

`freshModelCheck` in `apps/server/src/modules/jobs/dispatch.ts` calls a vendor's API straight from the server, with one system and one user
message and nothing that could give a model a tool, a session or anyone's history. A job would not do: a node runs every job in its
program with that program's own tools.

So only API keys (`anthropic_api`, `openai_api`) can review. A company with personal plans only gets `unavailable`, and what waits for a
check keeps waiting.

A binding's `inferenceConfigHash` must be `FRESH_INFERENCE_HASH`, and its `revisionId` must be the model name the vendor's answer gives.
An answer from any other model is `unavailable`.
