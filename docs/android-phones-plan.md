# Company Android phones, task 1079

## Development checkpoint: pairing, physical identity and owner controls

The network probe accepts the Android wireless pairing address and six-digit code.
The code goes to adb stdin once, never to database fields or adb argv. Registration
and each operation verify the real device's manufacturer and hardware serial hash;
alternate USB/network addresses cannot create two simultaneous loans of one phone.
Unverified or emulator identities receive no grant. Migration 0131 preserves old
history and disables lending until an old phone is verified again.

The Machines page now has the connection form, owner-only live picture, Stop and
explicit resume. Task panels show sanitized frame recordings with playback.
An epoch prevents stale list reads from undoing Stop in the UI. This checkpoint
does not deliver the USB host bridge yet. Browser inspection and final checks are
still pending. Named local checks: node 4 files / 20 tests; protocol 2 files / 10
tests; web Phones, PhoneRecordings, Machines and TaskPanel 4 files / 149 tests,
all passed. Web production types and the new UI ESLint checks passed. The existing
TaskPanel tests print jsdom's canvas availability notice while passing.

The orchestrator's 2026-11-16 addition also requires allocation to any suitable
free phone, social-action limits and an action journal. Development asked the
head to settle the contract for distinguishing social actions from navigation;
raw tap coordinates alone cannot reliably classify their effect. This additional
work and its virtual-time tests remain pending. Target release is 0.31.0; no date
for a person's phone check has been promised before the candidate clears its gates.

Architecture at base `d44ecb8c7d3d0b6d7ce690e01c25046f0404b212` on `task-1079`.
Task kind: unknown path. Risk: access, physical device control and credentials.
This file is a plan, not a claim that the feature or its checks have shipped.

## Acceptance

Any person in a company can register an Android phone that they own. They enable
developer options and approve the computer on the phone themselves. A company
agent or assistant can request a session, observe the screen and accessibility
tree, tap, swipe, type ordinary text, launch an application or open a web address.
One phone serves one session at a time. Multiple phones work independently. The
owner can watch, stop the agent and resume lending the phone. A stopped phone
does not immediately pass to the next waiting agent. A sanitized recording stays
with the task. Credentials from task 1076 enter through its shared node mechanism.

The head confirmed on 2026-11-16 that a narrow host bridge is in scope, including
installation and updates. Build the network adb path first, then USB using the
same operation adapter. No general computer grant, root command tool or arbitrary
adb command is exposed. No protection bypass, browser fingerprint change or
automated robot check is part of this feature. A robot check requires the owner.

## Existing boundaries to extend

- Server: a new `apps/server/src/modules/phones` module, registered in `app.ts`.
  Reuse person authentication, company ids, task sight and attachment limits.
- Agent tools: register phone tools before the employee return in
  `modules/tools/mcp.ts`; register them separately in `modules/assistants/mcp.ts`
  for assistants. The orchestrator's computer tools alone are insufficient.
- Execution: a new `apps/node/src/phones` adapter on the phone's machine, which
  can differ from the machine running the agent. Authenticate the executing node
  through the existing node connection, not an agent-supplied node id.
- Protocol: validated phone request, result, frame and revoke messages with
  machine, phone, session, generation and request ids. Validate sizes at ingress.
  Keep the extension separate from unrelated terminal and operator messages.
- Web: add a Phones section to Machines using existing cards, form fields and
  action components. Keep the large existing Machines screen change to its mount.
- Lifecycle: release through `tasks/wake.ts` cancellation, node `job.done`
  handling and lost-job reconciliation; also keep a lease deadline as the final
  recovery path. Tests advance the injected clock rather than waiting.

## Stored state and ownership

Generate a new Drizzle migration, leaving shipped migrations alone. Persist:

- Phone: company, owner person, execution machine, transport, serial, display
  name, lending state and fencing generation. A unique machine/serial binding
  prevents two registrations controlling one physical phone concurrently.
- Session: phone, company, agent or assistant principal, job, task, FIFO order,
  state, generation, lease deadline, started/ended times, end reason and recording
  references. One active slot per phone is enforced in the database.
- Sanitized frames and action metadata: ordered session sequence, timestamp,
  request id and sanitized image. Do not store raw adb output, input text,
  credentials, complete URLs with query values, or unrestricted device logs.

Allocation locks the phone row in a database transaction and selects the oldest
eligible waiter. Repeated acquire by the same live job is idempotent. A second
connection or a server restart cannot allocate another active session. Reconcile
unfinished sessions on restart before granting new work. Phone state is separate
from the machine's compute pool and its root access setting.

Every server operation checks current company, principal, phone binding and session
owner. A foreign company's known phone, session, frame or recording id gets 403.
People register as themselves, never via an assistant impersonating their screen.
Any company agent can borrow by default. Only the owning person's own session can
stop, resume lending or change the phone binding. Recording access also requires
the task's existing sight checks; a phone id alone grants no task access.

## Queue, cancellation and Stop

Session states are queued, active, ended and cancelled. Phone states distinguish
available, owner control and offline. The tool returns a queue receipt immediately
and allows polling or explicit cancellation, without holding a tool call open.
An active session renews only while its original job/principal is live.

Each action carries a session generation and a unique request id. The execution
node checks the machine and serial binding, current generation and lease before
starting a command, and fences late results. No action is retried automatically
after an unknown outcome. adb processes use a bounded output buffer, an abort
signal and fixed argument vectors, with no local shell.

Stop first increments the generation and places the phone in owner control in the
server transaction, cancels waiters and sends a priority revoke outside the normal
command queue. The node/bridge aborts the child it started, rejects queued commands
and acknowledges the revocation. Stop is not serialized behind a hanging screenshot
or swipe. In-flight results of the old generation are discarded. Already delivered
touches cannot be undone; the UI distinguishes local server revocation from the
node's acknowledgement if the machine is disconnected. The local lease fails closed
when the server connection is lost. The next agent starts only after a confirmed
release/fence and an explicit owner resume following Stop.

## adb boundary and upstream decision

Evaluated `mobile-next/mobile-mcp` at exact upstream commit
`ad3b42336d89717313af45176c48538bea6ec363` (package version `0.0.1`). Its
[`package.json`](https://github.com/mobile-next/mobile-mcp/blob/ad3b42336d89717313af45176c48538bea6ec363/package.json)
and [`LICENSE`](https://github.com/mobile-next/mobile-mcp/blob/ad3b42336d89717313af45176c48538bea6ec363/LICENSE)
declare Apache-2.0. Its Android source uses adb for screenshots and UIAutomator
trees. It is a useful reference, but an unrestricted upstream MCP server would
bypass Hornhoof's queue, fencing, owner Stop and credential redaction boundary.

Implement the small adb allowlist directly in Hornhoof. No upstream source or
dependency is copied, installed or launched. Thus there is no floating `latest`
runtime dependency or third-party code to redistribute. Keep the inspected SHA
above in the final report and revisit attribution if implementation copies code.

The adapter supports device enumeration, screenshot, UI tree, tap, swipe, ordinary
text, app launch and http/https launch in the real phone browser. Validate serials,
coordinates, gesture duration, package names, address scheme and size before
execution. adb's remote shell interpretation still requires safe remote argument
quoting even when the local process uses `execFile`. No install/uninstall, file
pull, arbitrary shell, clipboard read or device log tools are available.

For network adb, a person registers the endpoint explicitly and performs Android's
pairing or authorization. Do not scan the network or enable debug ports remotely.
For USB, a host bridge owns adb on the actual host, including macOS outside the
Docker VM. The installer/updater manages its pinned executable and lifecycle.
Authenticate with the executing machine node's key and a server-checked binding;
allow only that phone's serial and allowlisted operations. Never expose port 5037
to the agent container or the network as a general adb server. Bridge logs contain
operation/status ids only. Installation must explain any required macOS permission
truthfully; an unverified claim of zero administrator prompts is not acceptable.

## One credential mechanism and recording privacy

The three authors agreed before the phone fill implementation. Task 1076 owns
`SecretFills`, `FillAdapter`, `SecretValue`, `SecretFill`, `sameSite` and the vault
server's `usePhoneTargets` hook. Task 1075 confirmed the same mechanism on
2026-11-16 at 14:17 UTC. With the head's permission, dependency
`21cf42d02cc0dcd7d3978e94ef0a19da1516f5e7` was merged into this isolated task
branch as `fb7f43efc5a7f5df9758a1a440f269bd2cd26e91`. No dependency or phone
change is authorized for the turn before the dependency passes Security and enters
the turn through its own route. If its contract changes in review, take its new
head and repeat the phone integration checks.

The phone uses `apps/node/src/secret-fill/index.ts` and its `values.ts` wrapper,
the protocol exports in `packages/protocol/src/secret-fill.ts`, and
`apps/server/src/modules/vault/fill.ts`. It supplies only the phone adapter and
active-session target resolver. Values enter adb through stdin. There is no second
resolver, credential tool or secret transport.

Secret substitution runs on the phone execution machine, even when the borrowing
agent runs elsewhere. Values and current TOTP codes never enter tool arguments,
model replies, job prompts, events, bridge logs or subprocess error messages.
The shared mechanism must cover short secrets and six-digit codes, since the
existing `redact.ts` default ignores values shorter than eight characters.

Use one node-side sanitization path for model screenshots, live owner frames and
recordings. Detect password fields in UIAutomator data, remove their text and
descriptions, and rasterize opaque masks before the image leaves the node. Never
embed an original image beneath a visual overlay in a delivered SVG or HTML file.
Serialize capture with secret input and install the privacy barrier before the
first secret byte. If field locations, a fresh tree or raster sanitization cannot
be trusted, withhold the image or return a fully masked frame. During substitution
and any uncertain post-input state, mask the whole screen. Fail closed on malformed
XML/PNG and redact errors without echoing adb stderr. No raw `screenrecord` file
may be stored and masked later: record only already sanitized frames.

Record sessions as ordered sanitized frames with timestamps and action receipts,
playable from the task, with bounded chunks under existing attachment quotas.
Flush completed chunks during the session and finalize on normal end, cancellation
and loss, so a missing node cannot lose every completed frame. Mark an incomplete
recording explicitly. Owner-only viewing does not replace task permissions.

## Implementation and proof increments

1. Network path: one end-to-end acceptance check for registering, borrowing and
   observing a phone using recorded adb responses; observe the intended failure.
   Implement pure operation parsing and node adapter, then database allocation,
   server tools and a minimal person-facing flow. Keep USB unimplemented until
   this path has executed its named checks.
2. Add Stop races, lease recovery, job lifecycle release and durable recording.
   Verify transactional allocation with concurrent calls on a real test database.
3. After the shared API is agreed, connect the phone credential adapter and run
   the unique-secret tests on every output surface, including live frames,
   recordings, UI tree, logs, errors and late results during cancellation.
4. Add the narrow host bridge and the installer/updater integration. Prove its
   authentication, machine/serial binding and rejection of arbitrary operations
   as a separate security item. Check our start/input/parse boundary on fixtures,
   not whether adb, macOS or a real phone works on this machine.
5. Finish the UI with theme tokens, 44 px controls, focus/error/loading/empty/
   disconnected/owner-control states, English/Russian text and logical RTL layout.
   Run named browser scenarios at 375 and 1440 widths on Chromium, Firefox and
   WebKit in shipped themes and dynamically measured longest/shortest locales.
   Check RTL geometry separately without claiming an unshipped RTL translation.
6. Run local named tests, touched-app tsc, ESLint, builds and the author check on
   the exact candidate. Schema, protocol, routes and translations broaden the
   import-graph impact: record any author selector `selection_is_whole_suite`
   as unavailable, run explicit affected files locally and leave the whole run
   to the release owner. Never use `--allow-whole` or `run_tests` for this task.

Planned named checks: node `phone-adb.test.ts`, `phone-session.test.ts`,
`phone-redaction.test.ts` and `phone-bridge.test.ts`; server `phones.test.ts`,
`phone-tools.test.ts`, `phone-lifecycle.test.ts` and `phones-migration.test.ts`;
protocol `phones.test.ts`; web `phones.test.tsx` and `e2e/phones.spec.ts`, plus
the explicitly named callers and installer/updater regression files selected
when those changes are concrete. This is a planned inventory, not test evidence.

## Later live check and delivery

When a person adds their phone: open Machines, choose Add phone and its computer
or network connection; enable Android developer options and USB debugging; approve
the displayed computer key (or network pairing); register the discovered phone;
sign into accounts on the phone themselves. Borrow it with an agent, watch its
screen, queue a second agent, press Stop and confirm further touches stop while
owner control remains. Resume, end a session and open its recording from the task.
Verify a vault password and one-time code are hidden in the live view and replay.
Ask the owner to handle a robot check. Do not claim this hardware check ran before
a phone exists. Deliver screenshots and short plain Russian instructions to Ivan.

Development hands in a pushed exact commit with base/candidate SHAs and actual
requirement-to-test evidence. Independent Review and required Security must pass
before any shared-branch integration; Tests checks the final repaired candidate.
No main/turn integration, deployment or live device action is authorized by this
architecture document.

## First Development checkpoint

The network backend is implemented in the first code checkpoint, not handed in as
the completed task. This includes person-owned registration, the company boundary,
agent tools, a transactional FIFO queue, local fenced leases, owner Stop, job
cancellation, sanitized frame storage, owner live-view routes and task recordings.
Queue order uses a database sequence, including when timestamps are equal. A Stop
fence also rejects an open message that arrives after its own revocation. The
executing node's current key and machine binding are checked on the server.

The node uses pinned `pngjs` 7.0.0 and `saxes` 6.0.0, and development types
`@types/pngjs` 6.0.5. PNGs are bounded before decompression, decoded and re-encoded
with no source metadata; XML with a DTD or uncertain bounds is rejected. These
packages do not introduce a second mobile MCP server. Text entry currently accepts
printable ASCII, including quotes, spaces and a literal `%s`; other scripts return
a needs-person result instead of silently altering input.

Executed checkpoint checks on the source of that commit:

- Node: `vitest run test/phone-adb.test.ts test/phone-redaction.test.ts
  test/phone-session.test.ts test/phone-executor.test.ts test/secret-fill.test.ts
  test/redact.test.ts`, 6 files and 32 tests passed. The password marker is checked
  across replies, frames, logs and the decoded masked pixels.
- Node callers: `main.test.ts`, `commands.test.ts`, `credentials.test.ts`,
  `login.test.ts`, `first-setup.test.ts`, `account.test.ts`,
  `terminal-mac-peer.test.ts`, `wait-update.test.ts`, 8 files and 171 tests passed.
- Protocol: `phones.test.ts` and `secret-fill.test.ts`, 2 files and 10 tests passed.
- Server: `phones.test.ts`, `phone-tools.test.ts`, `phone-lifecycle.test.ts`,
  `phone-recording.test.ts`, `phones-migration.test.ts`, 5 files and 6 tests passed.
  The migration check covers a fresh database, an upgrade retaining existing
  company/task rows and repeat application. This repository supplies no down
  migration. The added tables leave the previous release's existing tables intact.
- Production TypeScript checks for server/node and lint of the changed sources
  and tests passed. Server test TypeScript first exhausted its default 2 GB heap
  (exit 134). With a 4 GB heap it reported only two dependency errors, TS18046 in
  `apps/server/test/vault-leak.test.ts` lines 60 and 62, where `tables` and `rows`
  are unknown. The same code was checked on dependency head `7af23826`; its author
  was asked to fix it on that branch. This stage is not a pass and those tests
  were not weakened or edited here. Node test types and affected-file lint are
  checked separately. No whole run or `run_tests` was used. Some setup-heavy
  server tests and existing node callers exceed one second locally; no performance
  guarantee or full-release verdict is claimed.

Still required: person-facing UI and its browser evidence, Android wireless
pairing setup, the USB host bridge and its installer/updater integration, a combined
server/node unique-marker integration check, concurrent allocation and broader
caller checks, the final exact-candidate author evidence, Review, Security and
Tests. There is no real-phone evidence yet. Do not present this checkpoint as a
finished feature or integrate it into a shared branch.
