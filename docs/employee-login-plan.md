# Employee sign-in in the person's own browser, task 1075

Architecture at base `90fafcc06d183b8e4249e6c083ecd385bd232371` on `task-1075`.
Task kind: unknown path. Risk: access, saved platform sign-ins per employee.
This file is a plan, not a claim that the feature or its checks have shipped.

## Acceptance

An employee card gains a "Sign in as employee" button that names a platform or
an address. Pressing it opens an ordinary browser on the person's own machine,
driven by the person, not by automation at the moment of sign-in. The person
signs in and passes every platform check themselves. Hornhoof then saves that
sign-in (the platform's cookies and session storage) encrypted, kept for that one
employee. The card shows "sign-in to <platform> saved by <who>, at <when>" and a
one-press revoke. Only that employee may read, use or revoke it; a foreign
employee and a foreign department get 403 from the server. The sign-in values
never appear in logs, tasks, API replies (except the issue to that employee's own
node tool) or screenshots. `hh-browse` opens pages carrying that saved sign-in.
When the sign-in is absent or has expired, the tool says so plainly, and the
employee tells the person "you need to sign in again" rather than trying to get
past the sign-in. The shared skill `templates/skills/hh-web-pages.md` describes
how to ask the person for a sign-in, replacing the present rule that forbids it.

Boundaries: no bypass of a platform's protections, no change to any signal a site
can observe about the browser. The person signs in themselves in a real browser.

## Why the platform does not see automation

The platforms refuse a browser under program control because such a browser is
observably automated: Playwright and other CDP clients set `navigator.webdriver`,
expose the DevTools protocol, and launch Chromium with `--enable-automation` and
the `AutomationControlled` blink feature. A site reads these and shows "this
browser or app may not be secure".

The capture browser avoids every one of those signals, not by hiding them but by
not creating them:

- The node launches the real browser executable as a plain child process pointed
  at the sign-in address, the same way a person launches their browser. It does
  not use Playwright, CDP or any automation driver. There is no
  `--remote-debugging-port`, no `--enable-automation`, no `AutomationControlled`.
  `navigator.webdriver` stays `false` because nothing set it.
- The only flags passed are a dedicated `--user-data-dir` for an isolated capture
  profile and, for a deterministic offline read of the saved cookies,
  `--password-store=basic` (plus `--use-mock-keychain` on Linux). These change
  only how the browser encrypts secrets on local disk. They are invisible to any
  page: a site cannot observe the local password-store backend. They are not a
  browser-fingerprint change and not a protection bypass.
- The person performs the sign-in, including any two-factor step and any robot
  check. Hornhoof does nothing to answer a challenge.

So the site sees a genuine, person-driven browser, because that is what it is.
The justification required by the task is exactly this: we add no observable
automation signal, so there is nothing for the platform to refuse.

## The honest limit: a saved sign-in is often reset when the node replays it

The head asked (Ivan via David AI, 16.11) whether a captured sign-in is reset
when the node uses it. For two of the named platforms it will frequently be, and
the result to Ivan must say so plainly.

- `hh-browse` reads a page by driving Chromium through Playwright. Reading the DOM
  requires automation; there is no way to both avoid automation signals and
  extract page text and links. So `hh-browse` replaying a saved sign-in is an
  automated browser, and Google can detect that on its account pages and end the
  session, returning a sign-in page.
- Google also binds a session to device and network signals. A session cookie
  captured in the person's browser on their machine, replayed from the node's
  headless Chromium on a server address, can trigger a re-check and be
  invalidated.
- ArtStation sits behind Cloudflare. The `cf_clearance` cookie is bound to the
  address and user agent that earned it. Replayed from the node's address and
  user agent it is rejected and a fresh challenge appears.

When this happens `hh-browse` reports `login_required` or `robot_check` and the
employee asks the person to sign in again. It never tries to get past the check.

Faithful, non-spoofing mitigations that raise the survival rate, and their limit:

- Replay with the same user agent string that the capture browser really sent.
  This is reusing a real value we recorded, not inventing a false one.
- Prefer to replay on the same machine and egress that captured the sign-in, so
  address-bound cookies see a stable address.
- These help address-bound and user-agent-bound cookies. They do not defeat
  automation detection on read, so Google account surfaces and Cloudflare
  interactive challenges can still reset.

Therefore the plain-words conclusion for Ivan: this feature works for sites that
accept a transplanted cookie session and do not detect automation on read; for
Google and for Cloudflare-gated sites such as ArtStation the saved sign-in will
often be reset, and the working path for those is the company phone (task 1079,
a real device) together with the company vault (task 1076).

## One node substitution mechanism, agreed across three tasks

The node's single secret mechanism is owned by task 1076 and already published on
`task-1076` at `21cf42d02cc0dcd7d3978e94ef0a19da1516f5e7`:
`apps/node/src/secret-fill/` (`SecretFills`, `FillAdapter<K>`, the `browser`
adapter) and `packages/protocol/src/secret-fill.ts` (`FillTarget`, `SiteSession`,
`SecretFill`/`SecretFilled`). Task 1079 owns `FillAdapter<'phone'>`.

Task 1075 adds no second secret resolver and no second fill adapter. Its position,
sent to the authors of 1076 and 1079 and to be confirmed by them:

- Automated typing of a vault login, password or one-time code into the node's
  browser runs only through the shared `SecretFills` and `FillAdapter<'browser'>`
  of task 1076. Task 1075 does not type secrets.
- Task 1075 reuses the shared `SiteSession` protocol type and the node's shared
  value hiding. Every cookie value and local-storage value of a saved sign-in is
  registered with the node's `hide`/`redact` before any node output, so it is
  absent from `hh-browse` output, logs, screenshots and tool replies.
- Task 1075 owns the saved-sign-ins store and implements the `useSessionStore`
  hook that task 1076 already left open in
  `apps/server/src/modules/vault/fill.ts`. Its `saveSession` hands a `SiteSession`
  to this store keyed by `{ companyId, agentId, site-origin }`. The same store
  receives a session captured from the person's own browser, by the same path.
- Task 1075 contributes two operations that are not fill adapters and carry no
  secret resolver: capture of a person-driven sign-in, and injection of a saved
  `SiteSession` into `hh-browse`. A phone fill produces no `SiteSession`, so phone
  sign-ins do not feed this store, which is correct.

The one open confirmation from task 1076 is that it persists no session itself and
leaves persistence to this hook, and that the site origin is an acceptable key.
The published code already shows the hook is unimplemented (`state.sessions` is
null until registered), so development of the store proceeds on that contract.

## Stored state and ownership

A new Drizzle migration adds a saved-sign-ins table, leaving shipped migrations
alone. Per row: company, owner employee (agent), site origin, created-by person,
created-at, the user agent recorded at capture, and the sealed `SiteSession`
encrypted by the pattern in `apps/server/src/crypto/secrets.ts`. A unique key on
(owner employee, site origin) keeps one current sign-in per employee per site; a
new capture replaces it. Revoke deletes the row.

Access is owner-only, stricter than the vault's company-wide default:

- Only the owning employee may read the metadata, use the sign-in through their
  node tool, or revoke it. The server checks company, then that the requesting
  principal is the owner. A foreign employee gets 403; a foreign department gets
  403; a foreign company's row id gets 403 and reads as not found.
- The stored `SiteSession` never leaves the server in an API reply. The card
  reads only metadata: platform or origin, who saved it, when, and whether it has
  a current sign-in. Use is an issue sealed to the node's key over the node
  connection, the same age-armored path the vault uses, opened only on the node.

A log row records who used or captured which saved sign-in, for which task, and
when, with no values, mirroring the vault log.

## Capture flow

1. The person presses "Sign in as employee" on the employee card and gives a
   platform or address. The form validates a web address (`http`/`https`).
2. The server sends a capture request to the node on the person's machine (the
   node of the person's current context, authenticated by its existing node key,
   never an agent-supplied node id). The request carries the address and a fresh
   capture id, no secret.
3. The node creates an isolated capture profile directory and launches the real
   browser executable as a plain process: `--user-data-dir=<capture>`,
   `--password-store=basic`, on Linux `--use-mock-keychain`, and the address. No
   automation driver, no debugging port. For a known, readable profile format and
   a match with `hh-browse`, the capture uses the node's bundled Chromium
   executable launched directly as a process; system Chrome, Edge or Brave are a
   later addition. Firefox and Safari capture are out of scope for the first
   version and named as such.
4. The person signs in and passes every check. Hornhoof shows a live "waiting for
   you to finish" state and a "Done" control, and also detects the browser process
   exiting.
5. On finish, the node reads the capture profile's cookie store and local storage
   for the target origin from disk (offline, no contact with the site), builds a
   `SiteSession`, registers its values with `hide`, seals it to the server path,
   and records the capture user agent. The server stores it through the
   task-1075 session store. The node then deletes the capture profile.

Tests drive this on a recorded sample profile (a fixture cookie database and
local-storage store) under virtual time, never a live platform and never a real
sign-in on this machine. The node start, the launch argument vector, and the
profile read-and-build are the boundary under test.

## hh-browse with a saved sign-in

`apps/node/src/web-page/browse.ts` and `apps/node/src/web-page/cli.ts` gain a
saved-sign-in path. The agent that runs `hh-browse` is an employee; the tool
resolves the saved sign-in for that employee and the origin of the requested
address. The server seals the `SiteSession` to the node key; the node opens it,
registers every value with `hide`, injects cookies via `context.addCookies` and
per-origin local storage into the existing persistent context before navigation,
and pins the recorded capture user agent for the context. Address vetting, the
proxy and the size limits of `hh-browse` are unchanged.

When no saved sign-in exists for the origin, or it has expired, or the page comes
back as `login_required` or `robot_check` after injection, the tool states this
plainly in its existing status vocabulary and the existing `Next:` guidance tells
the employee to ask the person to sign in again. Nothing attempts to get past the
check. The injected values never enter the printed text, the screenshot or any
note, because they are hidden before output and the screenshot masks sign-in
fields as the vault browser adapter already does.

## Redaction and leak proof

The node's shared `hide`/`redact` (`apps/node/src/redact.ts`, extended by task
1076 for short values) covers cookie and local-storage values of a saved sign-in
on every node surface. The server keeps the sealed session out of API replies,
task events and job prompts. A test plants a unique marker as a cookie value and a
local-storage value, exercises capture, storage, `hh-browse` use, the card API,
the logs, task events and the screenshot, and asserts the marker appears on none
of them, following the vault leak test.

## Web interface

The employee card gains the "Sign in as employee" control, a per-platform saved
state line ("sign-in to <platform> saved by <who>, at <when>", or "no saved
sign-in"), and a one-press revoke with confirmation. A small address form backs
the generic case. All of it uses theme tokens, controls at least 44 px, English
and Russian in plain words in both `apps/web/src/i18n/en.ts` and `ru.ts`, and
logical properties for RTL. States: idle, waiting for the person, saved, expired,
error, revoked. The form delivers a screenshot of a field with its error in focus,
and the card and button are shown at 1440 and 375 widths in Cyberpunk and Light,
per the task.

## Checks planned

Named, run in the author's own workspace, never `run_tests` on this task branch:

- node `web-page-signin-capture.test.ts` (launch argument vector carries no
  automation signal; profile read builds a `SiteSession`; profile deleted),
  `web-page-browse.test.ts` additions (injection on a recorded page sample with
  and without a saved sign-in; expired and `login_required` reported, not
  bypassed), `redact.test.ts` additions (session values hidden).
- server `employee-signin.test.ts` (save, read metadata, revoke), access tests
  (owner yes; foreign employee, foreign department, foreign company 403),
  `employee-signin-leak.test.ts` (unique marker absent from API, tools, logs,
  task events, screenshots), `employee-signin-migration.test.ts`.
- protocol tests for the new capture and use messages.
- web `employee-signin.test.tsx` and an `e2e` button-and-card scenario at 375 and
  1440 in shipped themes and the dynamically longest and shortest shipped locales.
- `tsc`, ESLint and build for each touched app; the author selector on the exact
  candidate. Schema, protocol, routes and translations broaden the import graph,
  so a `selection_is_whole_suite` is recorded as unavailable and the whole run is
  left to the release owner. No `run_tests` and no whole suite for this task.

## Implementation increments

1. Session store and server access: the table, migration, encrypted storage,
   owner-only access with 403, and the `useSessionStore` registration that task
   1076 left open. Prove access and the leak test first.
2. Capture: node plain-process launch, offline profile read, `SiteSession` build,
   profile cleanup, on recorded fixtures under virtual time.
3. `hh-browse` injection and the plain reporting of absent or expired sign-ins.
4. Skill template `hh-web-pages.md`: how to ask the person for a sign-in.
5. Web card, button, states and form, then the visual check and screenshots.

## Delivery to Ivan

Plain Russian: what the button does, how the person signs in, where the saved
sign-in shows and how to revoke it, and the honest limit that Google and
ArtStation sessions are often reset when the node replays them, with the phone
(1079) and the vault (1076) as the working path for those. Screenshots of the
button and card at 1440 and 375 in Cyberpunk and Light, and the form field with
its error in focus. No live-platform check is claimed; a later live check waits
for a person to sign in on a real platform.

Development hands in a pushed exact commit with base and candidate SHAs and
requirement-to-test evidence. Independent Review and the required Security stage
must pass before any shared-branch integration; Tests checks the final repaired
candidate. This document authorizes no main or turn integration and no live
platform action.
