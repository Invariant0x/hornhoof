# Company password vault with one-time codes, task 1076

Architecture at base `90fafcc06d183b8e4249e6c083ecd385bd232371` (`origin/turn-31`) on `task-1076`.
Task kind: known behaviour. Risk: security (stored passwords, TOTP secrets, values on nodes).
This file is a plan, not a claim that the feature or its checks have shipped.

## Acceptance

1. Each company keeps its own vault of site sign-ins: a name, a site (address or
   platform), a login, a password and an optional TOTP secret.
2. Any active person of the company adds an entry. By default every employee and
   every assistant of that company may use it. A person may narrow an entry to one
   department or one agent; that is a choice, never the default. Another company
   gets 403 from the server for any entry id, list or log it names.
3. The password and the TOTP secret are typed only into the Hornhoof form. They are
   stored encrypted the way `apps/server/src/crypto/secrets.ts` encrypts. Screens and
   APIs show only the name, site, login, scope, who added it and when.
4. An employee or assistant asks to sign in by the entry's name. The node fills the
   password and the current one-time code into the sign-in form, in the node's own
   browser (task 1075 territory) or on a company phone (task 1079). No value or code
   reaches the model's context, tool answers, logs, screenshots, task events, the
   outbox or process arguments. The node's redaction (`apps/node/src/redact.ts`)
   knows every value before the first byte is typed.
5. A log records who used which entry, when, for which task and job, on which
   target and with what outcome, without values. Entries can be changed and removed.

Form: theme tokens, fields and buttons at least 44 px, plain English and Russian,
logical properties for RTL, a screenshot of a field with an error in focus.

## One fill mechanism for three tasks

Task 1079's author proposed on 2026-11-16 that task 1076 owns the shared node
mechanism; this plan takes that ownership. The proposal below went to the authors
of 1075 and 1079 the same day. Code that depends on their answer waits for it;
the vault itself (storage, access, form, log) does not depend on it.

| Part | Owner | Place |
| --- | --- | --- |
| Vault storage, access, log, people API, form | 1076 | `apps/server/src/modules/vault/`, `apps/web/src/screens/settings/Vault*.tsx` |
| Agent tools `vault_entries`, `vault_fill` | 1076 | `modules/vault/tools.ts`, registered in `tools/mcp.ts` and `assistants/mcp.ts` |
| Fill protocol | 1076 | `packages/protocol/src/secret-fill.ts`, joined into the server and node message unions |
| Node core: open, redact, TOTP, dispatch, receipt | 1076 | `apps/node/src/secret-fill/` |
| Browser adapter (node-private Chromium) | 1076 | `apps/node/src/secret-fill/browser.ts` |
| Saved site sign-in store and `hh-browse` with it | 1075 | its module; 1076 calls one function of it |
| Phone adapter and phone session target | 1079 | `apps/node/src/phones/`, `modules/phones/` |

No second resolver, transport or secret format exists. A phone or browser adapter
never receives a sealed payload, the server key or an entry id it could resolve.

### Protocol (`packages/protocol/src/secret-fill.ts`)

Server to node, never numbered and never kept on disk by the node:

```ts
secret.fill {
  requestId: Id; jobId: Id | null; entryId: Id;
  sealed: Sealed;          // age, to this node's public key: JSON of FillPlain
  fields: ('login' | 'password' | 'code')[];   // 1..3, distinct
  target: { kind: 'browser'; address: string }
        | { kind: 'phone'; phoneSessionId: Id; generation: number; element: string | null };
  expiresAt: string;       // ISO; the node refuses a later start
}
FillPlain = { login: string; password: string;
              totp: { secret: string; digits: 6 | 7 | 8; period: number; algorithm: 'SHA1' | 'SHA256' | 'SHA512' } | null }
```

Node to server, a plain status with no free text, also not numbered (`NUMBERED`
stays unchanged) so the outbox never writes it to disk:

```ts
secret.filled {
  requestId: Id;
  status: 'filled' | 'signed_in' | 'field_not_found' | 'wrong_field' | 'rejected'
        | 'needs_person' | 'robot_check' | 'browser_refused' | 'target_gone'
        | 'expired' | 'unsupported' | 'failed';
  filled: ('login' | 'password' | 'code')[];
  session?: SiteSession;   // browser only, after signed_in: cookies and storage of the site
  shot?: { name: string; bytes: string } // browser only: an already masked PNG, base64, size-limited
}
```

`SiteSession` is the Playwright storage state of the signed-in origins, bounded in
size, which the server hands to task 1075's store and never logs or returns.

### Node core (`apps/node/src/secret-fill/`)

- `values.ts`: `SecretValue` holds one value privately. `reveal(use)` gives it to a
  callback; `toString`, `toJSON` and `util.inspect` give `[hidden]`.
- `totp.ts`: RFC 6238 (HMAC SHA1/256/512, 6 to 8 digits, period) over an injected
  clock; base32 secrets and `otpauth://totp/` addresses are parsed on the server.
- `adapter.ts`:

  ```ts
  type FillValues = { login: SecretValue; password: SecretValue; code(): SecretValue | null };
  type FillReceipt = { status: FillStatus; filled: FillField[]; session?: SiteSession; shot?: Shot };
  type FillAdapter<K extends FillTarget['kind']> = {
    kind: K;
    /* Before the first secret byte: every capture of this target (screenshot, tree, live frame,
       recording) is fully masked until the returned release has run. */
    shield(target: Extract<FillTarget, { kind: K }>): Promise<() => Promise<void>>;
    fill(target: Extract<FillTarget, { kind: K }>, values: FillValues, fields: FillField[], signal: AbortSignal): Promise<FillReceipt>;
  };
  function registerFillAdapter(adapter: FillAdapter<FillTarget['kind']>): void;
  ```

  An adapter returns a status only, never a value, never writes one to a log and
  never passes one in a child process's arguments (argv is readable in `/proc`).
- `index.ts`: on `secret.fill`, refuse after `expiresAt` (`expired`) or with no
  adapter for the kind (`unsupported`); open `sealed` with the node's age identity;
  validate `FillPlain`; register the password, the TOTP secret (all forms) and the
  codes of the current and both neighbouring periods with redaction; `shield`;
  `fill` under an abort signal bounded by `expiresAt`; release; send `secret.filled`.
  Any thrown error becomes `failed` with no message text. Late or duplicate
  requests with a known `requestId` are refused.

### Redaction (`apps/node/src/redact.ts`)

`secretForms` drops values under 8 characters, which would leave six-digit codes
and short passwords visible. Add an exact list with an expiry: `holdExact(values,
untilMs)` keeps values of 4 or more characters, and `secretForms` includes the
unexpired ones whatever their length. Passwords are held for the life of the node
process, codes for ten minutes. Every existing `redact()` caller (job output, events,
terminal masks, operator views, node log) then hides them with no call-site change.
The server refuses a password shorter than 4 characters, so redaction never hides
single letters across all output.

### Browser adapter (`apps/node/src/secret-fill/browser.ts`, task 1076)

The agent's own processes never hold a value: `hh-browse` runs as the agent's user,
so filling there would put the password inside a process the agent controls. The
adapter instead runs Chromium in the node process's own user, on a fresh profile,
through the same proxy and address checks as `web-page/browse.ts` (public http and
https only), with the same process reaping and folder removal.

Steps, at most four, each ended by page events within the request's deadline:
open the entry's site; find visible fields (login: `autocomplete=username|email`,
`type=email`, names with user/login/email; password: `type=password`; code:
`autocomplete=one-time-code`, numeric inputs of 6 to 8 characters, names with
otp/totp/code/2fa); fill the requested ones with `locator.fill` over the browser
pipe; submit; wait. No field left means `signed_in`: the adapter returns the site's
storage state for task 1075's store. Robot markers (`collect.ts`) mean
`robot_check`; a page saying the browser is not secure means `browser_refused`;
the same password field with an error means `rejected`; an unknown step means
`needs_person`. Any screenshot is taken with password, code and login fields
masked by Playwright and never between a fill and its submit. This is no bypass:
the adapter changes no browser fingerprint and does not pass robot checks.
Sites that refuse automated browsers (Google, ArtStation per 1075) answer
`browser_refused`; then the agent uses a phone (1079) or asks a person to sign in
with 1075's button.

### Phone adapter contract (task 1079)

`FillAdapter<'phone'>` in `apps/node/src/phones/`. The agent taps the field itself
and calls `vault_fill` with one field and the element reference from its sanitized
tree. The adapter checks the phone's binding, generation and lease, checks that a
password value goes into a field marked password, types through `adb shell` with
the command on standard input (never in argv), and keeps snapshots, the tree, live
frames and the recording fully masked from `shield` until release. On the server,
`phoneFillTarget(ctx, principal, phoneSessionId)` returns `{ nodeId, generation }`
or throws 403 (other company) or 409 (no active session of this agent).

### Saved sign-in hand-off (task 1075)

Proposed function in 1075's module: `saveSiteLogin(ctx, { companyId, agentId, site,
storageState, source: 'vault' | 'person' })`, keyed by agent so both employees and
assistants work. Pending 1075's answer; if 1075 names another function or format,
only the call in `modules/vault/fill.ts` changes.

## Agreed and changed during Development

- The authors of 1075 and 1079 confirmed the contract at `21cf42d0` on 2026-11-16: one mechanism, owned by 1076.
- The phone target also carries `site`, the entry's web address or null, so the phone adapter checks that a page open in
  the phone's browser is of the entry's site before typing.
- `sameSite(address, page)` in `@hornhoof/protocol`: the same host or one under the other, never a step down from https.
  The node's browser types only on such pages, and the server refuses an address an agent names that is not of the
  entry's site, so no agent can send a value to another site's form. A browser fill needs an entry whose site is a web
  address.
- The node registers adapters with `fills.register(adapter)` on the `SecretFills` instance in `main.ts`.
- The server takes the other modules through two hooks in `modules/vault/fill.ts`: `usePhoneTargets(ctx, fn)` for 1079's
  resolver and `useSessionStore(ctx, fn)` for 1075's saved sign-ins. Until 1075 connects it, a browser sign-in answers
  `savedSignIn: false`.
- The Passwords group shows when the server answers `GET /api/vault`, like the other probed groups.

## Server

### Stored state (one new Drizzle migration, shipped ones untouched)

`vault_entries`: id, company_id, name (unique per company), site, login,
password_enc, totp_enc (nullable; JSON of secret, digits, period, algorithm),
scope_kind (`company` default, `department`, `agent`) with scope_department_id and
scope_agent_id under a check constraint, created_by_person_id, created_at,
updated_by_person_id, updated_at. Values go through `encryptSecret(..., ctx.config.secret)`.
Removal deletes the row, so the encrypted values are gone.

`vault_log`: id, company_id, entry_id (set null on removal), entry_name and site at
the time, kind (`used`, `created`, `changed`, `removed`), agent_id, person_id, job_id,
task_id, target_kind, fields, status, at. No value or code column exists.

### Access (`modules/vault/access.ts`)

- People: an active person of the company lists entries and reads the log. Adding
  needs a real person session: a request made through `via` (an agent acting as a
  person) gets 403, because values are typed only into the form. The author of an
  entry and the CEO (owner or delegate) change and remove it.
- Agents: an employee or assistant uses an entry of its own company whose scope is
  the company, its department or itself. A narrowed entry is not listed to others
  and using it gives 403. An entry id of another company gives 403 on every route
  and tool, never 404, as the task asks.

### People API (`modules/vault/routes.ts`)

`GET /api/vault`, `POST /api/vault`, `PATCH /api/vault/:id`, `DELETE /api/vault/:id`,
`GET /api/vault/:id/log`. Values are write-only: no response ever carries
`password` or `totp`, only `hasCode`. An empty password or code in a change keeps
the stored one; `removeCode: true` drops the code. Request logging stays disabled
(`disableRequestLogging: true` in `app.ts`); validation errors name the field, never
echo its value.

### Agent tools (`modules/vault/tools.ts`)

- `vault_entries`: the entries this agent may use: name, site, login, hasCode, scope.
- `vault_fill { entry: name, target: { kind: 'browser', address? } | { kind: 'phone',
  session, element? }, fields? }`: checks access, picks the node (browser: the node
  that runs this job; phone: `phoneFillTarget`), seals `FillPlain` with age to that
  node's `nodes.public_key`, writes a `used` log row, sends `secret.fill` with a
  60 second `expiresAt`, waits up to 45 seconds for `secret.filled`, saves a browser
  session through 1075, updates the log row and answers
  `{ entry, status, filled, savedSignIn?, shot? }`. No answer means `node_offline`
  or `no_answer`. A browser fill outside a job on a node is `unsupported`.
  Registered for employees in `tools/mcp.ts` and for assistants in `assistants/mcp.ts`.

## Web

A new Settings group `passwords` (`/settings/passwords`) for every signed-in person:
a list of entries (name, site, login, scope, added by, when), Add, Change, Remove
with confirmation, and the entry's log. The form has name, site, login, password
(`autocomplete=new-password`), the code secret or `otpauth://` address (optional),
and scope. Strings in `en.ts` and `ru.ts` in plain words; theme tokens, 44 px
controls, logical properties; loading, empty, error, saving and refused states.

## Threats and limits

- On a node that runs as root, agents run as their own Linux users and never reach
  the node process holding a value. A personal node that runs as one user cannot
  keep a determined local program of that user out of its memory; there the promise
  is the task's: no value in the model's text, tools, logs, screenshots or tasks.
- A JavaScript string cannot be wiped; plain values live only for one request.
- A browser session taken from a node may be dropped by a site that ties sessions
  to a device or address; that is 1075's report to make.
- The server can decrypt every entry with its key, as it can every other stored
  secret today; no client-side sealing is added.

## Increments and named checks (tests before code each time)

1. Protocol `packages/protocol/test/secret-fill.test.ts`: messages validate, sizes
   bound, no `secret.filled` in `NUMBERED`.
2. Node `apps/node/test/secret-fill-totp.test.ts` (RFC 6238 vectors on a controlled
   clock), `secret-fill.test.ts` (open, redact before fill, expiry, unknown kind,
   receipts without values), `redact.test.ts` (exact list and expiry, virtual time).
3. Server `apps/server/test/vault.test.ts` (encryption at rest, write-only values,
   CRUD, own company yes, narrowed only to its own, other company 403, `via` 403),
   `vault-tools.test.ts` (tools for an employee and an assistant, fill through a test
   node, log rows, timeouts on virtual time).
4. Node `secret-fill-browser.test.ts` on recorded page facts through the existing
   fake launcher shape of `web-page-browse.test.ts`: steps, statuses, masks.
5. `apps/server/test/vault-leak.test.ts` and a node counterpart: a unique marker
   password and TOTP secret, then every API answer, tool answer, log row, task event,
   job event, node message, node log line and screenshot request is searched for
   the marker, its base64 forms and the current code, and none holds them.
6. Web `apps/web/test/Vault.test.tsx` and `apps/web/e2e/vault.spec.ts` with the
   focused error field screenshot; then the 1075 hand-off and the 1079 phone call
   once their answers are in.
7. Touched-app `tsc`, ESLint and builds; `npm run -s check:author` on the exact
   candidate. No `run_tests` and no whole suite for this task.

Development hands in a pushed exact commit with base and candidate SHAs and
requirement-to-test evidence. Review and the required Security stage follow.
