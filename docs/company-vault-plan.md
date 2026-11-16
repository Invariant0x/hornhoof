# Company password vault: the agent takes the sign-in as text, task 1143

Rework of task 1076 by Ivan's words of 16.11, 19:10 and 19:12: a person gives a login and password once, at the form or
to the orchestrator, and from then on the agent does everything itself. The model sees the login, the password and the
current one-time code as text and types them in, the way a person does. Nothing types a sign-in for the model: there is
no fill on the node, no sealed values, no node masks for vault values.

The work is in branch `iv-vault`, from `task-1076` (179003d5 and the plan after it) with turn-31 merged in. What only
the fill on the node needed is gone; the store, its encryption, the people's screen and the log stay.

## Acceptance

1. Each company has its own vault of site sign-ins: a name, the site or its address, a login, a password and an optional
   one-time code secret (TOTP).
2. Any person of the company adds, changes and removes an entry at the form; the orchestrator does the same through the
   people API acting for a person, and any agent saves one with the tool `vault_save` when a person gives it a sign-in in
   chat. Every employee, assistant and the orchestrator of the company uses every entry. Another company's entry answers
   403 on the server.
3. The password and the code secret are kept encrypted with the shared `encryptSecret`. The screen shows the site, the
   login, who added it and when; never the password or the code secret.
4. An agent of the company asks for an entry by name with the tool `vault_entry` and gets as text the login, the password
   and, when the entry has a code secret, the current one-time code with the seconds it is still good for (never the
   secret).
5. The log says who, when and for which task took which entry, and who added, changed or removed it, with no value. Its
   lines on the screen are words in en and ru, never a raw status code.
6. Hiding a password written by accident into a task or chat people read (#1074, #1077) stays as it is.

Ivan's brief of 16.11 for this branch decides two points where the text of #1143 differs: an entry is no longer kept for
one department or one employee, and any person of the company, not only its author and the CEO, changes and removes it.

## Removed from the branch

- Node: `apps/node/src/secret-fill/` and its tests; `main.ts`, `redact.ts` and `redact.test.ts` are as on turn-31.
- Protocol: `secret-fill.ts`, its test, `secret.fill`, `secret.filled` and `fills` in hello.
- Server: `modules/vault/fill.ts`, `modules/vault/access.ts`, the tool `vault_fill`, `vault-leak.test.ts`, the scope of an
  entry, its `updated_by` and `updated_at`, and the log's `job_id`, `target`, `fields`, `status` and `ended_at`.
- Web: the choice of who may use an entry, the log's `ended` words, its target and status parts, the least length of a
  password (it was there for the node's masks).

## Server

- Migration `0132_vault`: `vault_entries` (`created_by` a person or `created_by_agent` an agent) and `vault_log` with
  `kind` one of `created`, `changed`, `removed`, `taken`, and `person_id`, `agent_id`, `task_id`.
- `modules/vault/totp.ts`: the code secret as stored, its parsing from what an authenticator shows or an `otpauth://totp/`
  address, and `totpCode(totp, at)` by RFC 6238. The moment is the server's clock (`ctx.clock`), so a test sets it.
- `modules/vault/routes.ts`: `GET /api/vault`, `POST /api/vault`, `PATCH /api/vault/:id`, `DELETE /api/vault/:id`,
  `GET /api/vault/:id/log`, each behind `requirePerson`. What another person's own assistant added or took shows to its
  owner only.
- `modules/vault/tools.ts`: `vault_entries`, `vault_entry { entry }` and `vault_save { name, site, login, password,
  code? }` for every agent, the assistants' own agents included. `vault_save` replaces the site, login and password of
  an entry of the same name. The tools tell the model never to write a password into a task, chat, file or commit.

## Web

`apps/web/src/ui/Vault.tsx` under Settings, Passwords: the list, the form and the history, theme tokens, controls of at
least 44 px, RTL, and the snapshot of a field with a problem in focus (`e2e/vault.spec.ts`).

## Threats and limits

- An agent of the company sees the password of every entry: that is Ivan's rule now.
- What an agent writes into a task or chat by mistake is hidden by #1074 and #1077, not by this task.
- The code secret never leaves the server; only the current code does.

## Checks

`vault-totp`, `vault-tools` and `vault` server tests; `route-access`, `agent-view-table`, `staff`, `tools`,
`tasks-tools`, `turns`, `assistant-agent`, `assistants-mcp`, `merge-rules`, `agent-sql` and the migration tests by name;
web `Vault.test.tsx`, `Settings.test.tsx`, `i18n.test.tsx` and `e2e/vault.spec.ts` in Chrome; tsc and eslint of what
changed. No `run_tests`, no full run.
