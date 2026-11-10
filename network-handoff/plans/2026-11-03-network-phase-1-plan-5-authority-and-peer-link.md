# Network Phase 1, Plan 5: The Company's Authority and the Peer Link, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each company gets its own certificate authority, made by the leading app and kept in the database under
`HORNHOOF_SECRET`. The keeper of the machine the company runs on makes the machine's Ed25519 key in a volume of its own,
gets a certificate for it with the data role, renews it weekly, and reports the machine's uptime, disk sync time and
free disk. It then serves the peer link on the peer port: HTTP/2 over mutual TLS, trusting only the company's authority
and refusing in the TLS handshake every client without a valid certificate of it (none, another authority's, an expired
or a revoked one), passing a peer's CONNECT stream to the app with `x-hornhoof-via` naming the peer, and to `db` only
for the data role. With a public link it offers the peer link and the app through hornhoof.org as two stcp services.
Nothing joins yet: plan 5b brings the machines that use all this.

**Architecture:** One migration from `schema.ts` (`0049_network`): the machine's network id, role, signing key and
measures on `machines`, and the tables `authority`, `certificates` and `peer_secrets`.
`modules/network/` holds the authority (`authority.ts`, pure, on `@peculiar/x509` and Node's `X509Certificate`), the
database side (`store.ts`) and the routes the keeper calls (`routes.ts`, `/api/network/*`, taken only from the
keeper, by `x-hornhoof-via`). The keeper gains `machine-keys.ts`, `certificate.ts` and `measures.ts` in
`modules/keeper/`, and the peer link in `net/peer-server.ts` (the TLS handshake against the authority and its
revocation list, sessions, CONNECT) and `net/peer-door.ts` (the loopback HTTP door that adds `x-hornhoof-via` before
the app). A second frpc child of the keeper (`modules/link/peer-client.ts`) offers
the two stcp services.

**Tech Stack:** TypeScript on Node 22 (`node:http2`, `node:tls`, `node:crypto` with Ed25519, `node:fs` `statfs`);
`@peculiar/x509` 1.14.3 (plan 1b) on Node's webcrypto; Fastify 5; drizzle-orm 0.45.4 on node-postgres and PGlite;
frpc 0.71.1; vitest with PGlite; Docker for `npm run test:real`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.2 (the authority, certificates with roles, keepers over
mutual TLS on HTTP/2, CONNECT streams, `x-hornhoof-via`, what each role's certificate reaches, path 2's two stcp
services), 3.3 (the load report's uptime, fsync time and free disk), 3.4 "One data machine", 3.8 "Keys" (the Ed25519
signing key in the certificate) and section 10 ("Peer link", "The authority's key", "Secrets"). Overview
`notes/plans/2026-11-03-network-phase-1-overview.md`, plan 5's entry and discrepancies 1 and 16. Plans 1 to 4 (see
"Handed over by plans 1 to 4").

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/peer-link` on a new branch `peer-link` from main (`git worktree
add`, then `npm ci` there once), after plan 4 is merged into main and shipped.

**Handed over by plans 1 to 4** (merged and shipped before this plan starts):
- Plan 1, on hornhoof.org: an frpc logged in as `<link>-<machine8>-peer` with the link key may offer the stcp services
  `<link>-<machine8>-data` and `<link>-<machine8>-app`, each with a secret of at least 32 characters and `allowUsers`
  left empty, and nothing else (R5.1).
- Plan 1b: `@peculiar/x509` 1.14.3 in `apps/server`, its crypto provider set to Node's webcrypto in
  `modules/tls/x509.ts`.
- Plan 2: `net/proxy.ts` (`passThrough`, `PassOptions`, `serve`, `socketAddress`, `firstForwarded`, `Target`); the
  keeper (`KeeperOptions`, `Keeper`, `KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 }`), with
  `HORNHOOF_PEER_PORT` published to 7070 and nothing listening there; `config.machineId` (`HORNHOOF_MACHINE_ID`);
  `TunnelKeeper` (`read`, `clientFor`), `linkClientId`, `configFor`, `clientFor`, `FrpcLocal`, `tunnelSettings(db,
  config)`; compose's `keeper` service and `compose.test.ts`'s exact list of its environment keys; the app's
  `TUNNEL_HOST: keeper`; every door of `front` and the keeper drops incoming `x-hornhoof-*` headers.
- Plan 3: the keeper's `leaseStore` (`take` writes sync `alone`, `renew` keeps it) and its ruling 7, which hands the
  check that no other data machine is listed to the plan that lists them; `HIDDEN` and `CLOSED` of the database tool;
  `AFTER_MIGRATIONS`, which attaches the journal to every table of `public` after each migration run; the keeper sets
  `lead` only under a valid lease; `openTestDb` and `createTestDb` give a fenced PGlite with an endless lease.
- Plan 4: migrations up to `0048_calls`; `fromTunnel(req, config)` exported from `auth/tunnel.ts`; the app's compose
  environment has `HORNHOOF_MACHINE_ID`; `PassOptions.holdMs` and the keeper's front door passing
  `x-hornhoof-invocation` only from `front`'s address.
- Today's code: `machines` (`db/schema.ts:107-125`), `builtinMachine` (`modules/nodes/nodes.ts:34-45`) and its three
  callers, `encryptSecret` and `decryptSecret` (`crypto/secrets.ts`) with `config.secret`, `people.is_owner`,
  `config.commit`, `hashToken` (`crypto/tokens.ts`).
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys and certificates made at run time.
- No new dependency. Certificates are made with `@peculiar/x509` (plan 1b) and read and checked with Node's
  `X509Certificate`; keys are Node's Ed25519.
- One new migration, never an edit of an older one: `0049_network` by `npx drizzle-kit generate --name network` from
  `apps/server`.
- A private key (the authority's, a machine's) never goes into a log line, an answer, `keeper.json` or a file outside
  the keeper's own volume; the authority's key is stored only encrypted, as the link key is. The peer secrets travel
  only to the keeper that offers them.
- The keeper starts before `migrate` (plan 2), so a keeper of this build runs a while on the schema of plan 4's build:
  every read of a table or column this plan adds keeps what the keeper has when it fails, and nothing the keeper does
  each second reads them.
- Fail toward a working company: a certificate, a peer secret or a measure the keeper cannot get changes nothing the
  company runs today (the app, the link, `front`, the lease); it is tried again.
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; the whole suite from
  the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test -- --testTimeout=90000`; the real tests: `npm run
  test:real`, which needs Docker. Types, from the worktree root: `npx tsc -p apps/server/tsconfig.json --noEmit` and,
  for the web task, `npx tsc -p apps/web/tsconfig.json --noEmit`, each printing nothing. Never run prettier.

## Rulings made while planning

1. **Plan 5 comes in two.** The overview's plan 5 is about twice plan 4. This plan gives the company its authority and
   its server the peer link, and changes nothing anyone sees; plan 5b brings the machines that join: the small core
   on a joined machine, the paths to the leader, finding it, addresses, the Machines tab, Disconnect, workers
   following the leader's build, and the lab. Each merges alone and leaves a one-machine company working as today,
   and the peer port gets a release of its own to show it refuses what it should before anything uses it.
2. **One authority per company, made by the leading app the first time a keeper asks.** Its key is Ed25519, its
   certificate is self-signed for 20 years (`CN=Hornhoof company <company id>`, a CA with path length 0), and both sit
   in `authority`, the key under `HORNHOOF_SECRET` as the link key is (spec section 10). Only the app signs, and only
   while it leads, so only the leader uses the key. The table is hidden from the orchestrator's SQL.
3. **A machine's certificate carries its Ed25519 key**, the signing key of spec 3.8, also used for TLS 1.3: 30 days,
   `CN=<machines.id>`, the subject alternative names `urn:hornhoof:machine:<machines.id>` and
   `urn:hornhoof:role:<data|worker>`, server and client use. Its keeper asks for a new one once it is older than 7 days
   (spec section 10, "renewed weekly"); a peer machine asks through `CONNECT app` while its certificate is valid,
   with 23 days to spare. An expired certificate fails at the handshake like any other bad one (ruling 12), so spec
   section 10's "an expired certificate may only ask for a new one" waits for plan 5b, the first plan with machines
   that can be away that long, and may not loosen this port's handshake. The keeper that loses its volume makes a new
   key: its own app gives the leader's machine a certificate for it; a joined machine joins again (plan 5b).
4. **Plan credentials stay sealed to node keys, and the machine's age key comes with plan 7.** Discrepancy 1 proposed
   sealing them to machine keys, but a machine key lives in the keeper's volume, which no node reads, so a node could
   no longer open its own plan's sign-in. Step 0's ruling (one key per node) is kept, and nothing before backups needs
   a machine's X25519 key, so plan 7 makes it with the bundles that use it.
5. **The keeper asks the app, and the app believes only its keeper, by a header no door lets through.** Every request
   the keeper's front door and link door pass on reaches the app from the keeper's address too, so the address alone
   says nothing. `/api/network/*` answers only a request from the keeper's address (`fromTunnel`) that carries
   `x-hornhoof-via`: `keeper` for the keeper's own request, about the machine the app runs on, or a peer machine's id,
   set by the peer door from the peer's certificate. Every door drops an incoming `x-hornhoof-*` header (plan 2) and
   the peer door writes its own, so a page, a visitor of the link, a node or a peer cannot send either value. Messages
   from a peer machine are app requests carried through `CONNECT app`, a new certificate too; only `hello` is the
   keeper's own.
6. **The leader's own machine is a hidden row of its own.** The certificate names a row of `machines`: the live row
   whose `network_id` is `config.machineId`, else a new one for the company's owner (who cannot be disabled) with
   `machine_key` `server:<machine id>`, no hostname and the role `data`. It is never the row of a computer someone
   joined, so Disconnect and disabling a person, which revoke those, never reach it. The routes that list, change or
   disconnect machines and the test pool skip `server:` rows, so nothing anyone sees changes; plan 5b shows the
   network's machines and can relate this row to a joined computer with the same host id. A database keeps one live
   `server:` row: a new one retires the others and revokes their certificates, as after a restore onto an install with
   another machine id, so an old identity never counts as another data machine (ruling 9).
7. **Two doors on the peer link.** Port 7070, published as `HORNHOOF_PEER_PORT`, is the whole peer link, by role. Port
   7071, on `127.0.0.1` only, is what the `-app` stcp service reaches: `hello` and `CONNECT app`, whatever the
   certificate's role (spec 3.2: that service "reaches only an app"). `CONNECT db` is taken only on 7070 from a data
   certificate. `CONNECT app` reaches this machine's app whatever its mode; a copy passing it to the leader comes with
   plan 9.
8. **Revocation is an X.509 CRL the leading app signs, so the handshake refuses a revoked certificate.** `certificates`
   keeps every serial issued, with its machine, until it expires, so all of a machine's certificates can be revoked
   (plan 5b's Disconnect); the revoked ones not yet expired are the list. `GET /api/network/peers` gives them and, while
   the app leads, a CRL of them signed with the authority's key (from a day ago to a year on, each entry with the reason
   `cessationOfOperation`). The keeper keeps the last CRL in its volume and gives it to the TLS server, and takes a new
   one when the list changes. Node's `crl` option turns on OpenSSL's revocation check for the whole chain, so a server
   without a CRL refuses everyone: the keeper does not listen before it holds a certificate and a CRL. It reads the list
   every 5 s and closes every open session whose certificate is on it or has expired. Only the leader takes sessions in
   this plan; plan 5b hands workers the CRL.
9. **The check that the machine is alone (plan 3, ruling 7) runs apart from the lease.** The keeper reads, every
   10 s, whether another machine of the role `data` is listed, and then neither takes nor renews a lease with sync
   `alone`; the lease lapses and the app reads. It is not in the renewal statement, since the keeper of this build
   renews on plan 4's schema until `migrate` has run. No other machine gets the data role before plan 9.
10. **The stcp services run only with a public link.** They need a name at the relay. A company without a link gets
    them once a plan binds it a hidden name (spec 3.4 "Without a public link"). Their secrets are 32 random bytes in
    base64url, made by the app on first use while it leads, in `peer_secrets` (hidden); outside `lead` a missing
    secret means no services yet.
11. **Measures are the keeper's last values on the machine's row.** Every 20 s it samples one 4 KiB write with fsync
    in its volume and keeps 24 hours of samples; it reports the 99th percentile (none with fewer than 10 samples), the
    volume's free bytes and the kernel's uptime (Docker's Linux system on a Mac), with the published ports and its
    commit, every 20 s while the app leads. History and the 7-day online share come with plan 5b.
12. **The peer port answers nothing without a valid certificate of the company (the team lead's condition).** With no
    machine joined yet, the server asks every client for a certificate and refuses in the handshake
    (`rejectUnauthorized: true`, `ca` the authority, `crl` its list) one that is missing, of another authority,
    expired, or on the list. OpenSSL answers a missing one with the alert `certificate required`; for the other three
    Node ends the connection once OpenSSL's handshake is through and before it hands out the socket, so the client sees
    the handshake end unfinished, no HTTP/2 session starts, and the app sees nothing. Session tickets are off
    (`SSL_OP_NO_TICKET`): a resumed TLS 1.3 session sends no certificate, and with tickets on a certificate revoked
    after the first connection came back in. All of this was tried on Node 22.23.2 against OpenSSL 3.6's `s_client`
    with Ed25519 certificates. The authority's key usage includes `cRLSign`, or OpenSSL takes no list it signs.
13. **What plans 3 and 4 left to "the plan that brings a second data machine" goes to plan 9.** Plan 3's ruling 6
    (frpc stops at lease end) and plan 4's ruling 9 (the built-in node's identity, `jobsOf` and test parts per
    machine) wait for a second data machine, which neither this plan nor plan 5b brings: a worker runs no app and no
    built-in node. Plan 3's ruling 7, the check itself, is here (ruling 9).
14. **The network's tables are closed to the orchestrator twice.** `authority`, `certificates` and `peer_secrets` are
    in `HIDDEN`, and have row level security on with no policy, so a role that is neither their owner nor a superuser
    sees no row and changes none, whatever it is granted. The second guard holds after a downgrade to plan 4's build,
    whose grant builder does not know these tables and grants the orchestrator every table of `public` it does not
    hide; the app and the keeper connect as the owner and pass. The new `machines` columns are read-only to the
    orchestrator as `machines` is today.
15. **A dump restores with its `HORNHOOF_SECRET`.** The authority's key and the peer secrets are sealed with it, as
    the link key is today. With another secret the authority does not open: the certificate route answers 500 with one
    log line, the peer link stays shut, and everything else works; plan 7, which carries backups to other machines,
    brings the secret with them. Another machine id takes the identity as ruling 6 says.
16. **The peer link opens only once the keeper has checked its certificate and its list with the app in this run.**
    After a start, the volume's certificate and CRL serve only once an answer of `GET /api/network/peers` says the
    certificate is of the database's authority and for this machine's row, and that the CRL lists the serials revoked
    now. A mismatch, as when a failed Update restored the database of before it while the keeper's volume kept a
    certificate of the discarded authority, asks for a new certificate or waits for a new CRL first. Until then
    nothing listens on the peer port, so a revoked certificate never gets in through a stale list while the app
    starts, and the lease, `front` and the public link do not wait for any of it.

## Review Focus

1. A client at the peer port or the app door without a certificate, with one of another authority, an expired one or
   a revoked one: refused in the TLS handshake, the app sees nothing, and a resumed session cannot skip the check; a
   session whose certificate gets revoked or expires closes within 6 s. Tests in Task 2 (`refuses an expired
   certificate at the handshake`, `refuses a revoked certificate at the handshake by its CRL`), Task 5 (`refuses at
   the handshake every client without a valid certificate`, `does not resume a TLS session`, `closes a session once
   its certificate is revoked`), Task 6 (`reads revocations as they come`) and Task 7's probe from another machine.
2. A worker's certificate never reaches `db`, on either door, and nothing reaches `db` through the app door. Tests in
   Task 5 (`takes CONNECT db only from a data certificate on the peer door`).
3. A forged `x-hornhoof-via`, from a node, the link, `front`, a peer's request or a direct request to the app, never
   reaches the app's network routes as sent, and a request through the keeper's front or link door, which comes from
   the keeper's address, never reaches them at all. Tests in Task 3 (`believes the via header from the keeper alone`),
   Task 5 (`names the peer to the app by its certificate`) and Task 6 (`keeps the network routes from the keeper's
   other doors`).
4. The keeper started again with its volume kept: the same key and certificate, until it is older than 7 days; with the
   volume lost: a new key and a certificate for it, and the old serial still valid until it expires; with the
   database restored to before this build: a new certificate before the port opens (Task 6, `takes a new certificate
   when the database does not know its own`). Tests in Task 4
   (`makes the machine's key once and keeps it`, `asks for a certificate when it holds none, and keeps it`, `renews a
   certificate older than 7 days`) and Task 3 (`gives its own machine a data certificate`).
5. The Update from plan 4's build, the keeper starting on the old schema before `migrate`, and the way back: the
   company keeps leading alone, and no read of a new table stops the keeper. Tests in Task 6 (`leads alone on the
   schema before this plan`) and Task 7's rehearsal.

---

### Task 1: The network's tables

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** main with plan 4 merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts
test/orchestrator-control.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json
--noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0049_network.sql` (with its `meta` files)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/agent-sql.ts` (`HIDDEN`),
  `apps/server/src/modules/tools/database.ts` (`CLOSED`)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/orchestrator-control.test.ts`

**Interfaces:**
- Produces, in `db/schema.ts` (`createdAt()` and `timestamp` as the file already writes them; `check` and `sql` from
  drizzle):
  ```ts
  export const MACHINE_ROLES = ['data', 'worker'] as const;
  export type MachineRole = (typeof MACHINE_ROLES)[number];
  // machines gains, with check('machines_role', sql`role IS NULL OR role IN ('data', 'worker')`):
  //   networkId: text('network_id').unique()          the HORNHOOF_MACHINE_ID of the machine's keeper; null without one
  //   role: text('role', { enum: MACHINE_ROLES })      null: no keeper of the company runs there
  //   signKey: text('sign_key')                        the Ed25519 public key its certificates name, SPKI PEM
  //   webPort: integer('web_port'), peerPort: integer('peer_port'), commit: text('commit')
  //   uptimeS: integer('uptime_s'), fsyncP99Ms: real('fsync_p99_ms'), diskFree: bigint('disk_free', { mode: 'number' })
  //   reportAt: timestamp('report_at', { withTimezone: true })
  export const authority = pgTable('authority', {
    singleton: boolean('singleton').primaryKey().default(true),
    certPem: text('cert_pem').notNull(),
    keyEnc: text('key_enc').notNull(),       // encryptSecret(PKCS#8 PEM, config.secret)
    createdAt: createdAt(),
  }).enableRLS();
  export const certificates = pgTable('certificates', {
    serial: text('serial').primaryKey(),     // lowercase hex
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    until: timestamp('until', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  }).enableRLS();
  export const PEER_SECRET_KINDS = ['data', 'app'] as const;
  export const peerSecrets = pgTable('peer_secrets', {
    kind: text('kind', { enum: PEER_SECRET_KINDS }).primaryKey(),
    secretEnc: text('secret_enc').notNull(),
    createdAt: createdAt(),
  }, t => [check('peer_secrets_kind', sql`kind IN ('data', 'app')`)]).enableRLS();
  ```
  drizzle's `enum` on a `text` column only types it, so the checks are what the database holds. drizzle-kit 0.31.11
  writes `ENABLE ROW LEVEL SECURITY` for `enableRLS()`; when the generated SQL lacks it or a check, the agent stops and
  reports.
- `HIDDEN` gains `'authority'`, `'certificates'` and `'peer_secrets'` (ruling 14); `CLOSED`'s sentence names "the
  company's certificate authority, its machines' certificates and the peer secrets" among what the database tool
  cannot read.

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0049`, `adds the network's tables, journaled and closed`: after migrating fully
    and `AFTER_MIGRATIONS`, `machines` has the columns above (`network_id` unique), the three tables exist, each has a
    `net_journal` trigger and `relrowsecurity` true in `pg_class`; two machines with the same `network_id` fail with
    `23505`; `role` takes `data`, `worker` and null and refuses `copy` with `23514`; `peer_secrets` refuses the kind
    `x` with `23514`.
  - `orchestrator-control.test.ts`: the hidden-table cases gain the three tables: the agent's `SELECT * FROM authority`
    is refused as plan 3's hidden tables are. `stays out of the network's tables when granted them`: with a row in
    each, the test grants the orchestrator's role `SELECT, INSERT, UPDATE, DELETE` on the three tables, as plan 4's
    grant builder would after a downgrade; through that role `SELECT` returns no row, `UPDATE` and `DELETE` change
    none, and `INSERT` fails with `42501`. The new `machines` columns read, and an `UPDATE machines SET role = 'data'`
    by the role fails.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name network`, then `HIDDEN` and `CLOSED`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the network's tables: machine identities, the authority, certificates and peer
  secrets".

### Task 2: The authority and machine certificates

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 1 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/authority.test.ts` passes; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/authority.ts`
- Test: `apps/server/test/authority.test.ts` (new)

**Interfaces:**
- Consumes: `@peculiar/x509` as plan 1b set it up (`modules/tls/x509.ts` sets the crypto provider; import it first).
- Produces:
  ```ts
  // modules/network/authority.ts
  export const AUTHORITY_YEARS = 20;
  export const CERT_DAYS = 30;
  export const RENEW_AFTER_DAYS = 7;
  export const SKEW_MS = 5 * 60_000;            // notBefore is this much before now
  export type Authority = { certPem: string; keyPem: string };   // keyPem: Ed25519, PKCS#8
  export function makeAuthority(companyId: string, now?: Date): Promise<Authority>;
  //   subject and issuer CN=Hornhoof company <companyId>; basicConstraints CA, path length 0, critical; keyUsage
  //   keyCertSign and cRLSign, critical; subjectKeyIdentifier; notBefore now - SKEW_MS, notAfter + AUTHORITY_YEARS years
  export type Issued = { certPem: string; serial: string; until: Date };
  export function issueCertificate(authority: Authority, req: { machineId: string; role: MachineRole; signKey: string; now?: Date }): Promise<Issued>;
  //   signKey: the machine's Ed25519 public key, SPKI PEM (refused with 'Not an Ed25519 public key.' otherwise).
  //   subject CN=<machineId>; SAN URI urn:hornhoof:machine:<machineId> and urn:hornhoof:role:<role>; basicConstraints
  //   not a CA, critical; keyUsage digitalSignature, critical; extKeyUsage serverAuth and clientAuth;
  //   authorityKeyIdentifier; notBefore now - SKEW_MS, notAfter now + CERT_DAYS days; serial 16 random bytes whose
  //   first byte is in 0x10..0x7f, so it is 32 hex digits with no sign byte; serial lowercase
  export type CertFacts = { machineId: string; role: MachineRole; serial: string; notBefore: Date; notAfter: Date; signKey: string };
  export function certFacts(certPem: string): CertFacts;
  //   read with Node's X509Certificate; serial lowercase; signKey the SPKI PEM of its public key; throws 'This
  //   certificate names no machine of a company.' when either URI is missing or the machine is not a uuid
  export function issuedBy(authorityPem: string, certPem: string): boolean;
  //   Node's X509Certificate: checkIssued and verify(authority's public key); dates are not looked at
  export function needsRenewal(facts: CertFacts, now: Date): boolean;   // now - (notBefore + SKEW_MS) > RENEW_AFTER_DAYS days
  export function makeCrl(authority: Authority, serials: string[], now?: Date): Promise<string>;
  //   PEM, by X509CrlGenerator; issuer the authority's subject; thisUpdate now - 1 day, nextUpdate now + 365 days; one
  //   entry per serial with the reason X509CrlReason.cessationOfOperation, so no entry has an empty extension list;
  //   signed with Ed25519
  ```

- [ ] **Step 1: Write failing tests** in `authority.test.ts`, with keys made by `generateKeyPairSync('ed25519')`:
  - `makes an authority that signs only certificates`: its certificate is self-issued (`checkIssued` of itself), a
    CA (`ca` true in `X509Certificate`), valid 20 years from 5 minutes ago, and its key verifies its signature.
  - `issues a machine certificate for a key and a role`: `certFacts` of it gives the machine id, `worker`, a serial of
    32 lowercase hex digits, `notAfter` 30 days from now and `notBefore` 5 minutes ago, and the same SPKI PEM;
    `issuedBy` is true; two certificates get two serials.
  - `tells a certificate of another authority`: `issuedBy` of a second authority's certificate is false.
  - `refuses a key that is not Ed25519`: an EC P-256 public key throws.
  - `carries mutual TLS 1.3 between two machines`: an `http2.createSecureServer` with one machine's key and certificate,
    `ca` the authority, `requestCert: true`, `rejectUnauthorized: true`, and a client `http2.connect` with the other's:
    a request answers, and the server sees the client's `urn:hornhoof:machine:` in `subjectaltname`; a client with a
    certificate of another authority gets no answer.
  - `refuses an expired certificate at the handshake`: a client certificate issued with `now` 31 days ago, against
    the server of the mutual TLS case: the server emits `tlsClientError` and never `secureConnection`, the client
    gets no answer, and `issuedBy` is still true (dates are not looked at).
  - `refuses a revoked certificate at the handshake by its CRL`: that server with `crl: await makeCrl(authority,
    [serial of B])`: client B is refused as above and client C answers; with `makeCrl(authority, [])` B answers too;
    the CRL read back by `X509Crl` names B's serial with the reason `cessationOfOperation`. When OpenSSL does not take
    a CRL that `@peculiar/x509` 1.14.3 makes, the agent stops and reports.
  - `asks for renewal after 7 days`: `needsRenewal` false at 6 days 23 hours after issue, true at 7 days 1 hour.
- [ ] **Step 2: Run** Done when. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `authority.ts`. When `@peculiar/x509` 1.14.3 cannot sign with Ed25519 on Node 22's
  webcrypto, the agent stops and reports.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Make a certificate authority per company and Ed25519 certificates for its machines".

### Task 3: The network routes the keeper calls

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 2 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/network-routes.test.ts test/nodes.test.ts
test/machine-load.test.ts test/computer.test.ts test/test-runs.test.ts` passes, then the whole server suite; `npx
tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/network/store.ts`, `apps/server/src/modules/network/routes.ts`,
  `apps/server/src/modules/network/via.ts`
- Modify: `apps/server/src/app.ts` (the routes), `apps/server/src/modules/nodes/nodes.ts` (`shownMachine`),
  `apps/server/src/modules/nodes/routes.ts` (`GET /api/machines` and the lookup of the routes that change or
  disconnect a machine skip `server:` rows), `apps/server/src/modules/testruns/pool.ts` and `runs.ts` (`poolOf`,
  `placesOf` skip them), `apps/server/src/errors.ts` (reasons)
- Test: `apps/server/test/network-routes.test.ts` (new), the tests named in Done when

**Interfaces:**
- Consumes: `authority`, `certificates`, `peerSecrets`, the new `machines` columns (Task 1); `makeAuthority`,
  `issueCertificate`, `certFacts`, `makeCrl`, `Authority`, `Issued` (Task 2); `fromTunnel` (plan 4).
- Produces:
  ```ts
  // modules/network/via.ts
  export const VIA = 'x-hornhoof-via';
  export const OWN_VIA = 'keeper';
  export type Asker = { own: true } | { own: false; machine: string };
  export function askerOf(req: FastifyRequest, config: Config): Promise<Asker | null>;
  //   null unless fromTunnel(req, config) (plan 4's export); then the header, lowercase: 'keeper' gives own, a uuid
  //   gives that machine, anything else or none gives null (ruling 5)
  // modules/network/store.ts
  export function authorityOf(db: Db, config: Config): Promise<Authority | null>;
  //   the row, its key decrypted; null when there is none
  export function makeAuthorityOnce(db: Db, config: Config, companyId: string): Promise<Authority>;
  //   authorityOf, or makeAuthority, INSERT ... ON CONFLICT DO NOTHING, and the row read again
  export function thisMachine(db: Db, config: Config, companyId: string): Promise<{ id: string }>;
  //   ruling 6, in one transaction that first locks the company's row (SELECT ... FOR UPDATE): the live row whose
  //   networkId is config.machineId, else INSERT ... ON CONFLICT DO NOTHING of the owner's `server:<machine id>` row
  //   with that networkId and role 'data' (the owner: the company's person with is_owner, else its earliest person),
  //   read again; then every other live row whose machine_key starts with 'server:' gets revoked_at now and its
  //   certificates revoked_at now. Throws ApiError(409, 'conflict', 'This server has no machine id. Run the install
  //   command again.', 'no_machine_id') without config.machineId
  export function findThisMachine(db: Db, config: Config): Promise<{ id: string } | null>;   // the read alone
  export function revokedSerials(db: Db, now?: Date): Promise<string[]>;   // revoked_at set and until ahead, sorted
  export function peerSecret(db: Db, config: Config, kind: 'data' | 'app', leading: boolean): Promise<string | null>;
  //   decrypted; when missing and leading (ctx.mode.current() is lead): 32 random bytes as base64url (43
  //   characters), inserted ON CONFLICT DO NOTHING and read again; when missing and not leading: null
  // modules/network/routes.ts
  export function networkRoutes(app: FastifyInstance, ctx: Ctx): void;
  // modules/nodes/nodes.ts
  export const shownMachine: SQL;   // not like(machines.machineKey, 'server:%'); builtinMachine is unchanged
  // errors.ts: ErrorReason gains 'not_keeper' | 'no_machine_id' | 'key_changed' | 'not_a_machine'
  ```
- Routes, each first `askerOf(req, config)`; null answers 403 `{ code: 'forbidden', message: 'Only this machine's
  keeper may ask this.', reason: 'not_keeper' }`. The company is the one the app serves (the database holds one):
  - `POST /api/network/certificate`, body `{ signKey: string }` (an SPKI PEM of at most 1024 characters). Own:
    `thisMachine`, which gets `signKey`, then a certificate with the role `data` from `makeAuthorityOnce`. Via: the
    asker's row must be live with a role and the same `signKey`, else 409 `key_changed` ('This machine's key changed.
    Connect it again with a new command.'), or 404 `not_a_machine` for an unknown, revoked or role-less row; then a
    certificate with its role. Each certificate gets a `certificates` row (serial, machine, until) in the same
    transaction, and the answer is `{ machine, role, certPem, authorityPem, until }` (`until` ISO). An older serial is
    not revoked: it ends by itself.
  - `GET /api/network/peers`, which writes nothing: `{ machine: string | null, authorityPem: string | null, revoked:
    string[], crlPem: string | null, link: { name, appSecret, dataSecret? } | null }`. `machine` is `findThisMachine`
    for own, else the asker's live row (404 `not_a_machine` otherwise); `authorityPem` null without an authority;
    `revoked` is `revokedSerials`; `crlPem` is `makeCrl` of `revoked` while the app leads and an authority exists,
    else null; `dataSecret` only for a machine of the role `data`; `link` null without a public link, without a
    `machine`, or while a secret is missing outside `lead`.
  - `POST /api/network/report`, body all optional: `{ uptimeS: int >= 0, fsyncP99Ms: number >= 0 | null, diskFree:
    int >= 0, commit: string (at most 64), webPort: 1..65535, peerPort: 1..65535 }`: own, the row `findThisMachine`
    gives (204 and nothing written without one); via, the asker's live row; its columns and `reportAt` now; 204.
- `GET /api/machines`, `poolOf` and `placesOf` add `shownMachine` to their `where`, and so does the lookup of the
  routes that change or disconnect one machine (404 for a `server:` row).

- [ ] **Step 1: Write failing tests** in `network-routes.test.ts`, on `testApp({ TUNNEL_HOST: 'localhost',
  HORNHOOF_MACHINE_ID: <32 hex> })` with a company set up and `inject` (from `127.0.0.1`, the keeper's address), each
  request with `x-hornhoof-via: keeper` unless the case says otherwise:
  - `gives its own machine a data certificate`: `POST /api/network/certificate` with a fresh Ed25519 SPKI makes one
    `authority` row, one `machines` row of the owner with that `network_id`, role `data` and `machine_key`
    `server:<id>`, and one `certificates` row; `certFacts` of the answer names that row and `data`, and
    `issuedBy(authorityPem, certPem)`; a second call makes no second authority or row and gives another serial (two
    `certificates` rows); a third with another key (the keeper's volume lost) gives a certificate for that key, and
    the row's `sign_key` becomes it.
  - `keeps the leader's row apart from people's machines`: with `HORNHOOF_HOST_ID` the hash of a machine key that
    joined before, the certificate still goes to a new `server:` row; the owner's `GET /api/machines` lists the joined
    computer alone, and `GET /api/pool` no `server:` row; disconnecting the joined computer leaves the `server:` row
    live; `POST /api/machines/<server row id>/disconnect` and `PATCH /api/machines/<server row id>` answer 404.
  - `retires an older identity of this server`: a live `server:` row of role `data` with another `network_id` and a
    `certificates` row: the own certificate call makes a new row, the older one gets `revoked_at`, and its serial is
    in the next `revoked` and `crlPem`.
  - `renews a peer's certificate for the same key only`: a `worker` row with a `signKey` (made by the test): with
    `x-hornhoof-via: <its id>` and the same key, a new certificate with `worker` and a `certificates` row for it;
    another key, 409 `key_changed`; a revoked row (`revoked_at` set), 404 `not_a_machine`.
  - `believes the via header from the keeper alone`: on this app, no `x-hornhoof-via` and `x-hornhoof-via: forged`
    answer 403 `not_keeper` on every route; on a second `testApp({ TUNNEL_HOST: 'keeper.invalid', ... })`, `keeper`
    and a uuid answer 403 `not_keeper` too.
  - `hands the peer secrets to the machine that offers them`: with a public link (`saveLink` as `link.test.ts` does),
    after the own certificate, own `GET /api/network/peers` gives `machine`, `authorityPem`, `link.name`, an
    `appSecret` and a `dataSecret` of 43 characters each, the same on a second call; via a `worker` row: no
    `dataSecret`; with `HORNHOOF_KEEPER: 'on'` and `keeper.json` saying `read`, a company with no secrets yet gets
    `link: null` and `crlPem: null`, and no row is written; before any certificate, `machine` and `authorityPem` are
    null; `revoked` lists the revoked serials not yet expired (an expired revoked one is left out), and `crlPem`, read
    by `X509Crl`, lists the same.
  - `stores the machine's measures`: `POST /api/network/report` with every field sets them and `report_at` on this
    machine's row; a `diskFree` of `-1` is 400.
  - `refuses a key that is not Ed25519`: an EC P-256 SPKI gives 400.
  - `answers when the authority does not open`: with the `authority` row's `key_enc` sealed under another secret, the
    own certificate call answers 500 and `GET /api/machines` still answers.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the keeper ask its app for the machine's certificate, the peer secrets, and its
  measures".

### Task 4: The keeper's machine key, certificate and measures

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 3 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/machine-keys.test.ts test/keeper-certificate.test.ts
test/measures.test.ts test/compose.test.ts test/keeper.test.ts test/keeper-link.test.ts` passes, then the whole
server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/machine-keys.ts`, `apps/server/src/modules/keeper/certificate.ts`,
  `apps/server/src/modules/keeper/measures.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/keeper.ts`, `compose.yaml`, `Dockerfile`
- Test: `apps/server/test/machine-keys.test.ts`, `apps/server/test/keeper-certificate.test.ts`,
  `apps/server/test/measures.test.ts` (new), `apps/server/test/compose.test.ts`, `apps/server/test/keeper.test.ts`,
  `apps/server/test/keeper-link.test.ts` (each keeper of these two files with a machine id gets a temp `dir`)

**Interfaces:**
- Consumes: `certFacts`, `needsRenewal` (Task 2); the routes of Task 3.
- Produces:
  ```ts
  // modules/keeper/machine-keys.ts
  export const KEEPER_DIR = '/keeper';
  export type MachineKey = { privatePem: string; publicPem: string };   // Ed25519, PKCS#8 and SPKI PEM
  export function machineKey(dir: string): MachineKey;
  //   reads <dir>/machine.key; makes it when missing or not an Ed25519 PKCS#8 PEM (written mode 0600 to a temp file,
  //   then renamed); the public half is derived, never stored
  // modules/keeper/certificate.ts
  export const CERT_FILE = 'certificate.json';
  export type HeldCertificate = { machine: string; role: MachineRole; certPem: string; authorityPem: string; until: string };
  export function readHeldCertificate(dir: string, key: MachineKey): HeldCertificate | null;
  //   null when missing, not this shape, or its certificate is not for key.publicPem
  export class CertificateKeeper {
    constructor(opts: { dir: string; key: MachineKey; ask: (signKey: string) => Promise<HeldCertificate>; now?: () => Date; retryMs?: number; everyMs?: number; log: (line: string) => void });
    //   retryMs 10_000, everyMs 3_600_000
    current(): HeldCertificate | null;
    start(): void;   // asks at once when it holds none or needsRenewal; a failed ask is tried again after retryMs,
                     //   a held one is looked at every everyMs; each new one is written (0600) and then announced
    renewNow(): void;   // asks now, whatever it holds (Task 6, ruling 16); the held one stays until a new one comes
    onChange(fn: (held: HeldCertificate) => void): void;
    stop(): void;
  }
  // modules/keeper/measures.ts
  export const SAMPLE_MS = 20_000;
  export const KEEP_SAMPLES = 4320;   // 24 hours
  export class Measures {
    constructor(opts: { dir: string; sampleMs?: number });
    start(): void; stop(): void;
    sample(): Promise<void>;   // writes 4096 random bytes to <dir>/fsync-probe, fsyncs, and keeps the milliseconds
    snapshot(): { uptimeS: number; fsyncP99Ms: number | null; diskFree: number };
    //   os.uptime() whole; the 99th percentile (nearest rank) of the kept samples, null with fewer than 10;
    //   statfs(dir).bavail * bsize
  }
  // KeeperOptions gains: dir?: string (KEEPER_DIR); published?: { web: number | null; peer: number | null } (the
  //   machine's ports as compose publishes them; keeper.ts reads HORNHOOF_PORT and HORNHOOF_PEER_PORT, null when not
  //   a port); reportEveryMs?: number (20_000)
  ```
- The keeper, when `config.machineId` is set: `machineKey(dir)`, which when it throws (a volume it cannot write) logs
  one line and is tried again every minute, the front door, the lease and the link running on meanwhile; a
  `CertificateKeeper` whose `ask` posts `{ signKey }`
  to `http://<app>/api/network/certificate` with `x-hornhoof-via: keeper` (10 s timeout) and reads the answer; a
  `Measures`; every `reportEveryMs` while its mode is `lead`, `POST http://<app>/api/network/report`, also with
  `x-hornhoof-via: keeper`, with `snapshot()`, `commit: config.commit` and `published` as `webPort` and `peerPort`. A
  failed post is one log line per hour at most. Without a machine id none of this runs, as plan 2's link.
- `compose.yaml`, the `keeper` service: `volumes` gains `keeper:/keeper`, `environment` gains `HORNHOOF_PORT:
  ${HORNHOOF_PORT:-8080}` and `HORNHOOF_PEER_PORT: ${HORNHOOF_PEER_PORT:-8180}`; the top-level `volumes` gains
  `keeper:`. Only `front` still publishes `HORNHOOF_PORT`.
- `Dockerfile`: the `deps` stage's `mkdir /control` becomes `mkdir /control /keeper`, and the final stage gains `COPY
  --from=deps --chown=node:node /keeper /keeper` beside `/control`'s, so a new `keeper` volume is the `node` user's
  (Docker copies the folder's owner into an empty named volume).

- [ ] **Step 1: Write failing tests.**
  - `machine-keys.test.ts`, on a temp folder: `makes the machine's key once and keeps it`: the file's mode is `0600`,
    a second `machineKey` gives the same public half; a file of garbage is replaced by a new key.
  - `keeper-certificate.test.ts`, with an `ask` that issues from a test authority (Task 2) and counts its calls:
    - `asks for a certificate when it holds none, and keeps it`: one ask, `certificate.json` written `0600`,
      `onChange` called once; a new `CertificateKeeper` on the same folder asks nothing and `current()` is that one.
    - `renews a certificate older than 7 days`: with `now` 7 days and 1 hour after the issue, `start()` asks once.
    - `tries again after a failed ask`: an `ask` that throws twice, then answers, with `retryMs` 50: three calls,
      one certificate.
    - `does not take a certificate for another key`: a `certificate.json` whose certificate names another key reads as
      none, and the keeper asks.
    - `asks again when told to`: holding a fresh certificate, `renewNow()` asks once; the held one stays `current()`
      until the answer comes, and a failed ask keeps it.
  - `measures.test.ts`: `takes the 99th percentile of what it kept`: with samples injected `1..100`, `fsyncP99Ms` is
    99; with 9 samples, null; `diskFree` is positive and `uptimeS` equals `Math.floor(os.uptime())` within 2.
  - `keeper.test.ts`, `gets its machine's certificate from its app and reports`: a keeper with a `testApp({
    TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID })` as its app (listening on `127.0.0.1:0`), its `dir` a temp folder
    `published` 8123 and 8223 and `reportEveryMs` 100: within 3 s `certificate.json` names the server's row with role
    `data`, and within 2 s more that row has `web_port` 8123, `peer_port` 8223, a `commit` and a `report_at`.
  - `compose.test.ts`: the keeper's exact environment keys gain `HORNHOOF_PORT` and `HORNHOOF_PEER_PORT`, its volumes
    are exactly `['control:/control', 'keeper:/keeper']`, and the file declares the volume `keeper`; plan 2's "no
    other service names `HORNHOOF_PORT`" becomes "no service but `front` publishes it". `prepares the keeper's folder
    in the image`: the `Dockerfile` makes `/keeper` in `deps` and copies it with `--chown=node:node`, as `/control`.
  - `keeper.test.ts`, `keeps leading when its folder cannot be written`: a keeper whose `dir` is a file, not a folder,
    takes and renews its lease and answers on its front door, and logs the folder's line once.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Keep the machine's key in the keeper's volume, get its certificate, and report its
  measures".

### Task 5: The peer link

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 4 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/peer-server.test.ts test/proxy.test.ts` passes; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/net/peer-server.ts`, `apps/server/src/net/peer-door.ts`
- Test: `apps/server/test/peer-server.test.ts` (new)

**Interfaces:**
- Consumes: `certFacts`, `makeCrl` (in tests), `CertFacts` (Task 2); `HeldCertificate`, `MachineKey` (Task 4);
  `passThrough`, `serve`, `firstForwarded`, `Target` (plan 2); `VIA` (Task 3).
- Produces:
  ```ts
  // net/peer-server.ts
  export const PEER_PATHS = { hello: '/peer/hello' } as const;
  export const APP_AUTHORITY = 'app:8080';
  export const DB_AUTHORITY = 'db:5432';
  export type Peer = { machine: string; role: MachineRole; serial: string; until: Date; address: string };
  export type PeerServerOptions = {
    held: () => HeldCertificate | null;
    key: MachineKey;
    crl: () => string | null;                           // the authority's CRL, PEM
    revoked: () => ReadonlySet<string>;                 // the serials revoked now, the CRL's and any since
    door: { connect(peer: Peer): Promise<Duplex> };     // a connection to the peer door for this peer
    db: Target | null;                                  // this machine's db; null: no CONNECT db
    hello: (peer: Peer) => Record<string, unknown>;     // answered with seen: peer.address added
    log: (line: string) => void;
    now?: () => Date;
    sweepMs?: number;                                   // 5000
  };
  export class PeerServer {
    constructor(opts: PeerServerOptions);
    listen(port: number, kind: 'peer' | 'app', host?: string): Promise<number>;   // host '0.0.0.0'; answers the port
    refresh(): void;   // takes held() and crl() again (setSecureContext), and closes every session whose serial is now
                       //   revoked or whose certificate has expired
    close(): Promise<void>;
  }
  // net/peer-door.ts
  export class PeerDoor {
    constructor(opts: { app: Target; holdMs?: number });
    start(): Promise<void>;                     // a serve(passThrough(...)) server on 127.0.0.1:0
    connect(peer: Peer): Promise<Duplex>;       // a TCP connection to it, the peer registered by its local port
    stop(): Promise<void>;
  }
  ```
- `PeerServer`: `http2.createSecureServer` with `held()`'s certificate and `key.privatePem`, `ca` the held
  `authorityPem`, `crl: crl()`, `requestCert: true`, `rejectUnauthorized: true`, `minVersion: 'TLSv1.3'`,
  `secureOptions: crypto.constants.SSL_OP_NO_TICKET`, `allowHTTP1: false` (ruling 12). It listens only once `held()`
  and `crl()` both give one. A handshake that fails (`tlsClientError`) logs one line naming the address and the
  error's code, at most once a minute per address. On each secure connection a second guard: `certFacts` must read,
  the serial must not be in `revoked()` and `notAfter` must be ahead of `now()`; then the socket is admitted with its
  `Peer`, else destroyed with the same log line. Node may set up the HTTP/2 session before that listener runs, so
  every stream handler first looks up its session's admitted `Peer`, checks it again (not revoked, not expired), and
  closes the session without one. Every `sweepMs` the server closes each session whose serial is in `revoked()` or
  whose `until` has passed, whatever `refresh()` does. Streams:
  - `GET /peer/hello`: 200 JSON `{ ...hello(peer), seen: peer.address }`.
  - `CONNECT` with `:authority` `app:8080`: `door.connect(peer)`, then 200 and both ways piped; a failed connect is
    502.
  - `CONNECT` with `:authority` `db:5432`: only on a `peer` listener, only for role `data`, and only with `db` set
    (else 403); a TCP connection to `db`, then 200 and piped.
  - Anything else: 404. A stream that closes or errors destroys its other side.
- `PeerDoor`: the server's `headers(req)` give `x-forwarded-for: firstForwarded(req) || peer.address`, `x-hornhoof-via:
  peer.machine`, and `x-hornhoof-invocation` with the incoming value when it is a uuid; the peer is the one registered
  for the request socket's remote port (a connection with none registered is destroyed). `passThrough` drops every
  other `x-hornhoof-*`, `x-forwarded-for` and `x-forwarded-proto` that came in, as plan 2 made it; upgrades pass.

- [ ] **Step 1: Write failing tests** in `peer-server.test.ts`, with a test authority, certificates made by Task 2 for
  a `data` machine (the server's), a `worker` and a second `data` machine, an app target that echoes the request's
  method, path and headers as JSON (and takes WebSockets), and a TCP echo as `db`; the server on `127.0.0.1:0` as a
  `peer` listener, and a second as an `app` listener:
  - `refuses at the handshake every client without a valid certificate`, on both listeners, with `crl()` a CRL
    listing a revoked worker's serial: no client certificate, a certificate of another authority, an expired one
    (issued with `now` 31 days ago) and the revoked one: for each the server emits `tlsClientError` and never
    `secureConnection` or `session`, the client gets no response, and the app target and the `db` echo see no
    connection.
  - `does not resume a TLS session`: a worker connects with `tls.connect` (ALPN `h2`), keeps the session it is given
    (`session` event), closes, and connects again with `session` set: the server's second socket has
    `isSessionReused()` false.
  - `answers hello with what the peer is seen as`: a worker's `GET /peer/hello` gives `hello()`'s fields and `seen:
    '127.0.0.1'`.
  - `names the peer to the app by its certificate`: through `CONNECT app:8080` and an HTTP request on the stream
    (`http.request` with `createConnection` returning the stream) carrying `x-hornhoof-via: forged`,
    `x-forwarded-for: 198.51.100.7` and `x-hornhoof-invocation: <uuid>`: the app sees `x-hornhoof-via` equal to the
    worker's machine id, `x-forwarded-for: 198.51.100.7` and the same invocation; a WebSocket over a second stream
    sends a message both ways.
  - `takes CONNECT db only from a data certificate on the peer door`: the second data machine reaches the TCP echo; the
    worker gets 403; on the `app` listener the data machine gets 403 for `db:5432` and 200 for `app:8080`.
  - `closes a session once its certificate is revoked`: a worker with an open `CONNECT app` stream; its serial added
    to `revoked()`, a CRL listing it as `crl()`, and `refresh()`: the session closes within 1 s, and its next handshake
    fails.
  - `closes a session once its certificate expires`: with `sweepMs` 50 and `now()` moved past the worker's
    `notAfter`, its open session closes within 500 ms with no `refresh()`, and a new stream on it is never answered.
  - `takes a new certificate of its own`: after `held()` changes to a second certificate of the server and
    `refresh()`, a new client sees the second one's serial.
  - `answers nothing before it holds a certificate and a CRL`: `listen` with `held()` or `crl()` null resolves only
    once both give one and `refresh()` is called; no port is open before.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Serve the peer link over mutual TLS, and pass a peer to the app under its certificate's
  name".

### Task 6: The keeper serves the peer link and offers it through the relay

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Task 5 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper-peer.test.ts test/peer-client.test.ts test/keeper.test.ts
test/keeper-link.test.ts test/lease-store.test.ts` passes, then the whole server suite; from the worktree root `npm
run test:real` passes and `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/link/peer-client.ts`
- Modify: `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/modules/link/tunnel.ts` (`TunnelKeeper`
  generic over what `read` answers), `apps/server/src/modules/keeper/lease-store.ts` (`othersHoldData`),
  `apps/server/test/fake-lease.ts` (`othersHoldData`, false unless given)
- Test: `apps/server/test/keeper-peer.test.ts`, `apps/server/test/peer-client.test.ts` (new),
  `apps/server/test/lease-store.test.ts`, `apps/server/test/real/lease-store.test.ts`, `apps/server/test/keeper.test.ts`
  and `apps/server/test/keeper-link.test.ts` (their keepers with a machine id get peer ports 0)

**Interfaces:**
- Consumes: `PeerServer`, `PeerDoor`, `PEER_PATHS` (Task 5); `CertificateKeeper` (Task 4); `GET /api/network/peers`
  with `crlPem` (Task 3); `tunnelSettings`, `TunnelKeeper`, `linkClientId` (plan 2).
- Produces:
  ```ts
  // modules/link/peer-client.ts
  export const peerClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-peer`;
  export const serviceName = (name: string, machineId: string, kind: 'data' | 'app'): string => `${name}-${machineId.slice(0, 8)}-${kind}`;
  export type PeerServices = { settings: TunnelSettings; secrets: { data: string; app: string } };
  export function peerConfigFor(services: PeerServices, opts: { machineId: string; local: { data: number; app: number } }): string;
  export function peerClientFor(services: PeerServices, opts: { machineId: string; local: { data: number; app: number }; dir?: string }): Client;
  //   its config is <dir ?? tmpdir()>/frpc-peer.toml, never the link's frpc.toml
  // KEEPER_PORTS gains peerApp: 7071. KeeperOptions: ports gains peer?: number and peerApp?: number (0 in tests);
  //   peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
  //   peerEveryMs?: number (5000), how often GET /api/network/peers is read; guardEveryMs?: number (10_000)
  // Keeper gains peerPorts(): Promise<{ peer: number; peerApp: number }>, resolved once the peer server listens
  // modules/keeper/lease-store.ts: LeaseStore gains
  //   othersHoldData(): Promise<boolean | null>;
  //   true when public.machines has a column role and a live row (revoked_at null) of role 'data' whose network_id
  //   is not this machine's; false when not; null when the read fails. It first asks information_schema whether the
  //   column exists, so it never fails on plan 4's schema.
  ```
- `peerConfigFor`, exactly, with the link frpc's head of plan 2 (`serverAddr` to `metadatas.client`) where `clientID`
  and `metadatas.client` are `peerClientId(name, machineId)`, then:
  ```toml
  [[proxies]]
  name = "<name>-<machine8>-data"
  type = "stcp"
  secretKey = "<data secret>"
  localIP = "127.0.0.1"
  localPort = <local.data>

  [[proxies]]
  name = "<name>-<machine8>-app"
  type = "stcp"
  secretKey = "<app secret>"
  localIP = "127.0.0.1"
  localPort = <local.app>
  ```
  The file is `frpc-peer.toml`, written 0600 as `clientFor` writes the link's `frpc.toml`, so the two children never
  share a file.
- The keeper, with a machine id and a database (a data machine; plan 5b brings the other kind):
  - a `PeerDoor` to its app, and a `PeerServer` with `held` from its `CertificateKeeper`, `crl` and `revoked` as
    below, `db` its database's host (`db:5432`, from `DATABASE_URL`'s host and port), listening as `peer` on
    `0.0.0.0:7070` and as `app` on `127.0.0.1:7071` once ruling 16's check below has passed; `refresh()` on each new
    certificate and each new CRL;
  - `GET /api/network/peers` with `x-hornhoof-via: keeper`, every `peerEveryMs`; a failed read keeps the last answer;
  - the check of ruling 16: the held certificate is current when `held.machine` is the answer's `machine` and
    `held.authorityPem` its `authorityPem`; when it is not (and the answer has both), `renewNow()`. The CRL is current
    when the serials it lists are the answer's `revoked`. The peer server first listens once, in this run, an answer
    found both current; later mismatches keep it listening, the second guard refusing what `revoked` names;
  - `revoked`: the last answer's serials; `crl`: the last `crlPem` the app gave, taken when the answer's serials
    differ from the held CRL's or none is held, and kept with its serials in `<dir>/crl.json` (`{ serials, crlPem }`,
    0600), read from there at start, so a keeper started while its app does not lead serves once an answer confirms
    that list; `refresh()` after each read;
  - `hello`: `{ machine, role, lead: mode() === 'lead', commit: config.commit }`;
  - a second `TunnelKeeper` (`restartMs` 2000, `everyMs` 3000) whose `read` answers `PeerServices` while the mode is
    `lead`, the link's `tunnelSettings` are there and the last answer's `link` has both secrets; `null` without a link
    or without secrets; `undefined` (keep what runs) when a read fails or no answer came yet; nothing before the peer
    server listens; its client is `peerClientFor(services, { machineId, local })`, or `opts.peerClientFor`, `local`
    being the peer server's two ports (7070 and 7071 in the container);
  - every `guardEveryMs` `lease.othersHoldData()`; while it last answered true, the keeper neither takes nor renews a
    lease with sync `alone`, so the lease lapses, and logs once `Another machine holds the company's data, so this
    machine does not lead alone.`; `null` keeps the last answer.
  - `stop()` ends both frpc children, the peer server and the door.

- [ ] **Step 1: Write failing tests.**
  - `peer-client.test.ts`: the exact `peerConfigFor` for `acme`, machine `ab12cd34` and 24 more hex digits, secrets of
    43 characters, local 7070 and 7071; `peerClientId` and `serviceName` as above; the file mode `0600`;
    `keeps its own file`: `clientFor` and `peerClientFor` on one folder write `frpc.toml` and `frpc-peer.toml`, and
    each keeps its content after the other writes again.
  - `keeper-peer.test.ts`, with `testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID })` as the app on
    `127.0.0.1:0`, a link saved as plan 2's `keeper-link.test.ts` saves one, a fake `peerClientFor` that writes the
    config to a file, the keeper's ports 0 and `peerEveryMs` 100, and a worker certificate the test issues (Task 2)
    for a `worker` row it writes with that certificate's key, with a `certificates` row for its serial:
    - `serves the peer link once its certificate is in`: once `peerPorts()` resolves, the worker's `GET /api/health`
      through `CONNECT app:8080` answers the app's 200; its `POST /api/network/report` through the stream with
      `x-hornhoof-via: keeper` and `{ commit: 'w1' }` sets the worker row's `commit` to `w1` and not the server's.
    - `keeps the network routes from the keeper's other doors`: `POST /api/network/certificate` with
      `x-hornhoof-via: keeper` through the keeper's front door, and through the link's http door, answers 403
      `not_keeper`.
    - `reads revocations as they come`: the worker's `certificates` row given `revoked_at`: its open session closes
      within 1 s, a new handshake is refused, and `crl.json` in the keeper's folder lists the serial.
    - `opens the peer link only after checking it with the app`: a keeper started on a folder holding a current
      certificate and a `crl.json` that does not list the worker's serial, which the database has revoked, with its app
      not answering: `peerPorts()` has not resolved after 1 s; once the app answers, the port opens and the worker's
      handshake is refused.
    - `takes a new certificate when the database does not know its own`: a folder holding a certificate of another
      authority for another machine id (as after a failed Update whose database was restored): the keeper asks for a
      new one, and the first client to connect sees a certificate issued by the database's authority.
    - `renews a peer's certificate through CONNECT app`: the worker's `POST /api/network/certificate` with its key
      through the stream gives a new `worker` certificate for its own row, whatever `x-hornhoof-via` it sent.
    - `offers the peer link and the app through the relay`: the fake config has `clientID = "<link>-<m8>-peer"`, both
      services with the secrets `GET /api/network/peers` gives, at the ports `peerPorts()` gave; with the link removed
      the client stops.
    - `leads alone on the schema before this plan`: `othersHoldData()` on a database whose `machines` has no `role`
      column answers false (the test drops the column on a fresh `createTestSql()`).
  - `lease-store.test.ts`, `knows when another machine holds the data`: false with only this machine's `data` row and
    a `worker` row; true with a second live `data` row; false again once that row is revoked. The same case in
    `real/lease-store.test.ts` through `keeperSql`.
  - `keeper.test.ts`, `stops leading alone when another machine holds the data`: with `guardEveryMs` 50 and a fake
    lease whose `othersHoldData` answers true, once it has been called the keeper makes no `take` or `renew` call in
    the next 500 ms and logs the line once; when it answers false again, the keeper takes a lease.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Serve the peer link from the keeper, offer it through the relay, and stop leading alone when
  another machine holds the data".

### Task 7: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `peer-link`. **Starts from:** Tasks 1 to 6 committed and reviewed. **Done when:**
Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Update is Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` → pass; both
  `tsc` commands → no output.
- [ ] **Step 2: Check the public-repo rule.** `git diff main --stat` lists no key or certificate file; `git grep -nE
  "BEGIN (EC |ENCRYPTED )?PRIVATE KEY|BEGIN CERTIFICATE" -- ':!*.md'` prints nothing and exits with status 1; `git
  diff main | grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` shows only `127.0.0.1`, `0.0.0.0` and addresses in
  `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`.
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.2, 3.8 "Keys" and section 10, the overview's
  plan 5 entry and this plan's rulings; the CLI agent that did not write a task reviews it too (Gemini for Codex's
  tasks, Codex for Gemini's); one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on a throwaway company on a machine of Ivan's, the team lead's test stand as in
  plan 4: install the current release (plan 4's) as `install.sh server --name rehearsal`, set it up with a random
  link; build the branch's images by hand (`gh workflow run images.yml --ref peer-link`) and read their digests; each
  update a `request.json` through a short updater container, as in plan 2. The checks, from `~/hornhoof-rehearsal`:
  plan 4's checks; `docker compose exec -T db psql -U hornhoof -d hornhoof -tAc "SELECT m.role, (SELECT max(until)
  FROM certificates c WHERE c.machine_id = m.id) > now() + interval '29 days', m.web_port, m.peer_port, m.report_at >
  now() - interval '1 minute' FROM machines m WHERE m.network_id IS NOT NULL AND m.revoked_at IS NULL"` gives one row
  `data|t|<web port>|<peer port>|t`; `docker compose port keeper 7070` gives the peer port;
  `docker compose logs keeper` shows frpc's `start proxy success` for `<link>-<machine8>-data` and `-app`.

  The probe from outside (the team lead's condition, ruling 12) goes through the published port as a remote machine
  would. It runs from another machine only when Ivan names one and gives access for it; otherwise on the stand's own Mac
  against the Mac's LAN address (`ipconfig getifaddr en0`, or `en1`), never `localhost` or `127.0.0.1`, with Homebrew's
  `openssl@3` (macOS's own `openssl` is LibreSSL and is not used), or, when that is missing, in a short `alpine`
  container with `openssl` installed, run with `--network host` and never on the compose network: `docker run --rm
  --network host -v <probe folder>:/probe -w /probe alpine:3.20 sh -c 'apk add --no-cache openssl >/dev/null && <the P
  calls below>'`. The step's report names which of the two it used. Everything runs in a temp probe folder removed
  afterwards. Its certificates come from the stand: `docker compose exec -T -w /app/apps/server app node
  --input-type=module < <ws>/probe-certs.mjs > <ws>/probe.json`, where `probe-certs.mjs` lives in the team lead's
  workspace, never in the repo: it reads `authority` with `pg` on the app's `DATABASE_URL`, decrypts the key with
  `decryptSecret` (`dist/crypto/secrets.js`) and `loadConfig(process.env).secret` (`dist/config.js`), finds the row
  whose `network_id` is `HORNHOOF_MACHINE_ID`, and with `issueCertificate` (`dist/modules/network/authority.js`) makes
  two `worker` certificates for that row, each for a new Ed25519 key: `expired` with `now` 31 days ago and `probe` with
  now, writes a `certificates` row for each (serial, that row, until), and prints the authority's certificate, both
  keys, certificates and serials as JSON. A certificate of another authority is made where the probe runs: `openssl req
  -x509 -newkey ed25519 -nodes -keyout oca.key -out oca.pem -subj "/CN=Hornhoof company other" -days 1`, then `openssl
  req -new -newkey ed25519 -nodes -keyout other.key -subj "/CN=other" | openssl x509 -req -CA oca.pem -CAkey oca.key
  -days 1 -out other.pem`. With `P() { sleep 2 | openssl s_client -connect <LAN address>:<peer port> -tls1_3 -alpn h2
  -CAfile authority.pem "$@" > out.txt 2>&1; echo "exit $?"; grep -aE 'alert certificate required|shutdown while in
  init|Verify return code|issuer=' out.txt; }`:
  - `P` (no certificate): `exit 1`, `alert certificate required` and `shutdown while in init`;
  - `P -cert other.pem -key other.key`, then `P -cert expired.pem -key expired.key`: `exit 1` and `shutdown while in
    init` (the handshake never finishes);
  - `P -cert probe.pem -key probe.key`: `exit 0`, no `shutdown while in init`, `Verify return code: 0 (ok)` and the
    issuer `CN=Hornhoof company <company id>`;
  - then on the stand `docker compose exec -T db psql -U hornhoof -d hornhoof -c "UPDATE certificates SET revoked_at =
    now() WHERE serial = '<probe serial>'"`, and after 10 s `P -cert probe.pem -key probe.key` gives `exit 1` and
    `shutdown while in init`;
  - `docker compose logs --since 5m keeper` names each refused probe once, and `docker compose logs --since 5m app` has
    no request from the probe's address.

  In this order:
  1. Forward, from the release to the branch build: it ends `done`, the checks pass, and the probe passes.
  2. `docker compose restart keeper`: `SELECT count(*) FROM certificates` gives the same before and after, and the
     checks pass.
  3. Back, a downgrade to the release: it ends `done`, the company leads, a change on localhost works, and nothing
     answers TLS on the peer port (`P` prints `no peer certificate available`).
  4. Forward again: it ends `done`, the checks pass, the count of `certificates` is the one of step 2 (the keeper's
     volume and the certificate survived the way back), and `P` without a certificate and `P` with `probe` both give
     `exit 1` and `shutdown while in init` (the revocation outlived the way back).
  Then remove the link in Share access, `docker compose down -v` in `~/hornhoof-rehearsal` only, remove that folder,
  and remove its registry line by hand. Any step that fails: stop and report, and Ivan is not asked to update.
- [ ] **Step 5: Merge** (team lead). The Update's title is the subject of the commit the images are built from, so the
  team lead writes the merge commit into main with exactly this subject (no double quote):
  ```text
  Give each company its own certificate authority, and its server the peer link
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** Before each Update, the team lead compares, reading only, the
  digest of the node image the company runs with the new release's, and tells Ivan in one line whether running turns
  will end (plan 4, ruling 10); when they will, Ivan picks a moment between turns. Ivan presses Update on his own
  companies himself, one at a time; the team lead never runs an install, an update or a `request.json` on them. After
  each, the team lead runs the checks above, reading only, and of the probe only `P` without a certificate and `P` with
  another authority's (no certificate of the company is made and nothing is revoked there), from the machine Step 4's
  rule picks (another machine only when Ivan names one and gives access, else that machine's own LAN address with
  `openssl@3` or the `alpine` container on `--network host`), and names which it used; then reports. When one fails,
  or the Update does not end within 20 minutes, the team lead tells Ivan which release to go back to, the one before,
  and how: in Versions, that release's Install button, or, when the app does not answer or only reads,
  `HORNHOOF_VERSION=<that release> install.sh server` (with `--name <name>` for a named company) on that machine. Ivan
  does it; then stop and report.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/peer-link` once main has the
  branch.

## Addendum: plan credentials stay on node keys (for the lead to rule on), and a node that waits gets its sign-in

Overview discrepancy 1 and this plan's overview scope promise plan credentials re-sealed to machine keys. Spec 3.8
"Keys" (spec:706-708) says section 7 seals them to machine keys; section 7 says so with its reason (spec:974-975);
section 10 rests on it (spec:1083-1085, 1091-1095). This plan's ruling 4 kept node keys, plan 7's ruling 2 made the
machine's age key, and no plan reseals. This addendum argues that node keys meet each promise, for the lead to rule
on, and gives the one gap it found its task. When the spec and the code disagree the spec binds, so the spec's words
stay unsettled until the lead rules.

**What a person gets today.** They sign a plan in once. Each node of the plan has an age key of its own in its folder
(`apps/node/src/keys.ts:5-16`), and `plan_credentials` holds one sealed row per node
(`apps/server/src/db/schema.ts:209-223`). The server hands a node its row, or asks a node that holds the sign-in to
seal one for it (`apps/server/src/modules/subscriptions/credentials.ts:54-92`). A plan has at most one node per
machine (`nodes_machine_plan`), so a node key is a key per machine and plan.

| What the spec promises | With node keys | With machine keys |
|---|---|---|
| "the server and copies store it but cannot read it" (spec:974) | holds: no private half leaves its node; rows replicate sealed | the same |
| "A new machine of the owner gets it re-sealed by another online machine of that owner" (spec:975) | holds at the new node's hello, while a holder is online (`credentials.ts:90-91`); a holder that comes online later is not asked: Task A1 | needs the same re-seal |
| A node added to a machine already in the plan's reach | waits for a holder to be online, and the Plans tab says "Signed in on <machines> only" | opens at once, if it was already sealed to that machine. The only thing node keys lose |
| A node set up again, its volume lost | a new key: its row goes and a holder seals again (`nodes/messages.ts:146-147`) | a machine key survives a node's volume, and is lost with the keeper's |
| A stolen machine (spec:1091-1095) | Disconnect clears `key_hash` (`nodes/disconnect.ts:16-19`), so it is never a recipient again (`lease.ts:15-21`). The thief holds what that machine's nodes hold, in either scheme, and the owner revokes the Claude token (p5b:1328). A stolen data machine's database opens only the plans that had a node there | every plan of the owner is sealed to that machine, also plans with no node on it, and its database holds them all. Worse |
| A backup restored (spec:722, 747-748) | no private key in a bundle; a surviving machine's node says hello with its old key and opens its row. A plan only on lost machines signs in again (plan 7's ruling 15) | the same |
| "A worker holds ... its node keys ... and its owner's sealed plan credentials" (spec:1083-1085) | as written | as written |

**What a reseal would cost.** A node must open its own sign-in, and a machine key lives in the keeper's volume, which
no node reads (ruling 4). Three ways round it, each worse: give nodes the machine's key, and on a data machine every
plan's node, where agents run, holds the key that opens every backup bundle (plan 7's rulings 2 and 3) and the secrets
sealed to it (p9:186); have the keeper open sign-ins for its nodes, and a worker's keeper, which holds no company
secret, now handles every plan's token in the clear; or a third key per machine that its nodes share, and one plan's
node opens another plan's rows, against what `guide/machines-and-plans.md` promises about keeping them apart. All
three add a node protocol change and a one-time reseal on every install, with Codex's lease racing it. The gain is one
row of the table: not waiting for a holder.

**Ruling for the lead:** keep node keys; no reseal; `SECURITY.md:27` ("only your own machines can") and the README
stand. Spec 3.8 and section 7's "machine keys" are read as the keys held on the owner's machines, and discrepancy 1's
fix stands withdrawn. Why: every promise holds, and two get stronger. Cost if wrong: a task in plan 7, after the age
key, for the protocol change and the reseal; nothing has shipped, so nothing is lost by deciding later. Plan 13's Task
2 words the guide this way.

### Task A1: A holder that comes online seals for a node that waits

**Repo:** the `network` worktree, branch `network`. **Starts from:** this plan's Task 6 committed. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/credentials.test.ts` passes, then the whole server
suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Modify: `apps/server/src/modules/subscriptions/credentials.ts` (`pushCredentials`)
- Test: `apps/server/test/credentials.test.ts`

**Interfaces:**
- Consumes: today's `keyedNodes`, `deliver`, `cred.seal`; the node's `sealCredential`, which takes any list and
  answers `cred.sealed`.
- `pushCredentials`, in its last path (a plan that is not a held Codex plan), when `mine` is set: besides `deliver`,
  one `cred.seal { kind, version: node.credVersion, recipients }` to this node, `recipients` being `keyedNodes` of the
  plan with no row in `held`, when there are any. A Codex plan with a holder already does this
  (`credentials.ts:85-86`), and is left as it is. The node opens its own row first and then seals, since its messages
  take effect in order (`inOrder`, `apps/node/src/main.ts`).

- [ ] **Step 1: Write failing tests** in `credentials.test.ts`:
  - `has a holder that comes online seal the sign-in for a node that waits`: a plan at version 1; node A holds its
    row, offline; node B with a key says hello, and nothing is sent (no holder online); A says hello: A gets
    `cred.put` with its row and `cred.seal` with version 1 and recipients B alone; A's `cred.sealed` for B: B gets
    `cred.put`.
  - `asks nothing when every node holds it`: A and B hold their rows; A's hello: `cred.put`, and no `cred.seal`.
  - `seals for no node without a key, and none that was disconnected`: B with no `public_key`, and C disconnected
    (`key_hash` null): A's hello sends no `cred.seal`.
- [ ] **Step 2: Run** Done when. Expected: FAIL: `has a holder ...` gets no `cred.seal`.
- [ ] **Step 3: Implement** in `pushCredentials`.
- [ ] **Step 4: Run Done when.** Expected: PASS, the Codex tests as they were.
- [ ] **Step 5: Commit** "Have a machine that holds a plan's sign-in seal it for one that waited, when it comes
  online".
