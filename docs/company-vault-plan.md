# Company password vault: the agent takes the sign-in as text, task 1143

Rework of task 1076 by Ivan's words of 16.11, 19:10 and 19:12: a person gives a login and password once, at the form or
to the orchestrator, and from then on the agent does everything itself. The model sees the login, the password and the
current one-time code as text and types them in, the way a person does. Nothing types a sign-in for the model: there is
no fill on the node, no sealed values, no node masks for vault values.

The work goes on in branch `task-1076` from 179003d5. That head was built for a fill on the node; what only that fill
needed goes, the store, its encryption, access, the people's screen and the log stay.

## Acceptance

1. Each company has its own vault of site sign-ins: a name, the site or its address, a login, a password and an optional
   one-time code secret (TOTP).
2. Any person of the company adds an entry at the form, and so does the orchestrator acting for a person. By default every
   employee and assistant of the company uses it; a person may keep it for one department or one employee. Another
   company's entry answers 403 on the server.
3. The password and the code secret are kept encrypted with the shared `encryptSecret`. The screen shows the site, the
   login, who added it and when; never the password or the code secret. An entry can be changed and removed.
4. An agent of the company that may use an entry asks for it by name with the tool `vault_entry` and gets as text the
   login, the password and, when the entry has a code secret, the current one-time code (never the secret). Others are
   refused.
5. The log says who, when and for which task took which entry, with no value. Its lines on the screen are words in en and
   ru, never a raw status code.
6. Hiding a password written by accident into a task or chat people read (#1074, #1077) stays as it is.

## Removed from the branch

- Node: `apps/node/src/secret-fill/` and its three tests; `main.ts`, `redact.ts` and `redact.test.ts` go back to the
  base (`holdExact` and `forgetExact` were only for vault values).
- Protocol: `packages/protocol/src/secret-fill.ts`, its test, `secret.fill` and `secret.filled`, `fills` in hello.
- Server: `modules/vault/fill.ts` (`fillEntry`, `SiteSession` hand-off, `usePhoneTargets`, `useSessionStore`,
  `useFillTimer`), its hooks in `nodes/messages.ts`, `plainOf`, the tool `vault_fill`, `vault-leak.test.ts` and every
  test on the fill. The log loses `job_id`, `target`, `fields`, `status` and `ended_at`.
- Web: the log's `ended` words and its target and status parts.

## Server

### Stored state

One migration, not shipped yet, so it is generated again for the new tables rather than patched:
`vault_entries` as before; `vault_log` with `company_id`, `entry_id` (set null on removal), `entry_name`, `site`, `kind`
(`created`, `changed`, `removed`, `taken`), `person_id`, `agent_id`, `task_id`, `created_at`. Its number is the next free
one after main when the branch moves into turn-31 (main takes 0130 and 0131 first); it is named to the head before then.

### One-time code (`modules/vault/totp.ts`)

The code secret as stored (`Totp`: base32 secret, 6 to 8 digits, period, SHA1, SHA256 or SHA512), its parsing from what
an authenticator shows or an `otpauth://totp/` address, and `totpCode(totp, at)` by RFC 6238, moved from the node. The
moment is the server's clock, so a test sets it.

### Access (`modules/vault/access.ts`)

Unchanged: an entry of another company is never the agent's; one kept for a department or an employee is only theirs.

### People API (`modules/vault/routes.ts`)

`GET /api/vault`, `POST /api/vault`, `PATCH /api/vault/:id`, `DELETE /api/vault/:id`, `GET /api/vault/:id/log`, each
behind `requirePerson`. The rule that only a person at the form writes goes: the orchestrator acting for a person adds,
changes and removes entries the same way. The person who added an entry and the CEO change and remove it. Answers never
hold a password or a code secret. `route-access.test.ts` and `agent-view-table.test.ts` stay green.

### Agent tools (`modules/vault/tools.ts`)

- `vault_entries`: the entries this agent may use, by name, site, login, whether it has a code and its scope.
- `vault_entry { entry }`: by name, for an agent that may use it, `{ name, site, login, password, code? }` with `code`
  the current one-time code and the seconds it is still valid. The tool tells the model to type them into the sign-in
  form only and never write them into a task, chat, file or commit. The take is logged as `taken` with the agent and the
  task of its turn, without any value. An unknown entry answers `vault_unknown`, one kept for others `vault_not_allowed`.

Both go to every employee, head, orchestrator and assistant, as now; the tool lists in `staff`, `tools`, `tasks-tools`
and `turns` tests name `vault_entry` for `vault_fill`.

## Web (`apps/web/src/ui/Vault.tsx`, Settings, Passwords group)

The form and list stay. Texts say what is true now: employees and assistants get the sign-in to type it in, a person
never sees the password again on the screen. Log lines: added, changed, removed by a person, or taken by an agent for
task #N, in en and ru. Theme tokens, controls of at least 44 px, RTL, and the snapshot of a field with a problem in focus
stay as they are.

## Threats and limits

- An agent that may use an entry sees its password: that is Ivan's rule now. Narrowing an entry to a department or an
  employee is the way to keep it from others.
- What an agent writes into a task or chat by mistake is hidden by #1074 and #1077, not by this task.
- The code secret never leaves the server; only the current code does.

## Increments and named checks (tests before code each time)

1. Removal: node, protocol and server fill go; the server, node and protocol type check and their touched tests pass.
2. `vault-totp.test.ts`: RFC 6238 vectors and parsing; red with no `totp.ts`, then green.
3. `vault-tools.test.ts`: `vault_entry` gives login, password and the current code by the set clock to an agent with
   access, refuses one without and an unknown name; the log has `taken` with agent and task and no value. Red, then green.
4. `vault.test.ts`: encryption, default and narrowed access, 403 for another company, no password or secret in answers,
   the orchestrator acting for a person adds an entry. Red where it changed, then green.
5. Web `Vault.test.tsx`: log lines in en and ru without raw codes; e2e `vault.spec.ts` snapshot as before.
6. `route-access`, `agent-view-table`, `staff`, `tools`, `tasks-tools`, `turns`, `assistants-mcp` by name; tsc, eslint and
   the build of server, web, node and protocol. No `run_tests`, no full run.
