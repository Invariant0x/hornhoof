# Review: batch 6, slice cert (Plan 1b Task 7), reader Claude

Package: `network-build/runs/batch6-cert.diff` (commits a98a7fe0, c9a67dd2 on `hornhoof` branch `batch-6`). Read only; nothing
changed, nothing run but greps, `git ls-files`, `git show -s --format=%s` and one Python check of the drizzle snapshot chain.

Read for this review: the brief `briefs/batch6-cert-review.md` whole; plan 1b's top part, Rulings made while planning, Global
Constraints, Review Focus and Task 7; spec `2026-11-02-single-network-design.md` (3.8 backups, keys); ledger `progress.md`
(lines 328 to 340 for this task, all earlier rulings stand); `parallel-map.md` section 3 (seams 1b T5/T7, 1b T6/T7, 1b
T7/T8/2 T6, 1b T7/2 T7, 1b T3/T7/3 T2); `CLAUDE.md`; `hornhoof/AGENTS.md`; `hornhoof/templates/skills/dev-engineering-rules.md`;
skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`. On the branch as it stands:
`apps/server/src/config.ts`, `app.ts`, `db/agent-sql.ts`, `modules/tools/database.ts`, `modules/tls/store.ts`, `x509.ts`,
`acme.ts` (head), `listener.ts` (imports), `modules/link/link.ts`, `tunnel.ts`, `client.ts`, `cli.ts` (the link command),
`tunnel.ts` entry, `compose.yaml`, `drizzle/meta/0054_snapshot.json` and `0055_snapshot.json`; the lead's logs
`remote-p1bt7-check-20261105-012649-1442928.log` and `batch6-ci.log`.

## What I checked against the brief

- Interfaces, line by line: `linkTls` columns and types equal the plan's; `TlsRow`, `tlsOf`, `saveTls`, `updateTls`, `linkMode`
  signatures equal the plan's; `Settings` gains `mode` with default `http`; `acmeDirectory` and the config message are the
  plan's words; the https proxy block equals the plan's seven lines, `localPort` is `LINK_TLS_PORT` (seam 1b T5/T7); http mode
  is today's config byte for byte (`client.test.ts` compares the whole text against the unchanged `CONFIG`).
- Where the private key could be seen or leave from: `link_tls` is in `HIDDEN` (`agent-sql.ts:16`), so both agent roles'
  `eachTable` loops skip it and `database.ts:refusal` answers `CLOSED` for it; the reader and the orchestrator lists in
  `orchestrator-control.test.ts` both hold `SELECT * FROM link_tls`. `tunnel.json` gets `url, name, key, tunnel, mode` only
  (`link.ts:42`); the test checks with booleans that neither key, neither sealed key nor the words `PRIVATE KEY` reach it. No
  log line, API answer or error message in the diff carries a key: `updateTls`'s throw is a fixed sentence, `linkMode`
  swallows every throw. Backups (updater step `backup`, `pg_dump` of the database) carry `cert_key_enc` and
  `account_key_enc` only as `encryptSecret` gives them, the same class as `public_links.key_enc` today, which the plan allows.
- What the tunnel does when the row, key or certificate is missing, wrong or expired: `mayRunHttps` (`store.ts:46-52`) says
  no for another name, no certPem, no certKeyEnc, a host not among the SAN names, 24 h or less left, a key that is not the
  certificate's; `certInfo`, `decryptSecret`, `createPrivateKey` and `X509Certificate` throws land in `linkMode`'s catch and
  give `http`; `acmeDirectory === null` gives `http` before any read. Each branch has a case in `link.test.ts` and the 24 h
  edge has a fixed clock test, so a wrong comparison or a dropped check fails a named case.
- An old `tunnel.json` with no mode: `Settings.parse` fills `http` and `clientFor` writes today's config (`client.test.ts`
  `reads settings with no mode as http`); the keeper parses with the same exported schema (`tunnel.ts:84`).
- Restart: `app.ts:146` runs `links.sync()` when the app becomes lead, so a restart writes `tunnel.json` from the database
  at once and `ACME_DIRECTORY=off` plus a restart puts the link back on http, as the plan and the store.ts comment say.
- Interactions between slices: `config.ts` holds `keeper` (2 T3) and `acmeDirectory` (1b T7) side by side in the one split
  `loadConfig`; `app.ts`'s `ctx.mode` gates `sync()` to the lead; `agent-sql.ts`'s `role(rights)(name)` refactor keeps the
  exported shape `(name: string) => string`; the sql-check slice (`batch6-sql.diff`) keeps no table list of its own, so
  `HIDDEN` stays the one place.
- Migration: `0055_link_tls` is the plan's number plus 11 in the lane order (ruling 5); `0055_snapshot.json` chains to
  0054's id and holds the 17 columns; `_journal.json` has the entry; `migration-history.test.ts` and
  `migration-metadata.test.ts` pin 55 and 0055.
- Build rules: no em dash in the package or the changed tracked files; English throughout; comments say why; the lead's
  check log says lint and tsc clean, 2194 passed with 1 todo, worst changed CRAP 7.0, dryer no pair. No Python changed. No
  process or port left: the tests use `onTestFinished` for the fake relay and the app.

## Critical

None.

## Important

None.

## Minor

1. `client.ts:287-290`: `PROXY` and `lastLine` say where the line sits, not what it is. It is the line that tells the app
   who the visitor is (a header in http mode, the PROXY protocol in https). A name like `visitorLine` reads itself.
2. `client.ts:6` imports `LINK_TLS_PORT` from `tls/listener.ts`, so `dist/tunnel.js` now loads the TLS listener module and
   `@peculiar/x509` at start in the tunnel container. It runs the app's own image, so nothing breaks; a small constants file
   both import would keep the tunnel's process to what it uses.
3. `store.ts:464-466`: `linkMode` swallows every throw with no log line. The plan says a throw means http, and that is
   right, but an operator whose link stays on http has no trace of why. If Task 8's manager logs the reason (without the
   key), nothing more is needed here; told for its reader.
4. `migration-metadata.test.ts` moves its snapshot pin from 0054 to 0055. The change is needed, but the file is outside the
   plan's Files list and the commit's rulings do not name it.
5. The package leaves out `drizzle/meta/0055_snapshot.json` (5165 lines in a98a7fe0). I checked it on the branch instead;
   a line in the package saying it was left out on purpose would spare the next reader the search.
6. No red run of the new tests is in `runs/`; the claim that each was seen to fail first rests on the commit message. The
   conveyor takes the author's word for the per-task check, so this is a note, not a demand.
7. `database.ts:15`: `CLOSED` names sign-ins, invites, install codes, sealed plan sign-ins and the public link; the
   certificate's row now falls under it unnamed. Right answer, slightly stale sentence.

## Verdict

The task does what it promises, with the plan's Interfaces met word for word and the private keys kept where the Global
Constraints put them. Nothing here needs the fix round; the Minors are for the writer's judgement or for Task 8.
