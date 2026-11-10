# Network Phase 1, Plan 7: Encrypted Backups on Other Machines, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every 6 hours and before every update, the company's leading machine turns a dump of its database and the
`.env` secrets a restore needs into a bundle: sealed with age to the machines that hold the data and to the recovery
key, signed with the machine's certificate, recorded in `net.backups`. Up to three other machines of the company pull
each bundle over the peer link and keep the latest two, which they cannot open. The CEO saves the recovery file in
Settings and restores the company from a bundle any online machine holds; after a total loss, a fresh server restores
from the recovery file with the bundles a surviving machine sends it, or one uploaded in the browser.

**Architecture:** Two migrations: `0052_backups` (generated: `machines.age_key`, `keeps_backups` and `held_backups`,
and the hidden table `recovery_keys`) and `0053_net_backups` (custom: `net.backups` with plan 3's fence). The folder
`modules/backups/` holds the bundle's format (`bundle.ts`: seal, check, open, the recovery challenge), the store bundles
are kept in on disk (`store.ts`), and the app's side: the records (`records.ts`), the holders (`holders.ts`), the
recovery file (`recovery.ts`), restores (`restore.ts`), the total loss (`total-loss.ts`) and the routes (`routes.ts`).
The updater makes each dump into the control folder and swaps a restored database in, with a journal for each step
and, at the moment the old database closes, a copy of who may get in now (`carry.sql`). The data machine's keeper
(`modules/keeper/backups.ts`, `restore.ts`) seals and signs each dump, records it through its app, serves bundles on the
peer port and opens one for a restore. A worker's keeper (`modules/keeper/holder.ts`) pulls, checks and keeps bundles,
and when no leader answers for 10 minutes, challenges a new server and sends them. The web app gets the backups part of
Settings, a banner, the card's tick and the setup screen's restore.

**Tech Stack:** TypeScript on Node 22 (`node:crypto` Ed25519, `node:http2`, streams); `age-encryption` 0.3.1 (typage),
pinned already in `apps/web` and `apps/node` and now in `apps/server`; Fastify 5; drizzle-orm 0.45.4 on node-postgres
and PGlite; bash 3.2 and BusyBox for `updater.sh`; React for the web app; vitest with PGlite; Docker for `npm run
test:real` and `npm run test:lab`.

**Spec:** `notes/specs/2026-11-02-single-network-design.md` 3.8 ("Keys", "Recovery file", "Making", "Holding",
"Restoring", "Total loss"), 3.3 ("Who may hold data"), 3.2 (the leader keeper's backups endpoint, which the `-app`
service reaches too), 3.1 (the updater's row: backups), section 10 ("Backups", "A stolen machine") and section 12
("Backups and certificates"). Overview `notes/plans/2026-11-03-network-phase-1-overview.md`, plan 7's entry, and its
discrepancy 15 (`SECURITY.md`'s backups).

**Who writes the code.** Codex and Gemini CLI write it, one task at a time, and the team lead reviews each task before
the next starts. Each task below is a brief that stands on its own: hand an agent the part of this plan from the top to
the end of Review Focus, plus that one task. Its **Repo** line names where to work, **Starts from** what must already be
there, and **Done when** the command that proves it. The agent writes the failing tests first and runs them to see
them fail, then the code, then runs **Done when**, commits as the Global Constraints say, and stops. It changes only
the task's files, never touches a running company, the droplet, GitHub or another task, and stops and reports when a
test of an earlier task fails or a fact the task rests on proves wrong. Nothing here is run by the planner.

**One repository.** Hornhoof, `/Users/0x/Projects/Hornhoof-archive`, in a new worktree
`/Users/0x/Projects/Hornhoof-archive/.claude/worktrees/backups` on a new branch `backups` from main (`git worktree
add`, then `npm ci` there once), after plan 6 is merged into main and shipped.

**Handed over** (merged and shipped before this plan starts):
- Today's code: `apps/updater/updater.sh` (`backup`, `restore`, `applied`, `healthy`, `handle_request`, `interrupted`,
  `say`, `compose`, `env_value`, the loop that runs `handle_request` every 2 s and `computer_runs` in the background,
  `KEEP_BACKUPS`, `--once`, `HORNHOOF_HEALTH_WAIT`) and its tests (`test/updater.test.ts`, `test/updater-stubs`);
  `modules/setup/code.ts` (`setupCode`, `isSetupCode`, `setupNeeded`) and `modules/setup/routes.ts` (`setupOnly`,
  `GET /api/setup`); `modules/link/link.ts` (`linkOf`, `saveLink`, `writeTunnelSettings`, `TUNNEL_FILE`, `PublicLinks`)
  and `public_links`; `modules/nodes/routes.ts` (`LendBody`, `PATCH /api/machines/:id`, `ownMachine`, `GET
  /api/machines`); `modules/nodes/disconnect.ts` (`disconnectMachines`); `people.status`, `people.is_owner`,
  `sessions`; `nodes.status` (`needs_login`); `encryptSecret`, `decryptSecret`; `db/client.ts` (`MIGRATIONS`);
  `config.secret` (32 bytes), `config.relayUrl`, `config.controlDir`; `modules/updates/control.ts` (`UpdaterControl`,
  `status`, `request`) and `modules/updates/routes.ts` (`POST /api/updates`, `sendWhenIdle`, `send`); in `apps/web`
  `screens/Settings.tsx` (the dialog titled "Share access", `t.settings`), `screens/Setup.tsx`, `screens/Machines.tsx`
  (`LendSetting`), `screens/Shell.tsx` (`AccountMenu`, `onSettings`), `api.ts`; `apps/node/src/keys.ts`
  (`nodeIdentity`, the way a key file is made); `SECURITY.md`, `README.md`, `guide/`.
- Plan 1b: `linkMode`, the tunnel settings' `mode` (`http` until the company holds a certificate).
- Plan 2: `updaterBusy(dir)` and `AppMode`; the keeper's link child, whose `read` is `tunnelSettings(db, config)`;
  `TunnelKeeper`; compose's `keeper` service and `compose.test.ts`'s exact list of its environment keys.
- Plan 3: the schemas `net` and `net_local`, `net.fence_check()`, the `net_fence` trigger and `problems()` (`net.<table>
  has no fence trigger`); `net_local.state` (`term_number`, `cluster`) and `net_local.lease`; `LeaseStore.take` (the
  highest of the state's and the lease's numbers, plus one); `HIDDEN`, `CLOSED`, `migrateDb`, `AFTER_MIGRATIONS`; the
  test fixture's endless lease (`createTestSql`, `openTestDb`); `npm run test:real` with `realDatabase()`
  (`test/real/pg.ts`) on Postgres 17.11.
- Plan 5: `modules/network/authority.ts` (`makeAuthority`, `issueCertificate`, `certFacts`, `CertFacts`, `issuedBy`,
  `Authority`), `store.ts` (`authorityOf`, `findThisMachine`, `thisMachine`, which retires and revokes every other
  `server:` row), `via.ts` (`askerOf`, `OWN_VIA`); `certificates`; `POST /api/network/report`; the keeper's
  `KEEPER_DIR`, `machineKey`, `MachineKey`, `HeldCertificate`, `CertificateKeeper`, `Measures` (`diskFree` of the
  keeper's volume); `net/peer-server.ts` (`PeerServer`, `PeerServerOptions`, `PEER_PATHS`, `Peer`), listening as
  `peer` on 7070 and as `app` on 7071, which the `-app` stcp service reaches.
- Plan 5b: `keeperAsker` and the keeper's mark; `PeerLink` (`use`, `leader`, `request`, HTTP/2 sessions with a 1 MiB
  window); `WorkerKeeper`, `WorkerConfig`, `workerConfig`, the worker's report and its `peers.json` view (`data`,
  `link.url`); `onlineShare`; `machines.network_id`, `role`, `addresses`, `disk_free`, `report_at`; `revokeMachineRows`
  in Disconnect; compose's `compose.worker.yaml` and `${VAR:-}` rule; `updater.sh`'s worker mode; the lab
  (`apps/server/test/lab/lab.ts`, `Lab`, `LabMachine`, `join.test.ts`, `npm run test:lab`).
- Plan 6: migration `0051_computer_access` (`machine_access`, `computer_runs` and its state `lost`); `GET
  /api/machines`'s `core`.
- Where main's code differs from these names, the agent stops and reports.

## Global Constraints

- Repo text in English; no em dashes anywhere; in Russian "е" not "ё", and "машина"/"нода", never "компьютер"/"узел".
  Every UI string goes into both `apps/web/src/i18n/en.ts` and `ru.ts`.
- Commits only as `git -c user.name="Ivan Korol" -c user.email=invariant0x@icloud.com commit`, no Co-Authored-By, no
  "Generated with" lines; messages are plain sentences, as on main. Never commit `notes/`, `.claude/`,
  `.superpowers/`, `archive/`, `companies/`, `deploy.env`.
- Nothing private in the repo: no droplet IP, no hostname but hornhoof.org and names under it, no key, token, ssh
  config or certificate file, no company's link name. Tests use `127.0.0.1`, the documentation ranges, hosts under
  `hornhoof.test`, and keys, certificates and recovery files made at run time.
- One npm dependency more: `age-encryption` 0.3.1 in `apps/server`, the version `apps/web` and `apps/node` pin, so
  the lockfile gains no new package. Two new migrations, never an edit of an older one: `0052_backups` by `npx
  drizzle-kit generate --name backups`, then `0053_net_backups` by `npx drizzle-kit generate --custom --name
  net_backups`, both from `apps/server`.
- No private key ever leaves the machine that made it: a machine's age key and Ed25519 key stay in its keeper's volume;
  the recovery identity exists only in the file the CEO saves and, while a restore needs it, in the memory of the app
  and of the data keeper, and nowhere else. It crosses only the keeper's own request to its app (`GET
  /api/network/backups`, whose request and answer are never logged), the keeper drops it when the order ends or is
  called off, and it is never written into `/control/restore`, a status or a log line. None of them goes into the
  database, a bundle, a log line or a file of the control folder.
- No plaintext dump stays anywhere but on a data machine: a dump in the control folder is sealed and deleted, or
  deleted after a day; a worker only ever holds sealed bundles. Today's plaintext dump before an update stays in
  `backups/` on the server, as the spec allows. A restore's carry (ruling 14) holds password hashes: it is 0600 in the
  server's control folder and removed once applied.
- The age library's errors can quote the key they were given: none reaches a log, an answer or a thrown error's
  message; each is replaced by a fixed message without its cause.
- Ivan's rules: only a machine's owner opens computer access to it (plan 6, unchanged); no step of this plan asks Ivan
  to type a command. Everything Ivan does here is a click: saving the recovery file, a restore, a tick.
- Messages between keepers and the app change only by additions; a keeper one version apart keeps working (ruling 18).
- Tests first. From `apps/server`: `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/<file>`; from `apps/web` the
  same with its files; the whole suite from the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000`; `npm run test:real` and `npm run test:lab` need Docker. Types, from the worktree root: `npx tsc
  -p apps/server/tsconfig.json --noEmit`, and `apps/web` likewise when touched, each printing nothing. `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` print nothing when it is touched. Never run prettier.

## Rulings made while planning

1. **One plan, in the order a bundle travels.** Making, holding, the recovery file, restoring and the total loss are
   one chain that only works whole, and each task below ends in something a reviewer can reject alone, so the plan is
   not split. Left to later plans: fork dumps (spec section 5) are plan 8's, and so is merging the database a restore
   sets aside; copies, and with them more recipients, a recovery pair renewed when a machine loses whole-company scope,
   "Debian leads; restore there" and taking the name with no leader, are plan 9's, the first plan with a second data
   machine.
2. **Each machine's age key is its keeper's.** Plan 5's ruling 4 left it here. Every keeper, the data machine's and a
   worker's, makes an X25519 key for age in its volume (`age.key`, mode 0600, as the node makes its own today) and
   reports the public half, which the app keeps as `machines.age_key`. A keeper that loses its volume, or finds a key
   that does not decode whole, makes a new one; bundles sealed to the old key then open only with the recovery file.
3. **Bundles are sealed to the machines that hold the data, and to the recovery key.** The spec says "every machine
   that may hold data (3.3)". This plan reads that as the live rows of the role `data`: the leader now, its copies
   from plan 9. A CEO's worker that could take a copy is not a recipient while it is a worker: plan 5b's rule is that a
   worker holds no company secret, the spec's section 12 that a holder cannot decrypt, and a worker may be a holder.
   (Deviation to rule on.) The leader's own key is always among them, also before its row has it.
4. **The bundle.** One file, three parts, so it travels as one stream and is checked before it is opened:
   - the line `hornhoof-bundle v1`;
   - the head, one JSON line `{ "manifest": "<text>", "signature": "<base64url>", "certPem": "<PEM>" }`, at most 64 KiB.
     `manifest` is the exact text signed: the JSON `{ v: 1, id, company, dumpedAt, madeAt, reason, size, sha256,
     recipients, recovery, recoveryLink, migrations, signer, serial }`, where `dumpedAt` is the dump's time, the
     moment a restore brings the company back to, `madeAt` the time it was sealed and signed, `reason` `timer` or
     `update`, `size` and `sha256` are of the age part, `recipients` the age keys it is sealed to, `recovery` the
     recovery key among them or null, `recoveryLink` the `{ name, url }` of the link that key was saved with or null
     (a survivor's challenge needs that name, ruling 16), `migrations` the count the dumped database had applied,
     `signer` the signing machine's row and `serial` its certificate's. The signature is Ed25519 by the machine's key
     over `hornhoof-bundle-manifest v1\n` and the text;
   - the age part, whose plaintext is the line `hornhoof-bundle-content v1`, a JSON line `{ id, company, secrets: {
     HORNHOOF_SECRET, NODE_KEY, RELAY_URL } }` and the gzipped `pg_dump`. Not `POSTGRES_PASSWORD`, and no private key.
   On disk a store keeps `<id>.head` and `<id>.age`. It takes each transfer into a temporary file of its own, stops
   it as soon as it passes the signed size, with too little free disk or after 30 s without a byte, and publishes a
   bundle once: what it published is never written again, and a restore hashes the stored file again before opening
   it. A check, before anything is opened: the head parses; the
   certificate is `issuedBy` the company's authority, names the role `data` and the manifest's `signer` and `serial`,
   and its `notBefore` and `notAfter` hold `madeAt`, so a later expiry does not matter (a dump sealed after an update is
   signed with the certificate its keeper holds then, which may be newer than the dump); the signature verifies with the
   certificate's key; `company` is the company; the age part's size and SHA-256 are the manifest's. Opening checks the
   content's line and that its `id` and `company` are the manifest's, so an age part moved under another head is
   refused.
5. **The updater dumps; the keeper seals, signs and records.** The keeper holds the signing key and the age key, and
   only the updater reaches `pg_dump` (in `db`), so: the data keeper writes `/control/dump.json` `{ id }`; the
   updater (root) dumps to `/control/dumps/<id>.sql.gz` with `<id>.json` `{ id, reason, at, migrations }`, or
   `<id>.failed`, and then removes `dump.json`. The folder `dumps/` is 0700 and every file in it 0600, all given to
   the control folder's owner, which is the keeper's user, so the keeper reads and deletes what root wrote. After its
   own dump before an update, the updater puts a copy there too, with the reason `update`. The keeper seals each dump
   it finds there to the recipients its app names, writes the bundle into its store, records it (`POST
   /api/network/backups`), and deletes the dump; a dump whose id its store holds already is deleted unsealed, and a
   dump not sealed within a day is deleted, whether its app answers or not. A timer bundle is due 6 hours after the
   newest in `net.backups`, at once when there is none, and at once when the recovery key changed since the newest, so
   a new recovery file soon has a bundle. One dump at a time: no new `dump.json` while one is there or a dump waits to
   be sealed, and at most one per 10 minutes, but for the first dump after a new recovery key. The keeper keeps its own
   latest 2. It makes nothing while its app does not lead, or without a data certificate.
6. **`net.backups` is written by the app, on its own keeper's word.** The table is in `net`, with the `net_fence`
   trigger, out of the agents' reach (plan 3). The record route takes only the data keeper's own request: the head
   must check (ruling 4) against the database's authority, its signer must be this machine's live row with the role
   `data` and its serial a live certificate of that row, and `madeAt` within a day of now. So no worker records a
   bundle, and a restore with a database left checks a bundle against its row.
7. **Holders are picked per bundle.** For each bundle with a recovery key, the app picks up to 3: live rows with a role
   but `data`, `keeps_backups` on, an active owner, a report within 2 minutes and `disk_free` at least 3 times the
   bundle; first those that share a `/24` with the leader's addresses, then by `onlineShare`, then by free disk. One
   place is off site: when none of the picks is outside the leader's `/24` and a machine outside it qualifies, the best
   such one takes the last place, so a home lost to fire, theft or flood does not take every copy with it; with none
   outside, all three are at home. The picks are kept on the bundle's row. Every hour the newest 2 such bundles are
   looked at again, and a holder that was ticked off, disconnected, or has not reported for a day gives its place to the
   next. A bundle without a recovery key gets no holder: until the first save the bundles stay on the data machine
   (spec), since no one could open them once it is lost.
8. **The backups endpoint is the leader keeper's, on both of its peer listeners.** `GET /peer/backups/<id>` streams a
   bundle to a machine the app picked for it, and `PUT /peer/backups/<id>` takes one from a holder the app asked for it
   (ruling 12); every other machine gets 403. On 7070 and on 7071, so a worker on the relay reaches it too (spec 3.2).
   The holder pulls; nothing is pushed into a worker.
9. **A holder keeps what it can still use.** Every minute while it has a leader, a worker's keeper asks its app which
   bundles to hold, fetches what it lacks into its volume, and checks each against the authority it holds. It deletes
   a bundle only when the answer names at least one bundle, it holds every one named complete, and the one it deletes
   is not named and older than the newest it holds of them; or when its owner unticked "Keep company backups" (the
   answer's `keeps` false). So an empty answer, as a restored database gives before its first new bundle, deletes
   nothing, and without an answer it deletes nothing either: a holder keeps its bundles through a total loss. It
   fetches only with 3 times the bundle free, and reports what it holds.
10. **The recovery file.** "Save the recovery file", by the CEO on his own session while the app leads: the app makes an
    age key pair and answers the file once, `no-store`. The file is a comment line, then one JSON line `{ v: 1, kind:
    'hornhoof-recovery', company, companyName, identity, recipient, madeAt, link, authorityPem }`, `link` being the
    tunnel settings (`url`, `name`, `key`, `tunnel`) or null. The app keeps only the public half, in `recovery_keys`
    with the print, name and url of the link it was saved with. The newest key whose print matches the link now is the
    company's recovery key; a save retires the older ones, and the screen says the old file opens only older bundles.
    When the link changes (taken, renamed, removed, or its key changed by a later plan), the key no longer matches:
    later bundles are sealed without it and a banner asks for a new file. Losing whole-company scope renews nothing in
    this plan: no machine but the server holds data before plan 9, which renews the pair with the role change.
    (Deviation to rule on: the spec renews it on a lost scope too.)
11. **Settings.** The dialog the account menu opens as "Share access" becomes "Settings" (`Настройки`), with its link
    part as today and, for the CEO alone, a part "Backups": the last bundle's time, the recovery file, the bundles and
    where they are held, and "Restore". A banner for the CEO asks for the recovery file while there is none. Each
    card of a machine with a core but the server's has the tick "Keep company backups", which its owner or a person
    who sees the whole company changes, as "Lend to test runs".
12. **Restore from a backup runs on the leader, by its keeper and its updater.** The CEO picks a bundle that the
    leader's keeper or an online holder holds. The warning names what the restore undoes: everything after its time
    stays in the database it replaces, which is kept on this machine until plan 8 merges it; machines that joined and
    people added after it are not in it. The keeper gets the bundle (from its store, or from the holder, which the app
    asks to send it), checks it, with the database's `net.backups` row too, and opens it with its own age key, or with a
    recovery file the CEO adds in the dialog, held in the memory of the app and of its keeper for an hour at most
    (Global Constraints). It writes the dump and the secrets into `/control/restore/` and asks the updater, which swaps
    the databases (ruling 13). A bundle made by a newer build than this one (more migrations than it knows) is refused:
    "Update first." Each restore is an attempt with its own id, so a failed one can be tried again with the same bundle.
    Restores and updates share one claim on the updater, taken before anything else is checked: a restore is refused
    while an update is out, also while it waits for idle or sits in `request.json`, and an Update while a restore is
    out.
13. **The swap.** The updater stops `app` and `node` and loads the dump into `hornhoof_restore` as `restore()` does
    today (a failed load changes nothing). Before each change after that it writes a journal
    (`/control/restore-journal.json`: the attempt, the stamp and the last change made), so an updater restarted at any
    point puts everything back from it. It checks the secrets and saves `.env` as `backups/env-before-<stamp>` before
    anything is switched. Then, in one session on `hornhoof`, it turns its connections off, ends every other session
    and waits until none is left (10 s at most, else nothing changed), and reads the highest term number of its state
    and lease, its `machine` and `cluster`, and the carry (ruling 14): nothing can change them after that. The restored
    state takes that `machine`, `cluster` and a term number no lower, and an empty lease. It renames `hornhoof` to
    `hornhoof_before_<stamp>` (connections stay off), the restored one to `hornhoof`, writes the bundle's three secrets
    into `.env`, and only then marks the step `start`: a status at `start` means the swap is committed. It starts every
    service but `db` and `updater` again; when the company answers within `HORNHOOF_HEALTH_WAIT`, the restore is
    `done`, also when the updater was restarted at `start`; else it puts the old database and `.env` back, and only
    then writes `failed`. The plaintext files go in every outcome. The keeper shows the maintenance page meanwhile:
    `updaterBusy` is also true while `restore-status.json` says `running` at a step of the updater's.
14. **A restore keeps who may get in now.** Until plan 8 merges, the restored database would bring back a machine
    disconnected, a person disabled, a password reset, a scope narrowed or a recovery file replaced after the bundle.
    So the updater takes the carry from the old database at the moment it closes (ruling 13), with `carry.sql`: every
    person's status, password hash, scope, `is_owner` and access; the invites open now; each machine's revocation and
    its owner's ticks; the revoked serials; the recovery keys. Once the swap is committed, the app applies it at its
    first lead to everyone and everything both databases have, closes computer access on every machine (its owner
    opens it again, plan 6), marks every computer command not done `lost`, and ends every session, so everyone signs
    in again; until then every route but `/api/health` answers 503. A restore from a recovery file has no database to
    take this from. (An addition to rule on.)
15. **Total loss.** A fresh `install.sh server`'s setup screen offers "Restore from a recovery file", guarded by the
    setup code as setup is. The app keeps the file in memory and writes its link to `/control/recovery-link.json`, which
    the keeper's link child uses, in `http` mode, while the database has no link; the relay hands the name over once the
    old route is gone (plan 1, R1.1 and R3.1). It takes a challenge (`POST /api/recovery/challenge`, at most 1 KiB):
    only when the age file opens with the recovery identity and its plaintext is exactly
    `hornhoof-recovery-challenge v1`, the link name and a 32-byte nonce, line by line, does it answer, and then with a
    proof made from the nonce (an HMAC keyed by it), never the nonce; anything else is refused before or after
    opening, so a bundle never passes as a challenge. Each bundle sent after it carries a second proof made from the
    nonce and that bundle's id, so the relay, which sees both proofs, can neither learn the nonce nor send another
    bundle with them; a challenge sent again keeps its first hour. It takes bundles with such a proof, for an hour, or
    with the setup code from the browser, each checked against the file's authority, company and recovery key, two at a
    time at most and each within the bounds of ruling 4. The CEO picks one, and the keeper and the updater restore it
    as in rulings 12 and 13, without the `net.backups` check, which needs a database. A plan whose sign-in was only on
    a lost machine is signed in again on a machine that is on, under Subscriptions, as a new plan is; the last screen
    says so in one line rather than listing them. (Deviation to rule on: the spec has the restore screen list them.)
16. **Survivors.** A worker's keeper that holds bundles with a recovery key and has had no leader for 10 minutes
    challenges, every 5 minutes, the url of the link that key was saved with (the manifest's `recoveryLink`), its
    cached link's `url` when another, its join server, then each data machine's web address from its view: a new
    server at the old address is found without a link too. The challenge carries the manifest's link name, so a link
    renamed or removed since does not stop it. When one answers with the right proof, it sends that server every
    bundle it holds for that recovery key, newest first, and remembers the target for that key: later rounds send it
    only bundles it has not sent yet, and challenge it again after 50 minutes. A send that moves no byte for 30 s is
    cut, and the next target is tried. Each challenge is one log line with the target and how it ended, never a nonce
    or a proof. After the restore it renews as plan 5b says (its row is in the bundle) and finds the new leader. The
    lab shortens the 10 minutes by the keeper's `HORNHOOF_SURVIVOR_S`, as it shortens other waits.
17. **What phase 1 leaves open.** (Deviations to rule on, each with its reason.) a) Machines that joined after the
    bundle's time are not in the restored database. Their keepers' renewals get plan 5b's unsigned 404, which they do
    not take as a disconnection, so they keep trying and do nothing for the company; their cards are gone from
    Machines, and their owners join them again with a new command from the Machines tab. A signed answer for a machine
    the database does not know comes with plan 8's merge. The warning names them. b) A restore from a recovery file
    cannot carry what was taken away after the bundle (ruling 14); the Machines tab shows every machine of the
    restored company, and the CEO disconnects one he lost. With no database, such a restore also trusts any bundle a
    data certificate of the authority signed while valid at its `madeAt`: a data machine's old signing key, if
    stolen, could sign a backdated one; with a database, the recorded hash closes that. c) Without a public link, a
    new server is found only at an old address (ruling 16). d) Nothing downloads a bundle to the browser, since the
    bundles sit in the keeper's volume and the app has no stream from it: the survivors are the way that needs only
    clicks, and the upload is for a bundle copied off a machine some other way. e) A bundle a survivor sends through
    hornhoof.org crosses the relay as one long request body; the lab has no relay, so Task 11's review reads plan 1's
    Caddy and relay settings for a body limit or timeout below a bundle's size, and stops the merge when it finds one;
    a survivor cut off there goes on to the old addresses.
18. **One version apart.** Workers follow the leader's build (plan 5b), so a holder is newer than its leader only
    while it follows an Update back, and a worker before this plan neither asks nor holds. The report's new fields are
    optional; a keeper that gets 400 from a report sends it again without them. Routes this plan adds answer 404 on an
    older app, which keepers take as "nothing to do", deleting nothing. The first update to this build is run by plan
    6's updater, which makes no bundle before it; from then on every update has one.
19. **The texts.** `SECURITY.md`'s backup lines (written ahead, overview discrepancy 15) and `README.md`'s become
    exact: the machines that hold the data and the recovery file open a bundle; the dump before an update stays
    unencrypted on the server, which holds the database anyway. `guide/backups.md` tells where each click is.

## Review Focus

1. A bundle that must not be restored: an age part swapped under another head, a head with another signature, a
   bundle a worker signed, a certificate not valid at `madeAt` or of another authority, another company's bundle, one
   with no `net.backups` row or another hash while a database is there, one made by a newer build, a challenge file
   offered as a bundle, a second upload of the same id racing the first, a body longer than its signed size. Each is
   refused before anything is opened or written to `.env`. Tests in Task 2 (`refuses what it must not open`, `takes
   each bundle once, whole`), Task 7 (`restores only a bundle its database knows`) and Task 8 (`takes only bundles of
   its recovery key`).
2. Anything but a recipient reading a bundle: a holder's own age key, the app's database, a log line, an error's
   message, the control folder. A worker's key is never a recipient; no plaintext dump is left in `/control/dumps`
   after sealing or after a day, nor in `/control/restore` after a keeper restart; the recovery identity is never
   stored and lives only in the memory of the app and the data keeper. Tests in Task 2 (`a holder cannot open it`,
   `never shows a key it cannot read`), Task 3 (`seals only to data machines`), Task 5 (`leaves no plaintext dump`),
   Task 7 (`leaves nothing open after a restart`, `keeps the recovery identity in memory only`, `hands the identity
   over without logging it`) and Task 8 (`keeps the recovery file in memory only`).
3. A restore that fails half way: a dump that does not load, a session that does not end, a rename that fails, a
   value `.env` cannot hold, a new company that does not answer, the updater restarted at each change, an Update asked
   meanwhile. The company comes back as it was, with its `.env`, and says so; or, once committed, stays restored and
   says so. Tests in Task 4 (`puts the old database back when the restored one does not answer`, `goes back from
   every change it was stopped at`, `keeps a committed restore that answers`) and Task 7 (`one restore or update at a
   time`).
4. A holder that loses its last bundles it could restore from: its leader gone, an empty answer after a restore, a
   new bundle without a recovery key, its disk short, a download cut half way. It keeps what it had. Tests in Task 6
   (`keeps its bundles without an answer`, `keeps its bundles through an empty answer`, `deletes only after the new
   ones are complete`).
5. The total loss's doors: a challenge with another string, link name or size, a proof used after an hour or for
   another bundle, a challenge or upload replayed by the relay, an upload without a proof or code, any recovery route
   once a company exists. Each is refused and writes nothing. Tests in Task 8 (`answers only its own challenge`,
   `gives the relay nothing to reuse`, `closes once a company exists`).
6. A restore bringing back a disconnected machine, a disabled person, an old password, a wider scope, a replaced
   recovery file or open computer access. Tests in Task 4 (`takes the carry when the old database closes`) and Task 7
   (`keeps who may get in now`).

---

### Task 1: The tables for backups

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** main with plan 6 merged. **Done when:** from
`apps/server`, `VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/migrations.test.ts
test/orchestrator-control.test.ts test/lease-store.test.ts` passes, then the whole server suite; `npx tsc -p
apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/drizzle/0052_backups.sql`, `apps/server/drizzle/0053_net_backups.sql` (with their `meta`
  files)
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/db/agent-sql.ts` (`HIDDEN`),
  `apps/server/src/modules/tools/database.ts` (`CLOSED`)
- Test: `apps/server/test/migrations.test.ts`, `apps/server/test/orchestrator-control.test.ts`,
  `apps/server/test/lease-store.test.ts`

**Interfaces:**
- Produces, in `db/schema.ts`:
  ```ts
  // machines gains:
  //   ageKey: text('age_key')                                                  the keeper's age public key, age1...
  //   keepsBackups: boolean('keeps_backups').notNull().default(true)           "Keep company backups"
  //   heldBackups: uuid('held_backups').array().notNull().default(sql`'{}'::uuid[]`)   what its keeper reported
  export const recoveryKeys = pgTable('recovery_keys', {
    id: id(),
    companyId: companyId(),
    recipient: text('recipient').notNull().unique(),       // age1...
    linkPrint: text('link_print'),                        // ruling 10; null: saved without a link
    linkName: text('link_name'),                          // the link's name and url then, for the manifest's
    linkUrl: text('link_url'),                            //   recoveryLink (ruling 4)
    madeBy: uuid('made_by').notNull().references(() => people.id),
    madeAt: createdAt(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  }).enableRLS();
  ```
- Produces, in `0053_net_backups.sql` (hand written; drizzle's schema does not describe `net`):
  ```sql
  CREATE TABLE net.backups (
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    dumped_at timestamptz NOT NULL,
    made_at timestamptz NOT NULL,
    reason text NOT NULL CHECK (reason IN ('timer', 'update')),
    size bigint NOT NULL CHECK (size > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    signer uuid NOT NULL,
    serial text NOT NULL,
    recovery text,
    recipients text[] NOT NULL,
    migrations integer NOT NULL,
    head text NOT NULL,
    holders uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX backups_made_at ON net.backups (made_at);
  CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.backups
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
  ```
  `head` is the bundle's head line as recorded (ruling 4), so a later check reads the same bytes.
- `HIDDEN` gains `'recovery_keys'`; `CLOSED`'s sentence adds "the recovery keys".

- [ ] **Step 1: Write failing tests.**
  - `migrations.test.ts`, `migration 0052 and 0053`, `adds backups, fenced and closed`: after migrating fully and
    `AFTER_MIGRATIONS`, `machines` has `age_key`, `keeps_backups` (default true) and `held_backups` (default `{}`);
    `recovery_keys` has `link_name` and `link_url`, a `net_journal` trigger and `relrowsecurity` true, and two rows with
    one `recipient` fail with `23505`; `net.backups` has `net_fence` (deferrable, initially deferred), and refuses the
    reason `fork`, a size of 0 and a `sha256` of `XYZ` with `23514`.
  - `lease-store.test.ts`, `names what keeps it from leading`: on the fixture `problems()` has no line about
    `net.backups`; after `DROP TRIGGER net_fence ON net.backups` it has `net.backups has no fence trigger`.
  - `orchestrator-control.test.ts`: the hidden-table cases gain `recovery_keys`; `stays out of the backups`: the
    orchestrator's `SELECT * FROM net.backups` fails with `42501`, and with a `recovery_keys` row and the role granted
    `SELECT, INSERT, UPDATE, DELETE` on it, as a grant builder before this plan would after a downgrade, `SELECT`
    returns no row and `INSERT` fails with `42501`; an `UPDATE machines SET keeps_backups = false` by the role fails.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts`, then `npx drizzle-kit generate --name backups`, then `npx drizzle-kit
  generate --custom --name net_backups` and its SQL, then `HIDDEN` and `CLOSED`. When the generated `0052` lacks
  `ENABLE ROW LEVEL SECURITY` for `recovery_keys`, the agent stops and reports.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the tables for backups: machines' age keys and holdings, recovery keys and
  net.backups".

### Task 2: The bundle, its store and each machine's age key

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 1 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/bundle.test.ts test/bundle-store.test.ts test/age-key.test.ts`
passes; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing; `git diff main -- package-lock.json` adds no
package entry (only `apps/server`'s dependency line).

**Files:**
- Create: `apps/server/src/modules/backups/bundle.ts`, `apps/server/src/modules/backups/store.ts`,
  `apps/server/src/modules/keeper/age-key.ts`
- Modify: `apps/server/package.json` (`"age-encryption": "0.3.1"`), `package-lock.json` (by `npm install
  age-encryption@0.3.1 --save-exact -w apps/server`)
- Test: `apps/server/test/bundle.test.ts`, `apps/server/test/bundle-store.test.ts`, `apps/server/test/age-key.test.ts`
  (new)

**Interfaces:**
- Consumes: `certFacts`, `issuedBy`, `makeAuthority`, `issueCertificate` (plan 5, the last two in tests), `MachineKey`,
  `HeldCertificate`.
- Produces:
  ```ts
  // modules/backups/bundle.ts
  export const BUNDLE_LINE = 'hornhoof-bundle v1';
  export const CONTENT_LINE = 'hornhoof-bundle-content v1';
  export const CHALLENGE_LINE = 'hornhoof-recovery-challenge v1';
  export const SIGNED_PREFIX = 'hornhoof-bundle-manifest v1\n';
  export const MAX_HEAD = 65_536;
  export const MAX_CHALLENGE = 1024;
  export type BundleReason = 'timer' | 'update';
  export type RecoveryLink = { name: string; url: string };
  export type Manifest = { v: 1; id: string; company: string; dumpedAt: string; madeAt: string; reason: BundleReason; size: number;
    sha256: string; recipients: string[]; recovery: string | null; recoveryLink: RecoveryLink | null; migrations: number;
    signer: string; serial: string };
  export type BundleSecrets = { HORNHOOF_SECRET: string; NODE_KEY: string; RELAY_URL: string };
  export type Refusal = 'format' | 'authority' | 'role' | 'time' | 'signature' | 'company' | 'size' | 'hash' | 'content' | 'key'
    | 'room' | 'idle';
  export class BundleRefused extends Error { constructor(readonly reason: Refusal, message: string); }
  //   every error the age library throws (which can quote a key) becomes a BundleRefused with a fixed message, no cause
  export function sealBundle(opts: { dump: Readable; id: string; company: string; dumpedAt: Date; now?: Date; reason: BundleReason;
    migrations: number; secrets: BundleSecrets; recipients: string[]; recovery: string | null;
    recoveryLink: RecoveryLink | null; key: MachineKey; held: HeldCertificate; out: string }): Promise<{ head: string; manifest: Manifest }>;
  //   writes the age part to `out` (0600) while hashing it, then signs the manifest with madeAt now(); recipients are made unique and
  //   sorted with the recovery key among them; throws on no recipient
  export function checkHead(head: string, want: { authorityPem: string; company: string | null }): Manifest;
  //   ruling 4's check of everything but size and hash; company null takes any; throws BundleRefused
  export function openBundle(age: Readable, manifest: Manifest, identities: string[]): Promise<{ secrets: BundleSecrets; dump: Readable }>;
  //   'key' when no identity opens it; 'content' when the first two lines are not ruling 4's or name another id or
  //   company; the dump streams on from the third line
  export function headLine(head: string): string;   // BUNDLE_LINE + '\n' + head + '\n', what precedes the age part
  export function readHead(input: Readable): Promise<{ head: string; rest: Readable }>;
  //   reads the two lines (the second at most MAX_HEAD bytes, else 'format') and hands the rest on unread
  export function makeChallenge(recipient: string, linkName: string): Promise<{ file: Uint8Array; nonce: string }>;
  //   plaintext CHALLENGE_LINE + '\n' + linkName + '\n' + 32 random bytes as base64url (43 characters), no armor
  export function answerChallenge(file: Uint8Array, identity: string, linkName: string): Promise<string | null>;
  //   null unless file.length <= MAX_CHALLENGE, it opens, and its plaintext is exactly the three lines with this name
  //   and a 43-character base64url nonce; the size is checked before anything is opened
  export function answerProof(nonce: string): string;
  //   base64url HMAC-SHA256 keyed by the nonce's bytes over 'hornhoof-recovery-answer'; what the server answers
  export function uploadProof(nonce: string, id: string): string;
  //   the same over 'hornhoof-recovery-upload\n' + id; what each bundle sent after the challenge carries
  // modules/backups/store.ts
  export type StoredBundle = { id: string; manifest: Manifest; head: string; size: number };
  export const IDLE_MS = 30_000;
  export class BundleStore {
    constructor(dir: string);                     // made 0700 when missing
    list(): StoredBundle[];                       // complete ones (both files), newest madeAt first
    has(id: string): boolean;
    open(id: string): { length: number; stream(): Readable } | null;   // headLine(head) followed by the age part
    ageFile(id: string): string;                  // the path of <id>.age
    take(input: Readable, check: (head: string) => Manifest,
      opts?: { id?: string; free?: () => number; idleMs?: number }): Promise<StoredBundle>;
    //   readHead, check (which throws); 'room' when free() (default statfs of the folder) is under 3 times the size;
    //   the age part into a temporary file of this take alone (<id>.<random>.part, opened 'wx', 0600) while counting
    //   and hashing; 'size' the moment it passes the manifest's size, 'idle' after idleMs (IDLE_MS) without a byte;
    //   then size and sha256 against the manifest ('size', 'hash'), then, under a lock per id held in the process,
    //   <id>.head and the rename, unless the id is published by then. A take of an id another take is writing waits
    //   for it; a bundle held already is kept and answered, and its file never written again. Any failure destroys the
    //   input, removes only this take's part and rethrows; an id given must be the manifest's ('format')
    verify(id: string): Promise<StoredBundle>;    // hashes the stored <id>.age again: 'size' or 'hash' when not the manifest's
    put(head: string, manifest: Manifest, ageFile: string): StoredBundle;   // a sealed one of this machine, by rename
    remove(id: string): void;
    keepOnly(ids: string[]): void;                // removes every complete bundle not named, and any .part no take has open
  }
  // modules/keeper/age-key.ts
  export const AGE_KEY_FILE = 'age.key';
  export function ageKey(dir: string): Promise<{ identity: string; recipient: string }>;
  //   as apps/node's nodeIdentity: reads <dir>/age.key, makes it (0600, written to a temp file and renamed) when it
  //   is missing or `identityToRecipient` refuses it (a checksum included); that refusal is caught, and neither the
  //   key nor the library's message is logged or rethrown
  ```
- Streams: `Readable.toWeb` and `Readable.fromWeb` around typage's `encrypt` and `decrypt` of a `ReadableStream`;
  nothing holds a whole dump in memory.

- [ ] **Step 1: Write failing tests**, each with an authority from `makeAuthority`, a `data` certificate and a
  `worker` certificate from `issueCertificate` for machine keys made in the test, and age keys from
  `generateX25519Identity`:
  - `bundle.test.ts`:
    - `seals, checks and opens a bundle`: a 3 MB random dump sealed to a data key and a recovery key; `checkHead` of
      the head gives the manifest (`v` 1, the id, company, reason, `migrations` 61, `signer`, `serial`, `recovery`,
      `recoveryLink` as given, `recipients` sorted with both); the age file's size and SHA-256 are the manifest's;
      `openBundle` with either identity gives the three secrets and the same bytes.
    - `never shows a key it cannot read`: an identity with one character changed, given to `openBundle` and
      `answerChallenge`, throws or answers null, and no message, stack or log line holds any 20 characters of it.
    - `a holder cannot open it`: `openBundle` with a third key, a worker's, throws `key`.
    - `refuses what it must not open`, each a `BundleRefused` with its reason: a head whose manifest text changed by one
      character (`signature`); a bundle signed with the worker certificate (`role`); one whose certificate is of another
      authority (`authority`); sealed with `now` an hour before the certificate's `notBefore` (`time`); `company`
      another (`company`); the second line of 70 000 bytes (`format`); the age part of bundle B under bundle A's head,
      read through `BundleStore.take` (`hash`), and an age part with A's sha and size whose content names B's id, opened
      (`content`).
    - `answers only its own challenge`: `makeChallenge` then `answerChallenge` with the identity and the name gives
      the nonce; with another name, null; with another identity, null; a file of 1025 bytes, null without opening (a
      spy on the decrypter is not called); a sealed bundle's age part offered as a challenge, null; a challenge
      file offered to `openBundle`, `content`; `answerProof(n)`, `uploadProof(n, a)` and `uploadProof(n, b)` are
      three different 43-character strings.
  - `bundle-store.test.ts`:
    - `keeps complete bundles only`: a `take` whose input ends half way leaves no file and `list()` empty; two taken
      bundles list newest first; `open(id).stream()` reads back exactly what was taken; `keepOnly([b])` leaves b;
      `take` of a bundle held already answers it and writes nothing.
    - `takes each bundle once, whole`: two takes of one id at once, the second with the same head and another age
      part that goes on writing after the first take has answered: the first resolves, the second rejects, `verify`
      of the id passes, and the stored file is the first's; an input that goes on past the signed size rejects `size`
      having read at most the size and 1 MiB; `free` 2.9 times the size rejects `room` before the age part is read;
      `idleMs` 100 and an input that stops rejects `idle`; `keepOnly([])` while a take is writing leaves its part;
      `verify` after one byte of a stored `.age` changed rejects `hash`.
  - `age-key.test.ts`: `makes the machine's age key once and keeps it`: mode 0600, the same recipient twice, a file
    of garbage replaced, and a key with one character changed replaced without anything thrown (a spy on
    `console.error` and `console.log` is never called).
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the dependency, then the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Add the backup bundle: sealed with age, signed by a data machine, checked before it opens".

### Task 3: The app's side: records, holders and the recovery file

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 2 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/backups-routes.test.ts test/holders.test.ts
test/recovery.test.ts test/network-routes.test.ts test/nodes.test.ts test/machine-load.test.ts` passes, then the
whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/backups/types.ts`, `apps/server/src/modules/backups/records.ts`,
  `apps/server/src/modules/backups/holders.ts`, `apps/server/src/modules/backups/recovery.ts`,
  `apps/server/src/modules/backups/routes.ts`
- Modify: `apps/server/src/app.ts` (the routes, the hourly look at holders while leading),
  `apps/server/src/modules/network/routes.ts` (the report's fields), `apps/server/src/modules/nodes/routes.ts`
  (`PATCH /api/machines/:id`, `GET /api/machines`), `apps/server/src/errors.ts`
- Test: `apps/server/test/backups-routes.test.ts`, `apps/server/test/holders.test.ts`,
  `apps/server/test/recovery.test.ts` (new), `apps/server/test/network-routes.test.ts`,
  `apps/server/test/nodes.test.ts`, `apps/server/test/machine-load.test.ts` (its PATCH answer, line 84, gains
  `keepsBackups`)

**Interfaces:**
- Consumes: Task 1's tables; `checkHead`, `Manifest`, `RecoveryLink`, `generateX25519Identity` and `identityToRecipient`
  (Task 2 and typage); `keeperAsker`, `findThisMachine`, `authorityOf`, `certFacts`, `onlineShare`, `linkOf`,
  `tunnelSettings`.
- Produces:
  ```ts
  // modules/backups/records.ts (raw SQL on net.backups through the Db's sql template)
  export type BackupRow = Manifest & { head: string; holders: string[] };
  export function recordBundle(tx: Db, row: BackupRow): Promise<boolean>;      // INSERT ... ON CONFLICT DO NOTHING
  export function bundleRows(db: Db, opts?: { limit?: number }): Promise<BackupRow[]>;   // newest made_at first
  export function bundleRow(db: Db, id: string): Promise<BackupRow | null>;
  export function setHolders(tx: Db, id: string, holders: string[]): Promise<void>;
  // modules/backups/holders.ts
  export const HOLDERS = 3;
  export function sameHome(a: string[], b: string[]): boolean;   // any two IPv4 addresses with the first three octets equal
  export function pickHolders(db: Db, opts: { size: number; keep: string[]; now?: Date }): Promise<string[]>;
  //   ruling 7, ranked home first (an address in the leader's /24), then onlineShare, then free disk: `keep` (the
  //   holders the bundle has) stay while each is live, ticked, of an active owner and reported within a day; the
  //   places left go to the best-ranked others, which also need a report within 2 minutes and the disk; at most
  //   HOLDERS. Then, when no pick is off site and an off-site machine qualifies, the best off-site one takes the
  //   place of the lowest-ranked pick, a kept one included
  export function refreshHolders(db: Db, now?: Date): Promise<void>;   // the newest 2 bundles with a recovery key
  // modules/backups/recovery.ts
  export const RECOVERY_KIND = 'hornhoof-recovery';
  export type RecoveryFile = { v: 1; kind: typeof RECOVERY_KIND; company: string; companyName: string; identity: string;
    recipient: string; madeAt: string; link: { url: string; name: string; key: string; tunnel: Record<string, unknown> } | null;
    authorityPem: string };
  export function linkPrint(link: { name: string; key: string } | null): string | null;   // sha256 hex of name + '\n' + key
  export function activeRecovery(db: Db, config: Config): Promise<{ id: string; recipient: string; madeAt: Date; madeBy: string;
    link: RecoveryLink | null } | null>;
  //   the newest unretired recovery_keys row whose link_print is linkPrint of the link now; null otherwise
  export function makeRecoveryFile(db: Db, config: Config, me: Person): Promise<{ name: string; text: string }>;
  //   in one transaction: a new pair, the row (with the link's print, name and url; retiring every older one), and
  //   the file's text: the comment line
  //   "# Hornhoof recovery file for <company name>. It opens every backup made for it: keep it like a password."
  //   and the JSON line; name 'hornhoof-recovery-<link name or company id's first 8>-<YYYY-MM-DD>.txt'
  export function parseRecoveryFile(text: string): RecoveryFile;
  //   the JSON line after any comment lines; identity AGE-SECRET-KEY-1..., recipient its identityToRecipient,
  //   authorityPem a CA certificate; throws ApiError(400, 'validation', 'This is not a Hornhoof recovery file.',
  //   'recovery_file_invalid'), with no cause, also when the age library refuses the identity
  // modules/backups/types.ts, the messages between keepers and the app, which keepers import too
  export type RestoreOrder = { attempt: string; id: string; dumpedAt: string; source: 'store' | 'incoming';
    identity: string | null; expect: { sha256: string; size: number; signer: string } | null; company: string;
    authorityPem: string; carry: boolean };
  //   attempt: a new uuid for each start, so the same bundle can be tried again; carry: false for a total loss
  export type RestoreStep = 'fetch' | 'check' | 'open' | 'load' | 'swap' | 'start';
  export type RestoreStatus = { attempt: string; id: string; state: 'running' | 'done' | 'failed'; step: RestoreStep;
    line: string; at: string; kept: string | null };
  //   `start` is written only once the swap is committed (ruling 13)
  export type MakerView = { company: string | null; recipients: string[];
    recovery: { id: string; recipient: string; link: RecoveryLink | null } | null;
    last: { id: string; madeAt: string; recovery: string | null } | null; holders: Record<string, string[]>;
    wanted: { id: string; from: string }[]; order: RestoreOrder | null };
  //   until Task 7, `order` is null and `wanted` empty
  export type HolderView = { keeps: boolean; hold: { id: string; size: number; sha256: string }[]; want: string[] };
  //   keeps: the asker's keeps_backups; false tells the holder to delete what it holds (ruling 9)
  export type Carry = {                         // what Task 4's carry.sql answers and Task 7 applies (ruling 14)
    people: { id: string; status: 'active' | 'invited' | 'disabled'; passwordHash: string | null; scopeKind: string;
      isOwner: boolean; access: { departmentId: string | null; teamId: string | null }[] }[];
    invites: string[];                          // token hashes of invites unused and unexpired
    machines: { id: string; revoked: boolean; lendsTests: boolean; keepsBackups: boolean }[];
    serials: string[];                          // revoked
    recoveryKeys: { id: string; recipient: string; linkPrint: string | null; linkName: string | null;
      linkUrl: string | null; madeBy: string; madeAt: string; retiredAt: string | null }[] };
  // modules/backups/routes.ts
  export function backupRoutes(app: FastifyInstance, ctx: Ctx): void;
  // errors.ts: ErrorReason gains 'recovery_file_invalid' | 'no_authority' | 'not_owner_session'
  ```
- Routes (the keeper's take `keeperAsker`, null being plan 5's 403 `not_keeper`):
  - `GET /api/network/backups`: own: `MakerView`, `company` the company or null before setup, `recipients` the
    `age_key`s of live rows of the role `data`, unique and sorted, `recovery` `activeRecovery`, `last` the newest row,
    `holders` each of the newest 2 rows with a recovery key mapped to its `holders`. Via a worker: `HolderView`,
    `keeps` its row's `keeps_backups`, `hold` those of the newest 2 rows with a recovery key whose `holders` name it.
    503 outside lead.
  - `POST /api/network/backups`, own only (a worker gets 403 `not_keeper`), body `{ head: string }` at most 64 KiB:
    `checkHead` with `authorityOf` and the company (a refusal is 400 with its reason and message), then the signer
    must be `findThisMachine`'s row, live, with the role `data`, and `serial` a `certificates` row of it that is not
    revoked (403 `forbidden` otherwise), `madeAt` within a day of now (400); then `recordBundle` with `pickHolders`
    when it has a recovery key; 201 `{ holders }`, 200 the same for a row there already. 503 outside lead.
  - `POST /api/network/report` (plan 5's, both askers) takes also `ageKey` (`/^age1[02-9ac-hj-np-z]{58}$/`) and
    `heldBackups` (at most 16 uuids; a keeper holding more reports its newest 16), written on the asker's row.
- People's routes, each `requirePerson`; the CEO is the person with `is_owner`, on his own session (`me.via` unset),
  else 403 `forbidden` 'Only the CEO does this, from his own session.' (`not_owner_session`):
  - `POST /api/backups/recovery`: while leading, with an authority (409 `conflict` 'The company has no certificate
    authority yet. Wait a minute and try again.' with `no_authority` otherwise); answers `{ name, text }` with
    `cache-control: no-store`; nothing of the identity is logged.
  - `GET /api/backups`: `{ last: string | null, recovery: { madeAt, madeBy: name } | null, recoveryNeeded: boolean,
    linkChanged: boolean, bundles: { id, dumpedAt, reason, size, recovery: 'current' | 'older' | 'none', where: {
    machine: string | null, name: string, online: boolean }[] }[] }` for the newest 10 rows; `where` lists the leader
    (machine null, name "this server") when its row's `held_backups` has it, and each other row that reports it;
    `linkChanged` is true when an unretired key exists whose print is not the link's. Task 7 adds restores to it.
- `PATCH /api/machines/:id` takes `{ lendsTests?: boolean, keepsBackups?: boolean }`, strict, at least one, with
  `ownMachine` as today, and answers both values. `GET /api/machines` gives `keepsBackups` and `heldBackups` (a count)
  on each machine with a core, null on the others.
- `app.ts`: every hour while the app leads, `refreshHolders`; a failure is one log line.

- [ ] **Step 1: Write failing tests.**
  - `holders.test.ts`, on rows the test writes with `network_id`, `role` `worker`, `addresses`, `disk_free`,
    `report_at` and `machine_online` days: `picks holders at home first, then by online share and disk`: with the
    leader on `192.0.2.10`, a home worker at 60% online beats two others at 99% and 98%, which follow in that order,
    and a fourth is left out; a worker with `keeps_backups` false, one with a disabled owner, one silent for 3 minutes,
    one with too little disk (2.9 times the size), a `data` row and a revoked row are never picked; `keep` holds a
    holder that still qualifies over a better newcomer; `refreshHolders` replaces one silent for a day.
    `keeps one place off site`: three qualifying home workers and one qualifying worker on `198.51.100.7` give two
    home picks and the off-site one; with no off-site worker, three home picks; with `keep` the three home workers
    and the off-site one qualifying, two of them stay and the off-site one takes the third place, while a kept
    off-site holder that still qualifies stays over an off-site newcomer.
  - `recovery.test.ts`: `makes a recovery file the app cannot open`: with a link (`saveLink`), the file's JSON has the
    identity, its recipient, the link's settings and the authority's PEM; `recovery_keys` has the recipient and no
    identity anywhere (the test searches every text column of the database for the identity's value); a second save
    retires the first and `activeRecovery` is the second, with the link's name and url; after a rename of the link
    (`saveLink` with another name and key) `activeRecovery` is null; `parseRecoveryFile` reads the file back and
    refuses a recipient that does not match its identity, and an identity with one character changed with the fixed
    message, whose `stack` and `cause` hold no 20 characters of the identity.
  - `backups-routes.test.ts`, on `testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID })` with a company set up
    and the own certificate taken as plan 5's tests take it:
    - `seals only to data machines`: with a worker row with an `age_key` and the server's row with another, the own
      `GET /api/network/backups` has exactly the server's in `recipients`; with a recovery key, `recovery` names it.
    - `records only its own data machine's bundle`: a head made by `sealBundle` with the server's key and certificate
      is recorded (201) and `bundleRow` has it; again, 200 and one row; a head signed by the worker's certificate is
      400 `role` even sent as own; the same head sent with the worker's via is 403 `not_keeper`; a head with `madeAt`
      two days old is 400; a head of another authority is 400 `authority`.
    - `hands each holder what it holds`: with a recovery key and two picked workers, each worker's `GET` (via with
      the keeper's mark) lists the bundle with its size and hash and `keeps` true, and a third worker's lists nothing;
      after a holder's `keeps_backups` goes false, its `keeps` is false; a bundle without a recovery key gets no
      holder; the own `GET`'s `recovery.link` is the link the key was saved with.
    - `gives the recovery file to the CEO alone`: the CEO's session gets the file; another whole-company person, the
      CEO through the orchestrator's token, and a request before the authority exists get 403, 403 and 409.
    - `lists the bundles with where they are`: `GET /api/backups` names this server and a holder that reported it,
      online or not, and `recoveryNeeded` true before a save and false after.
  - `network-routes.test.ts`, `stores the machine's age key and what it holds`: a report with `ageKey` and 16
    `heldBackups` sets both; `ageKey: 'age1short'` is 400, and so are 17 uuids.
  - `nodes.test.ts`: `ticks backups like test runs`: the owner and a whole-company person set `keepsBackups` false, a
    department's person gets 403, `{}` is 400, and `{ lendsTests: false }` still works as before.
  - `machine-load.test.ts`: its PATCH case expects `{ lendsTests: false, keepsBackups: true }`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Record bundles, pick their holders, and make the recovery file".

### Task 4: The updater: dumps for the keeper, and the swap of a restore

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 3 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/updater.test.ts test/compose.test.ts test/carry.test.ts` passes,
then the whole server suite; from the worktree root `npm run test:real` passes with Docker running; `bash -n` and
`shellcheck` on `apps/updater/updater.sh` print nothing.

**Files:**
- Create: `apps/updater/cutover.sql`, `apps/updater/carry.sql`, `apps/server/test/updater-stubs/chown` (records its
  arguments, then does nothing), `apps/server/test/carry.test.ts`, `apps/server/test/real/restore-swap.test.ts`
- Modify: `apps/updater/updater.sh` (it reads the SQL files from
  `${HORNHOOF_SQL_DIR:-/usr/local/share/hornhoof-updater}`, which the tests set to `apps/updater`),
  `apps/updater/Dockerfile` (both SQL files copied there), `compose.yaml` (the keeper's environment),
  `apps/server/test/updater-stubs/docker`
- Test: `apps/server/test/updater.test.ts`, `apps/server/test/compose.test.ts`, `apps/server/test/carry.test.ts`,
  `apps/server/test/real/restore-swap.test.ts`

**Interfaces:**
- The control folder, as this task writes and reads it (every id and attempt `[A-Za-z0-9-]` only, else ignored):
  ```text
  dump.json                  {id}                     written by the data keeper (Task 5); removed by the updater once
                                                      dumps/ has the id's .json or .failed, and by the keeper too
  dumps/                     0700, owned as the control folder is
  dumps/<id>.sql.gz          the dump, 0600, owned as the control folder is
  dumps/<id>.json            {id, reason, at, migrations}, 0600, likewise; written after the dump, so it says the
                             dump is whole
  dumps/<id>.failed          one line, 0600, likewise
  restore.json               {attempt, id, dumpedAt, carry}   written by the data keeper once the files below are
                                                      whole (Task 7)
  restore/<attempt>.sql.gz   the dump to restore, 0600; removed once loaded or failed
  restore/<attempt>.env.json {HORNHOOF_SECRET, NODE_KEY, RELAY_URL}, 0600; removed once written into .env or failed
  restore-status.json        RestoreStatus (Task 3): the keeper's steps fetch, check and open (Task 7), then this
                             task's load, swap and start
  restore-journal.json       {attempt, stamp, did}, the updater's alone, written whole before each change below
  restore-carry.json         {attempt, carry}, 0600, owned as the control folder is: what carry.sql gave (Task 7
                             applies and removes it)
  recovery-link.json         the total loss's link (Task 8); removed by a swap that is committed
  ```
- `cutover.sql`, run in one `psql -At -v ON_ERROR_STOP=1` session on the database to close, as three statements, each
  committed alone: a `DO` block that runs `ALTER DATABASE <current_database()> WITH ALLOW_CONNECTIONS false` through
  `format('%I')`; a `DO` block that calls `pg_terminate_backend` for every other session on it and looks again every
  0.2 s for at most 10 s, calling `pg_stat_clear_snapshot()` before each look (a transaction otherwise sees its
  first list again), and raises `sessions left` when one remains; then one line of JSON `{ term, machine, cluster }`:
  the highest `term_number` of `net_local.state` and `net_local.lease` (0 without either), and the state's `machine`
  and `cluster`. It names no database, so the real test runs it as the updater does.
- `carry.sql`, after `cutover.sql` in the same session when the order carries: one line of JSON, Task 7's `Carry`:
  ```text
  people        every person: id, status, passwordHash, scopeKind, isOwner, and access: their person_access rows'
                departmentId and teamId
  invites       the token hashes of invites unused and unexpired now
  machines      every machine: id, revoked (revoked_at set), lendsTests, keepsBackups
  serials       every revoked certificate's serial
  recoveryKeys  every recovery_keys row: id, recipient, linkPrint, linkName, linkUrl, madeBy, madeAt, retiredAt
  ```
- `updater.sh` gains, each with a comment in the file's voice:
  - `owned <path> <mode>`: `chmod` and `chown` to the control folder's owner and group (read with `ls -nd`, which
    BusyBox and macOS print alike).
  - `dump_request`: when `dump.json` names an id with `dumps/<id>.json` or `.failed`, it removes `dump.json` and stops;
    else, when `db` runs: `dumps/` made and `owned` 0700; `pg_dump | gzip` under umask 077 into
    `dumps/<id>.sql.gz.part`, `owned` 0600, `mv` into place, then `dumps/<id>.json` with `reason` `timer`, `at` the UTC
    time and `migrations` from `applied`, `owned` 0600, then `dump.json` removed; on a failure the part goes,
    `.failed` gets the reason (`owned` 0600) and `dump.json` is removed. No `db` (a worker): nothing.
  - After `backup()` succeeds in an update, a copy of `$BACKUP` into `dumps/<ID>.sql.gz` the same way with `reason`
    `update`; a failed copy is one `say` line and the update goes on.
  - `restore_request`: when no `restore-journal.json` exists, no `request.json` waits, `status.json` is not `running`,
    `restore.json` names an attempt that `restore-status.json` has not finished (`done` or `failed` for that attempt)
    and both files of `restore/<attempt>` exist: ruling 13 in these steps, each written to `restore-status.json`
    (`state` `running`, then whole and moved), each failure ending `failed` with its line, and `restore.json` removed
    once the status is final. The journal's `did` says the last change made; the way back from each is under
    `interrupted` below.
    1. `load`: `compose stop app node`; `hornhoof_restore` made and loaded as `restore()` loads; the dump file
       removed. A failure drops `hornhoof_restore`, starts `app` and `node`: "The backup did not load, so nothing
       changed."
    2. `swap`, with a UTC stamp:
       - The three secrets read from `env.json` with `jq`, each taken only as it can be written into `.env` as is:
         `HORNHOOF_SECRET` 44 characters of base64; `NODE_KEY` 32 to 200 of `[A-Za-z0-9+/=_-]`; `RELAY_URL`
         `^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$`; so no control character, space, quote, `#`
         or `$` passes. An empty one leaves its line as it is. Anything else: as a failed load, with "The backup's
         settings cannot be written, so nothing changed."
       - Journal `saved`, after `.env` copied to `backups/env-before-<stamp>` under umask 077.
       - `cutover.sql` (with `carry.sql` when `restore.json`'s `carry` is true) on `hornhoof`; its error: connections
         allowed again, as a failed load. Journal `closed`; the carry into `restore-carry.json` (0600, `owned`); then
         in `hornhoof_restore`, when `net_local.state` exists: its `machine` and `cluster` the cutover's, `term_number`
         `GREATEST(term_number, <term>)`, and `DELETE FROM net_local.lease`.
       - From `postgres`: `ALTER DATABASE hornhoof RENAME TO hornhoof_before_<stamp>`; journal `old_renamed`;
         `ALTER DATABASE hornhoof_restore RENAME TO hornhoof`; journal `new_renamed`.
       - `.env.new` under umask 077 with the three values over their lines (or added) and every other line as it was,
         given the old `.env`'s owner and group (`ls -n`) and mode 0600, then `mv`; `env.json` removed; journal
         `committed`.
    3. `start` (written only now, so a status at `start` means committed): `recovery-link.json` removed, then
       `compose up -d` of every service `config --services` names but `db` and `updater`, and `healthy` as an update
       waits, for the commit running now. It answers: `done`, `kept` `hornhoof_before_<stamp>`: "Restored the backup
       of <dumpedAt>. The database from before is kept on this machine as hornhoof_before_<stamp>."; the journal
       removed. It does not: the way back from `committed`, then `failed`: "The restored company did not start, so it
       is back as it was."
  - `interrupted` also reads `restore-journal.json` (an updater stopped during a restore) and goes back from its
    `did`, each way ending with `app` and `node` started, `restore-carry.json` and both files of `restore/<attempt>`
    removed, the journal removed, and `failed` "The updater stopped during the restore, so nothing changed.":
    - no journal and the status `running` at `load` or `swap`, or `saved`: `hornhoof_restore` dropped.
    - `closed`: connections on `hornhoof` allowed again, `hornhoof_restore` dropped.
    - `old_renamed`: `hornhoof_before_<stamp>` renamed back to `hornhoof`, its connections allowed, `hornhoof_restore`
      dropped.
    - `new_renamed`: `hornhoof` (the restored one) dropped, then as `old_renamed`, and `.env` put back from
      `backups/env-before-<stamp>` (it may have been written).
    - `committed`: the services started and `healthy` waited as in `start`: it answers, `done` as there; it does not,
      `hornhoof` dropped, `hornhoof_before_<stamp>` back with connections allowed, `.env` from the copy, then
      `failed` "The restored company did not start, so it is back as it was."
    Each way back can run again from its start (`IF EXISTS`, a rename only when its source exists and its target
    does not), so one that fails itself leaves the journal, says so in one `say` line, and is tried again at the next
    start.
- The loop and `--once` run `dump_request` and `restore_request` after `handle_request`.
- `compose.yaml`, the keeper's `environment` gains `HORNHOOF_NODE_KEY: ${NODE_KEY:-}` (the data keeper puts it into
  each bundle; plan 5b's config check refuses a `NODE_KEY` that is set but empty, so the keeper's name is another one,
  read only by Task 5's `secrets()`; a worker's `.env` has none, so it stays empty there) and `HORNHOOF_SURVIVOR_S:
  ${HORNHOOF_SURVIVOR_S:-}` (ruling 16; empty means 600).

- [ ] **Step 1: Write failing tests.**
  - `updater.test.ts`, the stub `docker` keeping its databases as files in `STUB_STATE` (`hornhoof`,
    `hornhoof_restore`, `hornhoof_before_*`, each with its `connections` flag), answering `cutover.sql` with
    `STUB_TERM` and `STUB_CARRY`, with `STUB_RESTORE=fail` failing a load, `STUB_CUTOVER=fail` the cutover and
    `STUB_RENAME=fail` the second rename; the stub `chown` first on the `PATH`:
    - `describe('updater, backups')`:
      - `dumps for the keeper, whole or not at all`: a `dump.json` with an id gives `dumps/<id>.sql.gz` with the dump,
        then `<id>.json` with `reason` `timer` and the stub's migrations, both 0600, `dumps/` 0700, `chown` called
        with the control folder's owner for each, and `dump.json` gone; run again, it dumps nothing; with `pg_dump`
        failing (`STUB_DUMP=fail`), no `.sql.gz`, a `.part` gone, a `.failed` and `dump.json` gone; a `dump.json`
        whose id already has a `.json` is removed with no dump; an id `../x` is ignored.
      - `hands the dump before an update to the keeper too`: an update as `downloads every image of the new build...`
        runs leaves `dumps/<request id>.sql.gz` with the same bytes as `backups/hornhoof-*.sql.gz` and `reason`
        `update`; with the `dumps` folder not writable the update still finishes.
    - `describe('updater, restore')`:
      - `swaps a restored database in and keeps the old one`: the restored database is the dump's,
        `hornhoof_before_*` exists with connections off, the log has the cutover before the first rename, the
        restored state has `STUB_TERM`, `.env` has the three new values and every other line as it was, mode 0600,
        `backups/env-before-*` holds the old `.env` with mode 0600, `restore-carry.json` holds `STUB_CARRY` with mode
        0600, `restore-status.json` is `done` naming the kept database, and the files of `restore/`,
        `restore-journal.json` and `recovery-link.json` are gone.
      - `takes no carry for a total loss`: `restore.json` with `carry` false runs only `cutover.sql` and writes no
        `restore-carry.json`.
      - `changes nothing when the backup does not load`: with `STUB_RESTORE=fail`, `hornhoof` is the old one, no
        `hornhoof_restore` is left, `.env` is unchanged, `app` and `node` were started again, the status is `failed`
        with the load's line, and the plaintext files are gone. The same with `STUB_CUTOVER=fail`, and `hornhoof`'s
        connections are on.
      - `puts the old database back when the restored one does not answer`: with the health stub never answering, the
        old database is `hornhoof` again with connections on, `.env` is the old one, the status says it is back as it
        was.
      - `refuses secrets it cannot write`: an `env.json` whose `NODE_KEY` holds a newline, one whose `RELAY_URL`
        holds a carriage return, and one whose `RELAY_URL` is `https://a.hornhoof.test/$NODE_KEY` each fail at `swap`
        before `.env` changes, and the old database is back.
      - `goes back from every change it was stopped at`: for each `did` of `saved`, `closed`, `old_renamed`,
        `new_renamed`, a journal and the databases as that change left them: `interrupted` leaves the old database as
        `hornhoof` with connections on, no `hornhoof_restore`, the old `.env`, `app` and `node` started, no journal,
        and `failed`.
      - `keeps a committed restore that answers`: a journal at `committed` and the status `running` at `start` with
        the health stub answering: `interrupted` writes `done` and keeps the restored `hornhoof`; with it never
        answering, the old one is back and `failed`.
      - `runs each restore once`: a second loop with the same `restore.json` and a finished status does nothing; a
        `restore.json` with a new attempt for the same bundle runs.
  - `carry.test.ts`, `takes the carry when the old database closes`: on `createTestSql` with a company, a disabled
    person, a person with a department's access, an open invite and a used one, a revoked machine with its revoked
    certificate, and two recovery keys, one retired, `carry.sql` (read from `apps/updater`) answers one line that
    parses as Task 3's `Carry` and names each as it is.
  - `restore-swap.test.ts` (real Postgres, two `realDatabase()`s migrated by `migrateDb`, the old one with a client
    that reconnects every 100 ms): `cutover.sql` run on the old one answers its term, machine and cluster, leaves no
    other session there, and the client's reconnects are refused; `ALTER DATABASE ... RENAME` of it then succeeds
    from `postgres`; once the restored one takes the old one's name, the client's next connect lands in it.
  - `compose.test.ts`: the keeper's exact environment keys gain `HORNHOOF_NODE_KEY` (`${NODE_KEY:-}`) and
    `HORNHOOF_SURVIVOR_S` (`${HORNHOOF_SURVIVOR_S:-}`), and it has no `NODE_KEY` key.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the two SQL files, then `updater.sh`, the `Dockerfile`, the stubs and `compose.yaml`.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the updater dump for the keeper and swap a restored database in, keeping the old one".

### Task 5: The data keeper makes bundles and serves them

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 4 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/keeper-backups.test.ts test/peer-server.test.ts
test/keeper.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/backups.ts`
- Modify: `apps/server/src/net/peer-server.ts` (the backups streams), `apps/server/src/modules/keeper/keeper.ts` (the
  backup keeper, the report's fields)
- Test: `apps/server/test/keeper-backups.test.ts` (new), `apps/server/test/peer-server.test.ts`,
  `apps/server/test/keeper.test.ts`

**Interfaces:**
- Consumes: `sealBundle`, `checkHead`, `BundleStore`, `ageKey` (Task 2); `MakerView` and the routes of Task 3; the
  control folder of Task 4; `MachineKey`, `HeldCertificate`, `PeerServer`, `Peer` (plan 5).
- Produces:
  ```ts
  // modules/keeper/backups.ts
  export const BUNDLE_EVERY_MS = 6 * 3_600_000;
  export const DUMP_GAP_MS = 600_000;          // at most one dump asked for per 10 minutes
  export const DUMP_LIFE_MS = 86_400_000;      // a dump not sealed within a day is deleted
  export const KEEP_OWN = 2;
  export const BUNDLES_DIR = 'bundles';        // in the keeper's volume
  export type Ask = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  export type PeerBackups = {
    get(peer: Peer, id: string): { status: 200; length: number; stream(): Readable } | { status: 403 | 404 };
    put(peer: Peer, id: string, body: Readable): Promise<201 | 400 | 403>;
  };
  export class BackupKeeper {
    constructor(opts: { dir: string; controlDir: string; key: MachineKey; held: () => HeldCertificate | null;
      age: { identity: string; recipient: string }; secrets: () => BundleSecrets; ask: Ask; leads: () => boolean;
      log: (line: string) => void; now?: () => Date; everyMs?: number });
    //   everyMs 10_000
    start(): void; stop(): void;
    round(): Promise<void>;          // one look, for tests
    view(): MakerView | null;        // the last answer of GET /api/network/backups
    store(): BundleStore;            // <dir>/bundles
    held(): string[];                // the ids of store().list()
    peer(): PeerBackups;
  }
  // net/peer-server.ts
  // PEER_PATHS gains backups: '/peer/backups/'; PeerServerOptions gains backups?: PeerBackups
  ```
- A round:
  1. Every file of `dumps/` older than `DUMP_LIFE_MS` goes, with one log line; this runs first in every round,
     whether it leads, its app answers or its keys are ready.
  2. Only while `leads()`: `GET /api/network/backups` as own; a non-200 keeps the last view and ends the round. Steps
     3 and 4 need a view with a company and `held()` a `data` certificate; a fresh server in a total loss has neither,
     and still reads its order (Task 7).
  3. A dump is due (ruling 5) when the view has a company and: `last` is null; or `now - last.madeAt >=
     BUNDLE_EVERY_MS`; or `recovery` is set and `recovery.recipient` is not `last.recovery`. It is asked for, by
     `dump.json` `{ id: <new uuid> }` written whole and then moved, when no `dump.json` is there, no `dumps/<id>.json`
     waits to be sealed, and either the last was asked `DUMP_GAP_MS` ago or more, or the due is a recovery key it has
     not asked a dump for yet (remembered in memory, so once per key).
  4. Each `dumps/<id>.json` with its `.sql.gz`: `dump.json` removed when it names that id; a dump whose id the store
     holds is deleted unsealed; else `sealBundle` with the dump, `dumpedAt` its `at`, its `reason` and `migrations`,
     `secrets()`, the view's `recipients` with its own `age.recipient` added, the view's `recovery` and its `link` as
     `recoveryLink`, its key and certificate, into the store's folder; then `POST /api/network/backups` `{ head }`; on
     200 or 201 the dump and its `.json` are deleted; any other answer keeps them for the next round. A `.failed` is
     one log line, then deleted with `dump.json` when it names that id.
  5. `keepOnly`: the `KEEP_OWN` newest, every id in the view's `holders`, and the order's id (Task 7).
- `secrets()` in `keeper.ts`: `HORNHOOF_SECRET` `config.secret.toString('base64')`, `NODE_KEY`
  `process.env.HORNHOOF_NODE_KEY ?? ''` (Task 4's compose name), `RELAY_URL` `config.relayUrl`. `ask` is the keeper's
  own request to its app with `x-hornhoof-via: keeper` (10 s).
- `peer()`: `get` is 200 only when the view's `holders[id]` names `peer.machine` and the store holds it, 404 when the
  store does not, 403 otherwise; `put` is Task 7's and answers 403 until the view's `wanted` names that id from that
  machine, 201 at once without reading the body when the store holds it already, else `store().take(body, head =>
  checkHead(head, { authorityPem: held().authorityPem, company: view().company }), { id })`, with ruling 4's bounds:
  201, or 400 when it throws, the request destroyed at once.
- `PeerServer`: `GET /peer/backups/<uuid>` answers `get`'s status, with `content-length` and the stream for 200; `PUT
  /peer/backups/<uuid>` passes the request stream to `put` and answers its status; on both listeners; any other path
  under it 404; without `backups`, 404 as before.
- `keeper.ts`: with a machine id, `ageKey(dir)` (a failure is logged and tried again each minute, as `machineKey`),
  a `BackupKeeper`, its `peer()` given to the `PeerServer`; the report gains `ageKey` and `heldBackups` (the newest
  16 of `held()`), and a report answered 400 is sent again at once without both (ruling 18).

- [ ] **Step 1: Write failing tests.**
  - `keeper-backups.test.ts`, a `BackupKeeper` with an `ask` into a `testApp` (the own certificate taken first) and
    the test playing the updater (it answers each `dump.json` with a small gzip dump and its `.json`), `now`
    injected:
    - `makes a bundle at once, then every 6 hours`: the first round writes `dump.json`; after the test's dump, the
      next round leaves one bundle in the store, its row in `net.backups`, and nothing in `dumps/` and no `dump.json`;
      at 5 hours no new `dump.json`, at 6 hours one.
    - `asks for one dump at a time`: over ten rounds in which the test, as the updater, answers each `dump.json` and
      then leaves it in place (an updater stopped before removing it), each id is sealed once, no id is dumped twice,
      and no new `dump.json` is written while one is there or a dump waits.
    - `makes one soon after a new recovery file`: one minute after a bundle, `POST /api/backups/recovery`; the next
      round asks for a dump though the 10 minutes are not over; its bundle's `recovery` is the new recipient, its
      `recoveryLink` the link, and it has holders when a worker qualifies; a second save at once asks for no other
      dump until the 10 minutes are over.
    - `leaves no plaintext dump`: with the app answering 503 to the record, the dump stays; at `DUMP_LIFE_MS` and
      a minute it is gone and a line is logged, also with the app answering nothing and with `leads()` false; a
      sealed dump never survives its round; a dump whose id the store holds is deleted unsealed.
    - `puts the node key in the bundle`: with `HORNHOOF_NODE_KEY` set, the opened bundle's `NODE_KEY` is it; unset or
      empty, `''`.
    - `keeps its latest two and what holders still fetch`: with four bundles, the two newest and one the view's
      `holders` names stay.
    - `makes nothing while it does not lead`: with `leads()` false, no `dump.json`.
  - `peer-server.test.ts`, `serves a bundle only to its holders`: a `PeerServer` with a `BackupKeeper`'s `peer()`
    whose view names worker A for bundle X: A's client gets X's bytes (the same SHA-256 as `open(X)`), worker B gets
    403, an unknown id 404, `PUT` 403; the same on the `app` listener. With the view's `wanted` naming X from worker
    A, A's `PUT` of a body longer than X's signed size is 400 having read at most the size and 1 MiB.
  - `keeper.test.ts`, `reports its age key and what it holds`: within 3 s the server's row has `age_key` and
    `held_backups`; `reports again without the new fields when its app refuses them`: an app double answering 400 to
    a body with `ageKey` gets a second report without it.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let the data keeper seal, sign and record each dump, and serve bundles to their holders".

### Task 6: Holders: a worker's keeper pulls and keeps bundles

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 5 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/holder.test.ts test/peer-link.test.ts test/worker-keeper.test.ts`
passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/keeper/holder.ts`
- Modify: `apps/server/src/net/peer-link.ts` (`stream`), `apps/server/src/modules/keeper/worker.ts` (the age key, the
  holder, the report's fields)
- Test: `apps/server/test/holder.test.ts` (new), `apps/server/test/peer-link.test.ts`,
  `apps/server/test/worker-keeper.test.ts`

**Interfaces:**
- Consumes: `checkHead`, `BundleStore`, `ageKey` (Task 2); `HolderView` (Task 3); the backups streams (Task 5);
  `PeerLink`, `WorkerKeeper` (plan 5b).
- Produces:
  ```ts
  // net/peer-link.ts, PeerLink gains:
  stream(method: 'GET' | 'PUT', path: string, body?: Readable): Promise<{ status: number; length: number | null; body: Readable }>;
  //   an HTTP/2 stream of its own on the leader's session (not CONNECT app); rejects without a leader; a stream that
  //   moves no byte for 30 s is destroyed with an error
  // modules/keeper/holder.ts
  export const HOLD_EVERY_MS = 60_000;
  export const ROOM = 3;                         // free disk at least 3 times the bundle
  export class HolderKeeper {
    constructor(opts: { dir: string; link: Pick<PeerLink, 'leader' | 'request' | 'stream'>; held: () => HeldCertificate | null;
      log: (line: string) => void; diskFree?: () => number; everyMs?: number });
    //   diskFree statfs(dir) as Measures reads it
    start(): void; stop(): void;
    round(): Promise<void>;
    held(): string[];
    store(): BundleStore;                        // <dir>/bundles
  }
  ```
- A round, only while `link.leader()` names one and `held()` gives a certificate: `request('GET',
  '/api/network/backups')`; only a 200 with a `HolderView` goes on (a 404 from an older app, a failure, anything else:
  nothing changes). With `keeps` false, `keepOnly([])` and nothing else. For each `hold` entry the store lacks, newest
  first: with `diskFree() >= ROOM * size`, `stream('GET', '/peer/backups/<id>')`, and `store().take(body, head =>
  checkHead(head, { authorityPem: held().authorityPem, company: null }), { id, free: diskFree })`, then its SHA-256
  and size must be the entry's, else it is removed; short of room, one log line. Then, only when `hold` is not empty
  and every entry is held complete, each held bundle not named and older (`madeAt`) than the newest entry is
  removed; an empty `hold`, or one with any entry missing, removes nothing (ruling 9). For each `want` id it holds,
  `stream('PUT', '/peer/backups/<id>', store().open(id).stream())`.
- `worker.ts`: `ageKey(dir)`, a `HolderKeeper` on its `PeerLink`, started with it; the report gains `ageKey` and
  `heldBackups` (the newest 16 of `held()`), with Task 5's fallback on 400.

- [ ] **Step 1: Write failing tests.**
  - `holder.test.ts`, a `HolderKeeper` on a fake link whose `request` answers a `HolderView` the test sets and whose
    `stream` serves bundles the test sealed with a test authority's `data` certificate:
    - `holds what its leader names`: two entries give two bundles in the store and in `held()`.
    - `deletes only after the new ones are complete`: holding A and B, an answer naming B and C whose stream for C
      ends half way keeps A and B and leaves no part; the next round, whole, leaves B and C.
    - `keeps its bundles without an answer`: no leader, a `request` that throws, a 404 and a 503 each delete nothing.
    - `keeps its bundles through an empty answer`: holding A and B, an answer with `keeps` true and `hold: []` (a
      restored database before its first bundle) deletes nothing; an answer naming only C, older than both, which it
      fetches, deletes nothing; an answer naming D, newer, deletes A and B once D is complete; `keeps` false deletes
      everything.
    - `fetches only with room`: with `diskFree` 2.9 times the size, nothing is fetched and one line is logged.
    - `refuses a bundle it cannot trust`: a stream with a bundle signed by a `worker` certificate, and one whose
      SHA-256 is not the entry's, leave nothing in the store.
    - `sends what its leader wants`: `want: [A]` gives one `PUT` whose body is A's file exactly.
  - `peer-link.test.ts`, `streams a bundle over the leader's session`: against a `PeerServer` with a backups handler,
    `stream('GET', ...)` reads 5 MB back whole and `stream('PUT', ...)` delivers 5 MB; without a leader it rejects.
  - `worker-keeper.test.ts`, `reports its age key and the bundles it holds`: the worker's row gets `age_key` and,
    after a holder round, `held_backups`; `keeps its bundles behind an older leader`: against an app double that
    answers 404 to `GET /api/network/backups` and 400 to a report with `ageKey` (a leader an Update took back), the
    holder deletes nothing and the report is sent again without the new fields.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Let workers pull the company's bundles, check them and keep the latest two".

### Task 7: Restore from a backup, on the leader

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 6 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/restore.test.ts test/keeper-restore.test.ts
test/backups-routes.test.ts test/keeper.test.ts test/updates.test.ts` passes, then the whole server suite; `npx tsc
-p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/src/modules/backups/restore.ts`, `apps/server/src/modules/keeper/restore.ts`
- Modify: `apps/server/src/modules/backups/routes.ts`, `apps/server/src/modules/keeper/backups.ts` (the order, the
  holder's upload), `apps/server/src/modules/keeper/keeper.ts`, `apps/server/src/modules/keeper/updater-status.ts`
  (`updaterBusy`), `apps/server/src/modules/updates/control.ts` (the claim), `apps/server/src/modules/updates/routes.ts`
  (no update during a restore), `apps/server/src/modules/people/routes.ts` (`disablePerson`), `apps/server/src/app.ts`
  (the carry at first lead), `apps/server/src/errors.ts`
- Test: `apps/server/test/restore.test.ts`, `apps/server/test/keeper-restore.test.ts` (new),
  `apps/server/test/backups-routes.test.ts`, `apps/server/test/keeper.test.ts`, `apps/server/test/updates.test.ts`

**Interfaces:**
- Consumes: `bundleRow`, `parseRecoveryFile`, `activeRecovery`, `MakerView`, `RestoreOrder`, `RestoreStatus`, `Carry`
  (Task 3); `checkHead`, `openBundle`, `BundleStore` (Task 2); the control folder of Task 4; `BackupKeeper` (Task 5);
  `disconnectMachines`, `certificates`, `sessions`, `invites`, `person_access`, `machine_access` and `computer_runs`
  (plan 6), `MIGRATIONS`.
- Produces:
  ```ts
  // modules/backups/restore.ts
  export const ORDER_MS = 3_600_000;
  export const RESTORE_STATUS = 'restore-status.json';
  export const RESTORE_CARRY = 'restore-carry.json';
  export function knownMigrations(): number;                 // the entries of MIGRATIONS/meta/_journal.json
  export function readRestoreStatus(controlDir: string): RestoreStatus | null;
  export function applyCarry(ctx: Ctx, carry: Carry): Promise<void>;
  //   ruling 14, one pass, each part only for rows this database has:
  //   - each person: a person disabled in the carry and not here through disablePerson; else status, password_hash,
  //     scope_kind and is_owner set as the carry's, and person_access replaced by the carry's rows whose department
  //     or team this database has;
  //   - every unused invite whose token hash `invites` does not name deleted;
  //   - each machine: revoked in the carry and live here through disconnectMachines; lends_tests and keeps_backups
  //     set as the carry's;
  //   - each serial not revoked here gets revoked_at now;
  //   - recovery_keys: the carry's rows written by id (made_by the company's owner when that person is not here),
  //     every other row retired now;
  //   - computer access closed on every machine (machine_access's until, grant, opened_by, opened_at, asked_reason
  //     and asked_at null) and every computer_runs row `waiting` or `sent` made `lost`;
  //   - then every session deleted.
  // modules/people/routes.ts: the steps PATCH /api/people/:id takes to disable a person (status, sessions, their
  //   machines disconnected, their plans released) move into one function that both call; the actor of
  //   releasePlansOf is the company's owner when no person acts
  export function disablePerson(ctx: Ctx, personId: string, by?: Person): Promise<void>;
  export function warningOf(db: Db, dumpedAt: Date): Promise<{ machines: { name: string; owner: string }[]; people: string[] }>;
  //   live machines with a network id created after dumpedAt; people created after it
  export class Restores {
    constructor(ctx: Ctx);
    start(me: Person, id: string, recoveryText?: string): Promise<string>;   // the claim, the checks below, the order;
                                                                             // answers the attempt
    order(): RestoreOrder | null;                 // the order younger than ORDER_MS whose attempt's status is not
                                                  // done or failed; when it ends, the claim is freed
    wanted(): { id: string; from: string }[];     // the holder asked to send it, while the leader lacks it
    status(): RestoreStatus | null;
    afterSwap(): Promise<void>;                   // at first lead, below
  }
  // modules/updates/control.ts, UpdaterControl gains (ruling 12):
  claim(kind: 'update' | 'restore', id: string): 'update' | 'restore' | null;
  //   synchronous. It claims for this id and answers null when nothing is claimed, no request.json waits, status() is
  //   not running and restore-status.json is not running at load, swap or start; else it answers what holds the
  //   updater ('restore' for those restore steps) and changes nothing
  free(id: string): void;                         // frees the claim when it is this id's
  claimed(): { kind: 'update' | 'restore'; id: string } | null;
  // modules/keeper/restore.ts
  export const FETCH_WAIT_MS = 1_800_000;
  export class RestoreRunner {
    constructor(opts: { controlDir: string; own: BundleStore; incoming: BundleStore; identity: string;
      log: (line: string) => void; diskFree?: (dir: string) => number; fetchWaitMs?: number; now?: () => Date });
    take(order: RestoreOrder | null): void;       // starts one run per attempt; a run in progress goes on
  }
  // errors.ts: ErrorReason gains 'restore_busy' | 'newer_build' | 'not_held' | 'needs_recovery_file' | 'restore_running'
  ```
- `Restores.start`, the CEO on his own session as in Task 3, each failure a 409 `conflict` with its reason and line
  unless said. First, before any `await`, `ctx.updater.claim('restore', <new attempt>)`: taken by an update or a
  restore (waiting, queued or running), `restore_busy`, 'A restore or an update is running.'; every failure after
  frees it. Then: the app leads; the row (404 `not_found`); its `migrations` at most `knownMigrations()`
  (`newer_build`, 'This backup was made by a newer Hornhoof. Update first.'); held by this server's row or by a row
  that reported it within 2 minutes (`not_held`, 'No machine that is online holds this backup now.'); this server's
  `age_key` among its `recipients`, or a recovery file given that `parseRecoveryFile` reads and whose `recipient` is
  the row's `recovery` and `company` this one (`needs_recovery_file`, 'This server cannot open this backup. Add the
  recovery file it was made for.'). Then it keeps the order in memory: the attempt, `source` `store`, `identity` the
  file's or null, `expect` the row's hash, size and signer, the company, the authority's PEM and `carry` true.
  `wanted` names the holder with the newest report while this server's row does not hold the bundle.
- `POST /api/updates` claims `update` before its first `await` (409 `restore_running` 'A restore is running.' when a
  restore holds it, `update_running` as today when an update does); a request called off or failing frees it, and
  `send` frees it once `request.json` is written, from when the updater's own status guards it.
- Routes: `GET /api/backups` gains `restore: RestoreStatus | null`, `kept: { name: string; at: string }[]` (the
  databases named `hornhoof_before_%` in `pg_database`, `at` read from the stamp), and on each bundle `restorable:
  boolean` and `why: 'newer_build' | 'not_held' | 'needs_recovery_file' | null`; `GET /api/backups/:id/warning`
  answers `warningOf`; `POST /api/backups/:id/restore` `{ recoveryFile?: string }` (at most 16 KiB) answers 202 `{
  attempt }` after `start`. `GET /api/network/backups` (own) carries `order` and `wanted`.
- `BackupKeeper` hands each view's `order` to a `RestoreRunner` (`own` its store, `incoming` the store of
  `/control/restore/incoming`, `identity` its age identity), keeps the order's bundle, and takes a `PUT` the view's
  `wanted` names (Task 5's `peer().put`). The order's `identity` stays in memory only: the keeper and the runner drop
  it when the order ends or is called off, and never write it into `/control/restore`, a status or a log line; no log
  line of the keeper holds a view or an order. The app logs neither the request nor the answer of `GET
  /api/network/backups` (the route turns Fastify's request logging off, and logs no body).
- `RestoreRunner`, writing `restore-status.json` (whole, then moved) at each step, with the order's attempt: `fetch`
  until the bundle is in `own` (or `incoming` for that source), at most `fetchWaitMs` ('No machine sent the
  backup.'); `check`: `checkHead` with the order's authority and company, the order's `expect` when it has one, and
  `verify(id)` of the stored file ('This backup does not match what the company recorded.'); `open`: with
  `diskFree(controlDir)` at least 3 times the bundle ('Not enough free disk for the restore.'), `openBundle` with its
  identity and the order's, the dump streamed to `restore/<attempt>.sql.gz.part` (0600) and moved, the secrets to
  `restore/<attempt>.env.json` (0600), then `restore.json` `{ attempt, id, dumpedAt, carry }`; a refusal `key` gives
  'This server cannot open the backup. Add the recovery file it was made for.' A failure removes what it wrote; the
  updater takes over from `restore.json` (Task 4). Before each step, and each second of `fetch`, a run whose attempt
  the latest view's order no longer names (an app restarted, an order expired) stops, removes what it wrote and writes
  `failed`, 'The restore was called off.', so no `restore.json` follows an order the app let go. When a runner starts
  (a keeper start), it removes every file of
  `restore/` but `incoming/` that `restore.json` does not name, and a status `running` at `fetch`, `check` or `open`
  without `restore.json` for its attempt is written `failed`, 'The keeper restarted during the restore.', so the
  order can be given again; the app counts a status `running` at those steps as running only while it holds that
  order.
- `updaterBusy` is also true while `restore-status.json` says `running` at `load`, `swap` or `start`.
- `afterSwap`: when `restore-status.json` names an attempt at `start` (running) or `done`, and `restore-carry.json`
  names the same attempt, `applyCarry` and then the file removed; a carry of another attempt, or with the status
  `failed`, is removed unapplied; no carry file, nothing. `app.ts`: at the app's first lead after its start,
  `restores.afterSwap()`; until it has run without an error, every `/api/` route but `/api/health` answers 503 as
  outside lead, so neither a person nor a keeper is served by the restored database before ruling 14 holds (the data
  keeper keeps its last revocation list meanwhile, plan 5); a failure is one log line and is tried again every 10 s.

- [ ] **Step 1: Write failing tests.**
  - `restore.test.ts`, on a `testApp` with the own certificate, a recorded bundle (Task 5's way) and the control
    folder a temp folder:
    - `restores only a bundle its database knows`: the CEO's restore of a recorded bundle answers 202 with an
      attempt, the own `GET /api/network/backups` carries the order with that attempt, `carry` true and `expect` the
      row's hash; an unknown id is 404; a bundle with `migrations` one more than `knownMigrations()` is
      `newer_build`; one held by no online machine `not_held`; one sealed without this server's key
      `needs_recovery_file`, then 202 with the right recovery file and 409 with another company's file; a second
      restore while the first is out is `restore_busy`; another person, and the CEO through the orchestrator's token,
      get 403.
    - `tries a bundle again`: after a `failed` status for the first attempt, a second restore of the same bundle
      answers a new attempt and the order carries it.
    - `keeps who may get in now`: a `Carry` with a person disabled, a person whose password and scope changed, a
      person's department access gone, an invite unused here but absent from it, a machine revoked with its serial,
      and recovery keys where the one this database holds as active is retired and another active; on a database
      where all of it is as before, `applyCarry` disables the first person (their sessions gone, their machines
      disconnected), sets the second's hash and scope, removes the access, deletes the invite, disconnects the machine
      and revokes the serial, leaves the carry's recovery key as `activeRecovery`, closes computer access on a machine
      with an open grant, makes a `waiting` computer command `lost`, and leaves no session.
    - `applies the carry only after a committed swap`: a status `running` at `start` or `done` for the attempt applies
      and removes the carry file; a `failed` one, or a carry of another attempt, removes it and changes nothing; until
      `afterSwap` has run, `GET /api/people` is 503 and `/api/health` answers.
    - `names what the restore undoes`: `warningOf` lists a machine and a person made after `dumpedAt`, not those
      before.
  - `updates.test.ts`, `one restore or update at a time`: with an order out, `POST /api/updates` is 409
    `restore_running`; with an update waiting for idle, and with a `request.json` the updater has not taken, a
    restore is `restore_busy`; an update and a restore asked in the same tick: exactly one is taken; once the order's
    status is `failed`, an update is taken again.
  - `keeper-restore.test.ts`, a `RestoreRunner` on temp folders with bundles sealed by a test authority:
    - `opens a bundle into the control folder`: the order's bundle in `own` gives `restore/<attempt>.sql.gz` equal to
      the dump, `<attempt>.env.json` with the three secrets, both 0600, then `restore.json` with the attempt and
      `carry`; the status went `check`, `open`.
    - `opens with the recovery file it was handed`: a bundle sealed only to a recovery key opens with the order's
      identity, and without it fails with the recovery line.
    - `keeps the recovery identity in memory only`: after a run that opened with a recovery file, no file of the
      control folder and no line its `log` was given holds any 20 characters of the identity.
    - `refuses a bundle that does not match the record`: an `expect` with another hash fails at `check`, and so does
      a stored `.age` with one byte changed under a matching `expect`; nothing is in `restore/`.
    - `waits for a holder, then gives up`: with `fetchWaitMs` 200 and no bundle, `failed` with 'No machine sent the
      backup.'; a bundle put into `own` within the wait goes on.
    - `needs room to open`: `diskFree` 2.9 times the bundle fails before anything is written.
    - `stops when its order is gone`: `take(null)` while it waits at `fetch` gives `failed` 'The restore was called
      off.' and no `restore.json`.
    - `leaves nothing open after a restart`: a `.sql.gz.part`, a whole `.sql.gz` and an `.env.json` of an attempt
      with no `restore.json`, and a status `running` at `open`: a new runner removes the three files and writes
      `failed`; with `restore.json` naming that attempt, it leaves them for the updater.
  - `keeper.test.ts`, `shows maintenance during the swap`: `restore-status.json` `running` at `swap` makes the front
    door answer plan 2's maintenance page, and at `open` it does not.
  - `backups-routes.test.ts`, `asks the holder for a bundle the leader lacks`: an order for a bundle only a worker
    holds puts it in `wanted`, and that worker's `GET` has it in `want`; `hands the identity over without logging
    it`: with an order from a recovery file, the own `GET /api/network/backups` carries the identity, and the app's
    log (a `testApp` with its logger written to a stream the test reads) holds no 20 characters of it.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Restore the company from a backup on the leader, keeping the database it replaces".

### Task 8: Total loss: restore from a recovery file, the challenge and survivors

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 7 committed. **Done when:** from `apps/server`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/total-loss.test.ts test/holder.test.ts test/keeper-link.test.ts
test/setup.test.ts` passes, then the whole server suite; `npx tsc -p apps/server/tsconfig.json --noEmit` prints
nothing.

**Files:**
- Create: `apps/server/src/modules/backups/total-loss.ts`
- Modify: `apps/server/src/modules/backups/routes.ts`, `apps/server/src/modules/backups/restore.ts` (an order from
  the total loss), `apps/server/src/modules/setup/routes.ts` (`GET /api/setup`'s `recovering`),
  `apps/server/src/modules/keeper/keeper.ts` (the link's settings from `recovery-link.json`),
  `apps/server/src/modules/keeper/holder.ts` (survivors), `apps/server/src/modules/keeper/worker.ts`,
  `apps/server/src/modules/keeper/worker-config.ts` (`survivorMs`), `apps/server/src/app.ts`,
  `apps/server/src/errors.ts`
- Test: `apps/server/test/total-loss.test.ts` (new), `apps/server/test/holder.test.ts`,
  `apps/server/test/keeper-link.test.ts`, `apps/server/test/setup.test.ts`

**Interfaces:**
- Consumes: `parseRecoveryFile`, `RecoveryFile` (Task 3); `answerChallenge`, `makeChallenge`, `answerProof`,
  `uploadProof`, `checkHead`, `BundleStore`, `IDLE_MS` (Task 2); `RestoreOrder` (Task 3); `Restores` (Task 7);
  `setupNeeded`, `isSetupCode`; the keeper's link child and `TunnelSettings` (plans 1b and 2); `WorkerView` (plan 5b).
- Produces:
  ```ts
  // modules/backups/total-loss.ts
  export const RECOVERY_LINK = 'recovery-link.json';   // in the control folder, 0600
  export const NONCE_MS = 3_600_000;
  export const UPLOADS_AT_ONCE = 2;
  export class TotalLoss {
    constructor(ctx: Ctx, now?: () => Date);
    begin(file: RecoveryFile): void;            // in memory only; writes RECOVERY_LINK when the file has a link
    active(): RecoveryFile | null;              // null once a company exists
    challenge(body: Uint8Array): Promise<string | null>;
    //   answerChallenge with the file; on a nonce, answerProof(nonce). Each nonce is kept with the time it was first
    //   answered, for NONCE_MS from then: a challenge sent again answers the same proof and does not extend it
    takes(id: string, proof: string): boolean;  // proof is uploadProof(n, id) of a kept, unexpired nonce n
    incoming(): BundleStore;                    // /control/restore/incoming
    view(): { company: string; link: string | null; bundles: { id: string; dumpedAt: string; reason: string; size: number;
      from: string }[]; restore: RestoreStatus | null };
    restore(id: string): void;                  // Restores.startIncoming with the file and the id
  }
  // modules/backups/restore.ts, Restores gains:
  //   startIncoming(file: RecoveryFile, id: string): string   the claim as in start, then an order with a new
  //   attempt, source 'incoming', the file's identity, company and authorityPem, no `expect`, and `carry` false
  // modules/keeper/worker-config.ts, WorkerConfig gains:
  //   survivorMs: number   HORNHOOF_SURVIVOR_S * 1000 when it is a whole number from 10 to 3600, else SURVIVOR_MS
  // modules/keeper/holder.ts, HolderKeeper gains:
  //   opts.survivor?: { view: () => WorkerView | null; joinServer: string; fetch?: typeof fetch; afterMs?: number;
  //     idleMs?: number }
  //   afterMs the config's survivorMs; it challenges every afterMs / 2; idleMs IDLE_MS
  export const SURVIVOR_MS = 600_000;
  export const SENT_FOR_MS = 3_000_000;          // a target that answered is challenged again after 50 minutes
  // errors.ts: ErrorReason gains 'challenge_refused' | 'bundle_refused' | 'have_it' | 'not_recovering'
  ```
- Routes, none of them with a session; every one answers 404 `not_found` with the reason `not_recovering` once a
  company exists, and while no file was given (but the first):
  - `POST /api/recovery` `{ code, file }` (the file's text, at most 16 KiB): `setupOnly(code)`, `parseRecoveryFile`,
    `begin`; answers `view()`. Again with another file replaces the first and drops what it took.
  - `GET /api/recovery?code=` answers `view()`.
  - `POST /api/recovery/challenge`, `application/octet-stream`, at most 1024 bytes (Fastify's `bodyLimit` for the
    route, so a larger body is 413 before anything reads it), at most 30 a minute per address: 200 `{ proof }`, or
    400 `challenge_refused`.
  - `PUT /api/recovery/bundles/:id`, `application/octet-stream` streamed (the route's own parser hands the request
    stream on, so Fastify's body limit does not apply and `take`'s bounds do), with `x-hornhoof-recovery:
    <uploadProof>` that `takes(id, proof)` accepts, or `?code=`: 403 without either, before the body is read; 429
    while `UPLOADS_AT_ONCE` uploads run; else into `incoming()` with `checkHead(head, { authorityPem:
    file.authorityPem, company: file.company })` and the manifest's `recovery` the file's `recipient`, and `{ id }`
    (else 400 `bundle_refused` with the reason, the request destroyed at once); 201, or 409 `have_it` for a bundle
    held already.
  - `POST /api/recovery/restore` `{ code, id }`: a bundle in `incoming()`, else 404; 409 `restore_busy` as Task 7's
    claim; answers 202. The keeper takes the order through its own `GET /api/network/backups` as in Task 7 (`company`
    the file's, `authorityPem` the file's); the updater swaps without a carry.
- `GET /api/setup` gains `recovering: boolean`.
- The data keeper's link child: when `tunnelSettings(db, config)` answers null and `/control/recovery-link.json`
  reads as `TunnelSettings`, those with `mode` `http`; anything else as before.
- A survivor's round, in its own timer, only while the store holds a bundle with a `recovery` and `link.leader()` has
  been null for `afterMs` (counted from the keeper's start too). It works for the newest held bundle's recovery key
  `R` and that bundle's manifest's `recoveryLink` `L`. Targets, in order and without repeats: `L.url` when it is
  https, the view's `link.url` when it is https, `joinServer`, and `http://<address>:<webPort>` of each data machine
  in the view. For each target:
  - one it sent to for `R` within `SENT_FOR_MS`: `PUT` only the bundles of `R` it has not sent there yet, with that
    nonce's proofs;
  - else `makeChallenge(R, L?.name ?? '')` and `POST <target>/api/recovery/challenge` (10 s); a 200 whose `proof` is
    `answerProof` of the nonce it made: `PUT <target>/api/recovery/bundles/<id>` with `x-hornhoof-recovery:
    uploadProof(nonce, id)` for every held bundle of `R`, newest first (a 201 or 409 counts as sent), and the target
    is remembered for `R` with the nonce and what it sent; anything else, the next target.
  Each `PUT` streams the bundle's file (`fetch` with `duplex: 'half'`) under an `AbortController` that aborts when no
  byte has moved for `IDLE_MS`; an aborted or refused one ends that target for the round, and the next is tried. Each
  challenge is one log line, `survivor: <target origin> answered|refused|unreachable`, never a nonce or a proof.
- `TotalLoss.challenge` checks against the file's `link.name`, or the empty name when the file has no link.

- [ ] **Step 1: Write failing tests.**
  - `total-loss.test.ts`, on a fresh `testApp` (no company) with a recovery file made by Task 3's function on another
    app, and bundles of that company sealed by a test authority, that file's:
    - `begins with the setup code alone`: a wrong code is 403 and changes nothing; the right one answers the view and
      writes `recovery-link.json` (0600) with the file's link; the identity is in no file of the control folder.
    - `answers only its own challenge`: `makeChallenge` to the file's recipient with its link name gives `{ proof }`
      equal to `answerProof` of its nonce, and the answer holds no nonce; another link name, another recipient, a
      1025-byte body (413), a sealed bundle's age part, and garbage are each refused; the 31st challenge in a minute
      from one address is 429.
    - `takes only bundles of its recovery key`: with a fresh proof, a bundle of the file's key is 201 and listed with
      its time; again, 409 `have_it`; without a proof, with the proof of a nonce 61 minutes old, or with another
      one, 403; a bundle of another recovery key, one signed by a worker, one of another company, 400
      `bundle_refused`; a body longer than its signed size is 400 having read at most the size and 1 MiB; a third
      upload while two run is 429; a bundle with the setup code instead of a proof is 201.
    - `gives the relay nothing to reuse`: a proxy in front of the app records a challenge, its answer and one
      upload; replaying the recorded upload's header for another bundle's id is 403; replaying the challenge 59
      minutes later answers the same proof, and at 61 minutes after the first answer the recorded header is 403.
    - `restores through the keeper`: `POST /api/recovery/restore` puts an order with `source` `incoming`, `carry`
      false and the file's identity into the own `GET /api/network/backups`.
    - `keeps the recovery file in memory only`: after `begin`, no table and no file of the control folder holds the
      identity.
    - `closes once a company exists`: after `POST /api/setup`, every recovery route is 404 `not_recovering` and
      `recovery-link.json` is removed.
  - `holder.test.ts`, survivors, on a fake link without a leader and a fake `fetch`:
    - `waits for its leader before it challenges`: before `afterMs`, no request; after it, a challenge to the
      manifest's `recoveryLink.url` first, carrying its name, also when the view's link has another name or none.
    - `sends its bundles to whoever answers the challenge`: a target that answers the right proof gets each bundle of
      that recovery key once, newest first, each with its own upload proof; a second round sends nothing more to it
      and does not challenge it; a bundle held after that is sent in the next round without a new challenge; one log
      line per challenge, holding no nonce or proof.
    - `sends nothing to a target that cannot answer`: a target answering another proof, a 404, or a timeout gets no
      bundle, and the next target is tried.
    - `goes on when a send stalls`: a target that answers the challenge and then reads nothing of the `PUT` is cut
      after `idleMs` (100 in the test) and the next target gets the bundles.
  - `keeper-link.test.ts`, `runs the link from the recovery file while the database has none`: with no
    `public_links` row and the file there, the link child is started with its settings in `http` mode; with a row,
    the row's.
  - `setup.test.ts`: `GET /api/setup` answers `recovering` false, then true after `POST /api/recovery`.
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Restore a lost company from the recovery file, with bundles its surviving machines send".

### Task 9: The screens and the texts

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 8 committed. **Done when:** from `apps/web`,
`VITEST_MAX_WORKERS=2 nice -n 10 npx vitest run test/Settings.test.tsx test/Backups.test.tsx test/Setup.test.tsx
test/Machines.test.tsx test/Shell.test.tsx test/i18n.test.tsx` passes, then the whole suite from the root; `npx tsc
-p apps/web/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/web/src/screens/Backups.tsx`, `apps/web/src/screens/RestoreFromFile.tsx`, `guide/backups.md`
- Modify: `apps/web/src/screens/Settings.tsx`, `apps/web/src/screens/Setup.tsx`, `apps/web/src/screens/Machines.tsx`,
  `apps/web/src/screens/Shell.tsx` (the banner), `apps/web/src/api.ts`, `apps/web/src/types.ts`,
  `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/ru.ts`, `SECURITY.md`, `README.md`, `guide/README.md`
- Test: `apps/web/test/Backups.test.tsx` (new), `apps/web/test/Settings.test.tsx`, `apps/web/test/Setup.test.tsx`,
  `apps/web/test/Machines.test.tsx`, `apps/web/test/Shell.test.tsx`

**Interfaces:**
- Consumes: the routes of Tasks 3, 7 and 8.
- Produces: `Backups({ me })` (the part of Settings), `RestoreFromFile({ code })` (the setup screen's restore), the
  banner `RecoveryBanner({ me, onOpen })`; `api.ts` gains `backups()`, `saveRecovery()`, `backupWarning(id)`,
  `restoreBackup(id, recoveryFile?)`, `setMachine(id, { lendsTests?, keepsBackups? })`, and the recovery routes.
- Copy, EN / RU, exactly:
  - The menu item and the dialog's title: "Settings" / «Настройки».
  - The part's title: "Backups" / «Резервные копии»; "The last backup: <time>." / «Последняя копия: <time>.»; "No
    backup yet." / «Копий пока нет.»; over 12 hours old: "The last backup is older than 12 hours. Check that this
    server has free disk." / «Последней копии больше 12 часов. Проверьте, что на этом сервере есть свободное место.»
  - "Save the recovery file" / «Сохранить файл восстановления»; "Saved on <date> by <name>." / «Сохранен <date>,
    <name>.»; "Not saved yet. Without it the company cannot be restored if this server is lost." / «Еще не сохранен.
    Без него компанию не восстановить, если этот сервер пропадет.»; after a save: "Saved. Keep it like a password: it
    opens every backup made for it. Older recovery files open only backups made before <time>." / «Сохранен. Храните
    его как пароль: он открывает все копии, сделанные для него. Старые файлы восстановления открывают только копии,
    сделанные до <time>.»
  - Above the bundles: "Restore from a backup" / «Восстановить из копии». Each bundle: its time, "every 6 hours" /
    «каждые 6 часов» or "before an update" / «перед обновлением», its size, "Held by: <names>" / «Хранят: <names>»
    ("this server" / «этот сервер»; an offline one with "(offline)" / «(не в сети)»), "Not for the current recovery
    file" / «Не для текущего файла восстановления» when `recovery` is `older`, and "Restore" / «Восстановить» when
    `restorable` or `why` is `needs_recovery_file` (its warning then asks for the file), with the line of `why` when
    there is one: "Made by a newer Hornhoof. Update first." / «Сделана более новой версией
    Hornhoof. Сначала обновите.», "No machine that holds it is online." / «Ни одна машина, где она хранится, не в
    сети.», "Add the recovery file it was made for to restore it." / «Чтобы восстановить ее, добавьте файл
    восстановления, для которого она сделана.»
  - The warning: "Restore the company as it was at <time>?" / «Восстановить компанию такой, какой она была в
    <time>?»; "Everything after <time> stays in the current database, which is kept on this server. A later update
    of Hornhoof merges it back." / «Все, что было после <time>, останется в текущей базе, она сохранится на этом
    сервере. Позднее обновление Hornhoof вернет эти данные.»; "These machines joined later and must be connected
    again: <names>." / «Эти машины подключены позже, их нужно будет подключить снова: <names>.»; "These people were
    added later and must be invited again: <names>." / «Этих людей добавили позже, их нужно будет пригласить
    снова: <names>.»; "Everyone signs in again afterwards." / «После этого все войдут заново.»; "Access to machines
    is closed on every machine; their owners open it again." / «Доступ к машинам закроется на всех машинах, их
    владельцы откроют его снова.»; a file input "Recovery file" / «Файл восстановления» when `why` is
    `needs_recovery_file`, the warning's Restore off until a file is chosen; "Restore" / «Восстановить» and "Cancel"
    / «Отмена».
  - Progress, one line per step: "Getting the backup", "Checking it", "Opening it", "Loading it into a new database",
    "Switching databases", "Starting the company" / «Получаем копию», «Проверяем ее», «Открываем ее», «Загружаем ее
    в новую базу», «Переключаем базы», «Запускаем компанию»; then the status's `line` as the server wrote it.
  - Kept databases: "The database from before the restore of <time> is kept on this server." / «База, которая была
    до восстановления <time>, сохранена на этом сервере.»
  - The banner, for the CEO while `recoveryNeeded`: "Save the recovery file, so the company can be restored if this
    server is lost." / «Сохраните файл восстановления, чтобы компанию можно было восстановить, если этот сервер
    пропадет.»; with `linkChanged`: "The public link changed, so the recovery file is out of date. Save a new one." /
    «Публичная ссылка изменилась, и файл восстановления устарел. Сохраните новый.»; the button "Open Settings" /
    «Открыть настройки».
  - The card, on a machine with a core: "Keep company backups" / «Хранить резервные копии компании»; read only:
    "Keeps company backups" / «Хранит резервные копии компании» or "Keeps no company backups" / «Не хранит резервные
    копии компании»; "Backups held: <n>" / «Хранит копий: <n>».
  - The setup screen: "Restore from a recovery file" / «Восстановить из файла восстановления»; "Choose the recovery
    file you saved in Settings." / «Выберите файл восстановления, который вы сохранили в настройках.»; waiting:
    "Waiting for backups. Machines of the company that are still on send theirs within about 15 minutes." / «Ждем
    резервные копии. Машины компании, которые еще работают, пришлют их примерно за 15 минут.»; "Or upload a backup
    file" / «Или загрузите файл копии»; each bundle with "Restore this one" / «Восстановить эту»; done: "Restored.
    Sign in as before. If a plan was signed in on a lost machine, sign it in again under Subscriptions on a machine
    that is on." / «Восстановлено. Войдите, как раньше. Если вход в тариф был на пропавшей машине, войдите в него
    снова в разделе «Подписки» на работающей машине.»
- `Settings` shows its link part as today and `Backups` below it for the person with `isOwner` (the server refuses
  anyone else);
  the account menu item keeps opening it for people who see the whole company. The recovery file is saved by a `Blob`
  and an `<a download>` with the answer's `name`; its text is never kept in state after that.
- `RestoreFromFile` reads the chosen file as text and posts it, polls `GET /api/recovery` every 5 s, uploads a chosen
  bundle file with `fetch(PUT, body: file)` and the code, and after the restore polls `GET /api/setup` until
  `needed` is false, then shows the done line and the sign-in link.
- Texts: `SECURITY.md`'s backup line becomes "Every 6 hours and before each update, the leading machine makes a
  backup, signs it and encrypts it. Up to three other company machines keep the latest two and cannot open them. Only
  the machines that hold the data, and the recovery file the CEO saves in Settings, can. A restore checks that a
  machine holding the data signed the backup. The copy saved before an update also stays on the server unencrypted,
  as the server holds the database anyway. A machine's owner can untick "Keep company backups"." `README.md`'s
  sentence "only the machines that may hold the data" becomes "only the machines that hold the data". `guide/backups.md`
  (linked from `guide/README.md` as "[Backups](backups.md): what is saved and where, the recovery file, and how to
  restore the company, also after losing its server."): what a bundle holds, who keeps it, the recovery file and the
  banner, restoring from Settings and what the warning means, a total loss from the setup screen, and that every step
  is a click.

- [ ] **Step 1: Write failing tests**, with `api-mock.ts`:
  - `Backups.test.tsx`: `saves the recovery file`: the button posts and makes one download named as answered, then
    shows the saved line; `restores after the warning`: Restore opens the warning with the machines and people named,
    Cancel posts nothing, Restore posts and shows the progress lines from the status; `asks for the recovery file when
    it must`: from the closed list, a bundle with `needs_recovery_file` shows its line and Restore, whose warning has
    the file input and a Restore that is off until a file is chosen, then posts the file's text; a `newer_build`
    bundle has no Restore and shows its line.
  - `Settings.test.tsx`: the title is "Settings"; the CEO sees Backups, a whole-company person does not.
  - `Shell.test.tsx`: the banner shows for the CEO while `recoveryNeeded`, the link-changed line with `linkChanged`,
    nothing for others, and its button opens Settings.
  - `Machines.test.tsx`: `ticks backups like test runs`: on a machine with a core the owner's tick sends
    `keepsBackups: false`; a department's person sees the read-only line; a machine without a core shows neither.
  - `Setup.test.tsx`: `restores from a recovery file`: the link opens the file step, the file's text is posted with
    the code, a received bundle's button posts the restore, and `needed: false` shows the done line.
  - `i18n.test.tsx` passes with every new key in both files and no "ё", "компьютер" or "узел".
- [ ] **Step 2: Run** Done when. Expected: FAIL.
- [ ] **Step 3: Implement** the screens, then the texts.
- [ ] **Step 4: Run Done when.** Expected: PASS.
- [ ] **Step 5: Commit** "Show backups in Settings, ask for the recovery file, and restore a lost company from the
  setup screen".

### Task 10: The lab: a holder, a restore and a total loss

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Task 9 committed. **Done when:** from the worktree
root `npm run test:lab` passes (both scenarios); `npx tsc -p apps/server/tsconfig.json --noEmit` prints nothing.

**Files:**
- Create: `apps/server/test/lab/steps.ts`, `apps/server/test/lab/backups.test.ts`
- Modify: `apps/server/test/lab/lab.ts` (`remove`, `add`), `apps/server/test/lab/join.test.ts` (its first steps from
  `steps.ts`)

**Interfaces:**
- `lab.ts`: `Lab` gains `remove(i: number): Promise<void>` (that machine's container and volumes gone, its address
  free) and `add(opts?: { ip?: string }): Promise<LabMachine>` (a new machine on the lab's network, at that address
  when given, the three images loaded as `start` loads them).
- `steps.ts`, from `join.test.ts`'s steps 1 to 3: `installServer(m, opts?: { env?: Record<string, string> })`,
  `setUp(m)` (answers the owner's session and password), `joinWorker(server, m, owner)`; `join.test.ts` uses them and
  checks what it checked.
- `backups.test.ts`, one scenario, 30 minutes at most:
  1. m1 a server, set up; m2 a worker joined; m2's `.env` gets `HORNHOOF_SURVIVOR_S=40` and its keeper is started
     again (`docker compose up -d keeper` in its folder).
  2. Within 3 minutes m1's `net.backups` has a row with `recovery` null, and m2's `held_backups` is empty; m1's
     `/control/dumps` is empty, mode 0700 and owned by the keeper's user (the updater, root, made it), and
     `dump.json` is gone.
  3. The owner's `POST /api/backups/recovery`; within 3 minutes a row whose `recovery` is the file's recipient, m2's
     `held_backups` names it, and m2's keeper volume has its `.age` and `.head`. Copied out of m2, the bundle does not
     open with m2's `age.key` (`key`) and opens with the file's identity, its `HORNHOOF_SECRET` being m1's.
  4. After that bundle, a department made and the owner's password changed; the owner's restore of it (`POST
     /api/backups/<id>/restore`): within 4 minutes `/api/health` answers, `restore-status.json` is `done`, the owner
     signs in again with the new password and not the old one, the department is gone, `pg_database` has one
     `hornhoof_before_*`, no `restore-carry.json` or file of `restore/` is left, within 2 minutes m2's `/api/keeper`
     names a leader, m2's keeper volume still has the bundle's files, and within 3 minutes more m2 holds a newer
     bundle of the same recovery key, made from the restored company.
  5. Total loss: `remove(1)`, then `add({ ip: <m1's address> })` as m3 and `installServer` there with a fresh `.env` and
     the same `PUBLIC_URL`. Before any file: m3's `GET /api/recovery` is 404 and, after 90 s, m3's
     `/control/restore/incoming` is empty while m2's keeper log has a line `survivor: <m3's origin> refused` (a machine
     without the file gets nothing). Then `POST /api/recovery` with m3's setup code and the file: within 2 minutes `GET
     /api/recovery` lists the bundle from m2; `POST /api/recovery/restore`: within 6 minutes `GET /api/setup` says
     `needed` false, the owner signs in with the password of step 4, `GET /api/machines` lists m2, the only live
     `server:` row has m3's network id, and within 3 minutes m2's `/api/keeper` names a leader on `direct`.

- [ ] **Step 1: Write the failing test** `backups.test.ts` and `steps.ts`; `npm run test:lab` fails at its step 2.
- [ ] **Step 2: Implement** `lab.ts`'s `remove` and `add` until both scenarios pass. A step that fails for a reason of
  the product, not the lab, is reported as a finding with the failing step, never worked around in the lab.
- [ ] **Step 3: Check the disk, then run Done when,** as plan 5b's Task 9 Step 3, counting four machines' images.
  Expected: PASS.
- [ ] **Step 4: Commit** "Add the lab's backups scenario: a holder, a restore, and a total loss restored from a
  surviving worker".

### Task 11: Run everything, review, rehearse, ship by Update, merge

**Repo:** Hornhoof worktree, branch `backups`. **Starts from:** Tasks 1 to 10 committed and reviewed. **Done when:**
Steps 1 and 2 pass for the agent; Steps 3 to 7 are the team lead's, never an agent's, and Step 6's Updates and clicks
are Ivan's.

- [ ] **Step 1: Run every test.** From the worktree root: `VITEST_MAX_WORKERS=2 nice -n 10 npm test --
  --testTimeout=90000 > <ws>/full.log 2>&1; tail -30 <ws>/full.log` → all pass; `npm run test:real` and `npm run
  test:lab` (after the disk check of Task 10 Step 3) → pass; the `tsc` commands → no output; `bash -n` and
  `shellcheck` on `apps/updater/updater.sh` → no output.
- [ ] **Step 2: Check the public-repo rule.** As plan 5b's Task 10 Step 2; also no recovery file, `age.key` or
  bundle anywhere in the tree (`git ls-files | grep -E 'recovery|\.age$|age\.key'` lists only source files).
- [ ] **Step 3: Review.** The team lead reads the branch against spec 3.8, sections 10 and 12, the overview's plan 7
  entry and this plan's rulings, with Ivan's two rules and Review Focus first, and plan 1's Caddy and relay settings
  for a limit on a request body's size or time below a bundle's (ruling 17 e), which stops the merge until a plan
  lifts it; the CLI agent that did not write a task reviews it
  too; one fix pass, each fix with its failing test first.
- [ ] **Step 4: Rehearse** (team lead), on the team lead's stand on Ivan's Mac, as in plan 6: the disk first; then the
  current release (plan 6's) as `install.sh server --name rehearsal`, the DinD worker `hh-rehearsal-m2` joined with
  the real command, and two branch builds, B1 from Task 8's commit and B2 from the head. In this order:
  1. Forward to B1 by Update: it ends `done`; within 2 minutes `net.backups` has a row with `recovery` null and the
     stand's `/control/dumps` is empty; the worker follows to B1.
  2. Forward to B2: the update's own bundle (`reason` `update`) is in `net.backups`; the banner shows to the stand's
     CEO; "Save the recovery file" in Settings downloads the file; within 3 minutes a row with its recipient, which
     the worker holds (`held_backups`, the files in its keeper's volume).
  3. A department made, then "Restore" on that bundle in Settings: the warning names nothing joined after it; within
     4 minutes the company is back, the department gone, the CEO signed out and in again, `hornhoof_before_*` listed
     in Settings, and the worker on `direct` again.
  4. Back to the release (plan 6's) by Update: it ends `done` and works on the restored database, and the worker's
     bundles stay in its keeper's volume; forward again to B2: bundles go on and the worker holds them.
  Then remove the worker, `docker compose down -v` in `~/hornhoof-rehearsal` only, that folder and its registry line.
  The total loss is the lab's (Task 10), never the stand's. Any step that fails: stop and report, and Ivan is not
  asked to update.
- [ ] **Step 5: Merge** (team lead): the merge commit into main with exactly this subject (no double quote):
  ```text
  Back up the company encrypted to other machines, and restore it from Settings or a recovery file
  ```
  Then `git push origin main`, and wait for CI green, `test-real` included, and the new images.
- [ ] **Step 6: Ivan updates, the team lead checks.** As plan 6's Task 7 Step 6: Ivan presses Update on his own
  companies himself; the team lead never runs an install, an update, a restore or a `request.json` on them. After
  each, reading only: the release's commit in `/api/health`; within 10 minutes a `net.backups` row; the banner in
  Ivan's browser. Saving the recovery file is Ivan's click in Settings, and the team lead tells him where it is and
  to keep the file like a password; after it, within a few minutes, a row with its recipient, held by his workers that
  keep backups. No step asks Ivan to type a command. When a check fails, or the Update does not end within 20 minutes,
  the team lead tells Ivan which release to go back to and how, in Versions.
- [ ] **Step 7: Close the worktree** (team lead): `git worktree remove .claude/worktrees/backups` and `git branch -d
  backups` once main has the merge.

## Addendum: ruling 17 e, and who lifts a limit on a bundle's way through the relay

Ruling 17 e) and Task 11's Step 3 have the review read plan 1's Caddy and relay settings for a body limit or timeout
below a bundle's size, and "stop the merge until a plan lifts it", with no plan named. Read now, at the relay repo as
it stands, there is none: `Caddyfile` has no `request_body` and no `read_body` (`Caddyfile:72-81` is the whole way to
a company); `relay/frps.toml` has `vhostHTTPTimeout = 60`, frp's wait for an answer's headers, which starts once the
request is written; `relay/relay.py`'s `MAX_BODY = 4096` (`:48`, `:1116`) guards the relay's own API, not a company's
traffic. Plan 2's doors have `requestTimeout: 0` (p2:514), and the route's own parser takes the stream (p7:1306). A
reading is no proof, and plan 1 still changes this path (frps on 443, Caddy behind it), so the proof is one test
against the real Caddy and frps. This task owns the lift: if that test ever fails, its fix goes here, first in the
relay repo's settings, and David AI deploys it with the series' relay work (plan 13's Task 14). Task 11's "a plan"
means this task.

### Task A1: A bundle's size and time through the relay

**Repo:** relay repo, branch `main`. **Starts from:** plan 1's Task 9 committed. **Done when:** `python3 -m unittest
relay/test/test_big_body.py -v` passes on Python 3.12 and 3.14, then `python3 -m unittest discover -s relay/test -v`.

**Files (relay repo):**
- Create: `relay/test/test_big_body.py`
- Modify, only if the test finds a limit: `Caddyfile`, `relay/frps.toml`

**Interfaces:**
- Consumes: plan 1's `Stack(tmp, caddy=True)`, `Stack.client(..., via='caddy')`, the public https port and its test
  CA.
- The way a survivor's `PUT` goes while a recovering machine's link is in `http` mode (ruling 15): frps on 443, the
  edge client, Caddy, frps's vhost port, the company's frpc.

- [ ] **Step 1: Write the tests**:
  - `test_long_upload_reaches_the_company`, on `Stack(tmp, caddy=True)` with a client in http mode holding `acme`,
    whose local port is a backend of the test's that reads a request's whole body as it comes, hashes it and answers
    201 with its size and SHA-256: over TLS to the public port with the name `acme.hornhoof.org`, a chunked `PUT` of
    314572800 bytes (300 MiB) in chunks of 1 MiB, paced to last at least 70 s, so past `vhostHTTPTimeout`: the answer
    is 201, its size and hash are what was sent, and at least 65 s passed.
  - `test_no_body_limit_is_set`: the repo's `Caddyfile` holds none of `request_body`, `max_size`, `read_body`;
    `relay/frps.toml`'s `vhostHTTPTimeout` is at least 60.
- [ ] **Step 2: Run** `python3 -m unittest relay/test/test_big_body.py -v`. It pins what is there, so expect PASS.
  Watch it fail once: add `request_body { max_size 100MB }` to the name's block in the rendered test Caddyfile by
  hand: the first test fails with 413, the second too in the repo's file. Take it out.
- [ ] **Step 3: If it fails with nothing added,** lift the limit in `Caddyfile` or `relay/frps.toml` until it passes,
  and write the setting and why in the commit; plan 13's Task 14 deploys it.
- [ ] **Step 4: Commit** (`commit -s`) "Test that a large, slow upload reaches a company through the relay".
