# Plan 1b Task 4 report (lane /home/altera/hornhoof-network/wt/p1bt4)

Status: DONE_WITH_CONCERNS (concerns: lock file note, two equivalent mutants, mutator not rerun after the last test).

## Read before writing
Skills test-driven-development, systematic-debugging, verification-before-completion (plugins/superpowers/skills/<name>/SKILL.md);
CLAUDE.md, hornhoof/AGENTS.md, hornhoof/templates/skills/dev-engineering-rules.md, the brief p1bt4-writer.md.

## Files changed
- apps/server/src/modules/tls/x509.ts (new): selfSigned, certInfo, CertInfo, SelfSignedOptions.
- apps/server/test/x509.test.ts (new): 11 tests.
- apps/server/package.json: `@peculiar/x509` 1.14.3 and `acme-client` 5.4.0, exact.
- package-lock.json: 30 new `node_modules/*` entries (the two packages and their tree: asn1js, axios, node-forge, tsyringe, ...).
  Besides those, npm removed the `"version": "0.6.0"` line from the `apps/server` and `apps/web` workspace entries
  (an npm normalisation, not a dependency change). No existing package version changed.

## Install (ruling 7)
Removed the lane's hard-linked node_modules (root, apps/*, packages/*), `npm ci`, then
`npm install --save-exact -w @hornhoof/server acme-client@5.4.0 @peculiar/x509@1.14.3`, then built @hornhoof/protocol.
`npm ls acme-client @peculiar/x509 -w @hornhoof/server`: acme-client@5.4.0, @peculiar/x509@1.14.3 (deduped under acme-client), no other version.

## TDD
- Red: x509.test.ts first run failed with "Cannot find module '../src/modules/tls/x509.js'" (module missing, the plan's reason).
- Green: 9 tests passed after x509.ts.
- Added after the first mutator run: a test for a certificate without a SAN (names `[]`) and a test for `days: 0`.
  The `days: 0` test was run red against a temporary `||` in place of `??` (failed: "expected 30 to be +0"), then the code restored; 11/11 pass.
  The no-SAN test passed on the existing code (it only kills mutants); the next mutator run showed `?.` -> `.` killed.

## Checks run
- Focused: `light.sh npx vitest run test/x509.test.ts` 11 passed.
- `npx tsc -p apps/server/tsconfig.json --noEmit`: prints nothing. `npm run typecheck:tests` and `npm run lint`: clean.
- Whole suite via remote.sh and hh-suite.sh (label p1bt4-suite): server 111 files passed, web 49 files / 767 tests passed; no failure in the log.
- Gates (label p1bt4-gates2): crapper max 4.1 (dnsNames, CC 3), all under 10; dryer: no duplicate candidates.
- Mutator, last run: 7 killed, 3 survived. Survivors:
  - x509.ts:25 `opts.now ?? new Date()` -> `||`: equivalent, a Date object is never falsy.
  - x509.ts:54 `san?.names.items ?? []` -> `||`: equivalent, `items` is an array, always truthy.
  - x509.ts:26 `opts.days ?? 30` -> `||`: killed since by the `days: 0` test (verified by hand as above; not rerun through mutate.sh).

## Deviations and notes
- `selfSigned` also exports `SelfSignedOptions` type (plan inlines it). Same shape.
- `certInfo` throws `Error('No certificate found in the PEM text')` on text without a certificate (plan silent); tested.
- Plan's `npm test -- --testTimeout=90000` does not reach vitest; used hh-suite.sh as the lead said.
- Nothing staged or committed. No private key printed.

## Ivan's ruling on mutator
Per the lead's later message, writers no longer run mutator. No mutator run of mine is active. The three survivors above
(lines 25, 26, 54 of x509.ts) go to the plan's review; 25 and 54 are equivalent, 26 has the `days: 0` test.
Handed in with: whole suite (hh-suite.sh), crapper, dryer.

# Fix report, review round 1

Rules re-read for the round: the same three skills, CLAUDE.md, the brief. No mutator run (Ivan's ruling). Tests are 19 now (were 11).
Each new test was run before the code change. No private key text appears in any assertion message.

1. PEM without a trailing newline. Tests: `ends its certificate and key with a newline so that texts join into a chain`
   (also builds `createSecureContext({cert: a + b, key})`). Failed first: `expected false to be true` on `endsWith('\n')`.
   With the fix reverted by hand the chain test and `reads the first certificate of a chain` fail too. Fix: `toPem` adds
   `\n`, and `selfSigned` builds `certPem` from `cert.rawData` through the same `toPem`.
2. `certInfo` read a different certificate than TLS. Three tests under `agrees with what TLS loads from the same text`.
   Failed first: glued certificates (`expected [Function] to throw`, certInfo accepted what TLS refuses); text before
   BEGIN on a line (`['b.hornhoof.org']` instead of `['a.hornhoof.org']`; the TLS server serves a); lines ending in
   spaces (`Unsupported format of 'raw' argument`). Fix: the regex and `firstCertificateBlock` are gone. `certInfo` parses
   the text once with `node:crypto` `X509Certificate`, the same reader TLS uses, and hands `node.raw` (DER) to
   `@peculiar/x509`. Deviation from the review text: no anchored regex, because dropping it gives the same guarantee with
   less code; the three tests would catch a regex coming back.
3. Key in a message. `makes a new key each time` now compares with a boolean and a fixed message.
4. Stand-in shape. Tests `is named, signed and keyed as a stand-in` (subject, issuer, ec prime256v1, PKCS#8 header) and
   `carries key identifiers made from its own key` (SKI and AKI equal `SubjectKeyIdentifierExtension.create` of the
   certificate's own key). These passed at once (the behaviour already existed). Checked they bite: with the CN changed,
   the AKI line deleted and the curve changed to P-384 both failed, then the code was restored.
5. Serial. `keeps the serial 89abcdef / 0089abcdef a positive integer of content 0089abcdef` (it.each) reads the DER
   INTEGER content octets, no zero stripping. First run failed only because my DER reader was wrong (`'0205'`); after
   fixing the helper both pass on the existing code, which confirms the library does what the plan says.
6. SAN filter. Test `gives only the dNSNames of a mixed list, in order` (dns, ip, url, dns). Passes on the existing code;
   it kills the `type === 'dns'` filter mutants by construction.
Minor: `servedAltName` awaits `server.close` and destroys the client on error; validity compared in exact milliseconds
(`days * DAY_MS`); one `node:crypto` import; `CryptoKey` casts removed from `x509.ts` (only the `webcrypto` provider cast is
needed, tsc fails without it). The lock note above was wrong in saying it was an npm change I could not explain: npm moved
the workspace `version` lines; no dependency version changed.

Results: `vitest run test/x509.test.ts` 19 passed; `tsc -p apps/server/tsconfig.json --noEmit` empty;
`npm run typecheck:tests` and `npm run lint` clean. Remote (label p1bt4-fix2, hh-suite.sh and gates): server 111 files
passed, web 49 files passed, release checks passed; crapper max 3.0 (dnsNames, selfSigned), dryer no duplicate candidates.
Note: a first remote run (label p1bt4-fix) was killed by my own mistaken `timeout` around remote.sh and produced an empty
log; it was rerun as p1bt4-fix2.
