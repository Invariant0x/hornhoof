# Feedback to Hornhoof developers

How a bug, an improvement or an idea goes from any Hornhoof installation to Hornhoof's developers, and what the service at
hornhoof.org has to do for it. The code is `apps/server/src/modules/feedback/`.

## Which installation is which

`FEEDBACK_INBOX=true` in the `.env` of a server makes it Hornhoof's own installation. Without it, or with `false`, an
installation is like any other:

| | Any installation | Hornhoof's own |
| --- | --- | --- |
| A finding an agent files with `propose_improvement` and `scope: platform` | Is not taken into the company's work; a person sends it from its card | Is taken into work like any other |
| The Feedback window | Sends through hornhoof.org | Puts the report straight into its own inbox |
| `POST /api/feedback/inbound` and the inbox | Answer 404 | Take reports and list them |

## What leaves an installation

Only what a person sees in the Feedback window and sends with their own press. The server cleans the title and the
description (`clean.ts`): keys, tokens, passwords, addresses other than Hornhoof's own pages, email and paths in a home
folder become `[secret]`, `[address]`, `[email]` and `[path]`. Beside them go the Hornhoof version, the systems of the
company's machines in use without their names, and the error code of a finding that has one. The window shows exactly
this and a digest of it; a send whose digest differs is refused, so what goes is what was shown.

A report, version 1:

```json
{
  "v": 1,
  "installation": "32 hex characters, a one-way hash of the installation's secret",
  "kind": "bug | improvement | idea",
  "title": "1 to 200 characters",
  "text": "up to 5000 characters",
  "facts": { "version": "0.18.11", "platform": ["linux x64"], "errorCode": "terminal_lost or null" }
}
```

## The path through hornhoof.org

The server of an installation, never the browser, sends `POST {RELAY_URL}/api/v1/feedback` with the report as JSON.
`RELAY_URL` is `https://hornhoof.org` unless set.

**What the relay has to do.** This repository has no code of the relay (`relay.py` of hornhoof.org); its owners update
it with a release. Hornhoof's own installation is at `https://hornhoof-team.hornhoof.org`, and its `.env` has
`FEEDBACK_INBOX=true`. The contract:

1. The relay takes `POST {RELAY_URL}/api/v1/feedback` with `Content-Type: application/json`.
2. It sends `POST https://hornhoof-team.hornhoof.org/api/feedback/inbound` with the body byte for byte as it came,
   `Content-Type: application/json` and no `Origin` header. It adds nothing to the body and takes nothing out.
3. It gives the installation back the inbox's status and body as they are, with the inbox's `Retry-After` header when
   there is one: 202, 400, 413 or 429.

Until the relay does this, an installation shows "hornhoof.org does not answer now" and nothing is lost on its side: the
finding stays open. The tests check both ends against stand-ins (`apps/server/test/fake-relay.ts`), never the live
network.

What the inbox answers:

| Status | When |
| --- | --- |
| 202 `{ "received": true }` | Taken |
| 400 | Not a report of version 1, or a field out of its limits |
| 413 | A body over 16 KB |
| 429 with `Retry-After` | Over 10 reports in an hour from one installation, or over 200 new cards in an hour from all |
| 404 | The server is not Hornhoof's own installation |

## The inbox

A report like one already there adds a signal to its card: the same kind, error code and title, compared in lowercase with
every number the same. A card counts its signals and the installations they came from, and keeps the versions and
machines they named. Priority: high for a bug from 3 or more installations, normal for any other bug and anything from 3
or more installations, low for the rest. People who see the whole company read the inbox from the account menu and turn a
card into an issue in `invariant0x/hornhoof` with one press. The key is the GitHub key the company saved for
`invariant0x`, its own first, then a department's; it needs Issues: Read and write. Everything that came from installations
goes into the issue inside code blocks, so nothing in it links, mentions or runs.
