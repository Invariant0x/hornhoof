# Review of Plan 1b Task 4, round 1 (Claude reviewer, read only)

Package: `network-build/runs/p1bt4-r1.diff` (lane `wt/p1bt4`, uncommitted, against tag `lanebase`). Files touched:
`apps/server/package.json`, `package-lock.json`, `apps/server/src/modules/tls/x509.ts` (new), `apps/server/test/x509.test.ts` (new).
`git status` in the lane shows those four paths and nothing else.

Counts: Critical 0, Important 0, Minor 7.

## What I checked and how

- Focused test, one run through `light.sh` from `apps/server`: `npx vitest run test/x509.test.ts`, 11 passed.
- `npm ls acme-client @peculiar/x509 -w @hornhoof/server`: `@peculiar/x509@1.14.3` once (deduped under acme-client, which
  asks `^1.11.0`), `acme-client@5.4.0`; the lock has one `node_modules/` entry for each. `apps/server/package.json` pins
  both exact. Licenses from the installed `package.json`s: acme-client MIT, @peculiar/x509 MIT; in their tree node-forge
  `(BSD-3-Clause OR GPL-2.0)`, asn1js BSD-3-Clause, axios MIT, tsyringe MIT, reflect-metadata Apache-2.0, tslib 0BSD.
  Nothing copyleft-only.
- Lock file `"version": "0.6.0"` lines: not lost. npm moved them from the end of the entry to after `"name"` for
  `apps/server` and `packages/protocol`; `apps/web` is untouched (the diff shows it as context). In the lane's lock all
  three workspace entries carry `"version": "0.6.0"` (lines 45, 75, 7835). Readers: `scripts/release/project.mjs`
  `writeVersion` reads `lock.packages[key]` by key and rewrites `version` by spreading, so position is irrelevant and the
  "no workspace entry" check still passes; `apps/server/test/pins.test.ts:117` reads only `node_modules/` entries; the
  Dockerfiles and `scripts/node-build.sh` only copy the file. The updater reads none of it.
- A probe script (`network-build/tmp/claude-p1bt4/probe.mts`, prints no key material) run with the lane's tsx:
  - Serial: `'89abcdef'` and `'0089abcdef'` both give DER content octets `0089abcdef`; `'7f'` gives `7f`; no serial
    gives 16 random bytes. Matches the plan's statement Task 6 rests on.
  - Stand-in: subject and issuer `CN=Hornhoof stand-in`, `ca: false`, EC key on `prime256v1`, ECDSA with SHA-256,
    extensions SAN (2.5.29.17), SKI (2.5.29.14), AKI (2.5.29.35), none critical, `verify(publicKey)` true,
    `checkIssued(self)` true. A `tls.connect` client with default trust reports `authorized: false`,
    `DEPTH_ZERO_SELF_SIGNED_CERT`, TLS 1.3. No browser or client trusts it without someone installing it by hand.
  - `now` with milliseconds is truncated to the second in the certificate; `certInfo` returns the truncated time. A
    `now` in 2051 (GeneralizedTime) reads back correctly.
  - `certInfo` on hostile input: garbage base64, an empty block and a truncated block throw Node's OpenSSL error
    (`asn1 encoding routines::wrong tag`, `bad base64 decode`); text with no block throws
    `No certificate found in the PEM text`; a PRIVATE KEY block before the certificate is skipped and the certificate
    read; CRLF line ends work; two certificates glued with no newline between them give the first. No input returned a
    half-filled result; every bad input throws, so a caller that catches gets "unknown", which the constraint maps to
    `http`.
  - A SAN with `ACME.Hornhoof.ORG`, an `ip` entry and `*.hornhoof.org` gives `names: ['ACME.Hornhoof.ORG',
    '*.hornhoof.org']`: dNSNames only, case kept, wildcard kept.
- Gates from the lead's log `remote-p1bt4-gates2-...`: crapper max 3.0 (dnsNames, selfSigned), dryer no candidates.
  Mutator (informational, the plan's review runs it): the three `??` -> `||` survivors at x509.ts:25 and :54 are
  equivalent as the writer says (a Date and an array are never falsy); :26 is killed by the `days: 0` test that was
  added after that run.
- A copy of `x509.ts` with the two `as unknown as CryptoKey` casts removed type-checks clean against the server
  tsconfig (`types: ["node"]`, no DOM lib): `tsc` exit 0. The `webcrypto as unknown as Crypto` cast is needed (the
  @types/node `Crypto` and the library's `Crypto` disagree on `generateKey` overloads); the plan prescribes it.
- No em dash in the changed files. Comments are English sentences that say why. Interfaces match the plan: `selfSigned`
  signature, `CertInfo` shape, `certInfo(pem)` synchronous. The five tests the plan names are all present.
- No private key reaches a log line, an error message or a result other than `keyPem` itself: the only `Error` text is
  fixed; nothing is logged.

## Findings

### Critical

None.

### Important

None.

### Minor

1. `apps/server/test/x509.test.ts:75` `expect(first.keyPem).not.toBe(second.keyPem)`. If the assertion ever fails,
   vitest prints both PEM private keys in the failure diff. The keys are throwaway stand-in keys made inside the test
   and protect nothing, so nobody is exposed, but CLAUDE.md's letter is "tests compare it with booleans and fixed
   messages". Make it `expect(first.keyPem === second.keyPem).toBe(false)` (the fingerprint line below already proves
   the keys differ).
2. `apps/server/test/x509.test.ts:62-65` `uses the given serial as a positive integer`. Node already strips the DER's
   leading `0x00` from `serialNumber`, so `.replace(/^0+/, '')` is a no-op, and the test never asserts the plan's
   sentence that `0089abcdef` and `89abcdef` give the same content octets, which Task 6's certificate id test rests on.
   It does guard positivity indirectly (a negative INTEGER would print as `-89ABCDEF` and fail). Add a second call with
   `serial: '0089abcdef'` and assert both certificates' `serialNumber` are equal, or read the DER octets through
   `@peculiar/x509` as the probe did.
3. `apps/server/src/modules/tls/x509.ts:28, 35` `as unknown as CryptoKey` and `apps/server/test/x509.test.ts:98`
   `as unknown as CryptoKeyPair`: unnecessary, `tsc` passes without them (checked on a copy). "Do not silence the
   compiler"; drop them. Keep the `Crypto` cast on line 5, that one is required.
4. `apps/server/src/modules/tls/x509.ts:62-63` dates are read by parsing OpenSSL's text (`new Date(node.validFrom)`,
   "Jan  2 03:04:05 2026 GMT"), a non-standard date string V8 happens to accept. Node 22.23 here has
   `validFromDate` / `validToDate` (since 22.10, typed in `@types/node` 22.20); use them.
5. `apps/server/src/modules/tls/x509.ts:54` `names` are returned as written in the certificate (case kept, wildcards
   kept). RFC 5280 dNSNames compare case-insensitively; Task 8 compares a name with the link's current name. Let's
   Encrypt lowercases, so nothing breaks today, but lowercasing at this boundary ("parse outside data once, where it
   comes in") would make the later comparison safe by construction. A note for Task 8 if not done here.
6. `apps/server/src/modules/tls/x509.ts:43` `cert.toString('pem')` and `toPem` give PEM with no trailing newline
   (probe: `endsWith('\n')` false for both). A later task that writes `certPem + chain` or a key file must add the
   newline. Nothing in this task is wrong; the chain test passes because the regex does not need it. Either append
   `'\n'` here or note it for Tasks 6 and 7.
7. Report wording, `p1bt4-report.md`: "npm removed the `"version": "0.6.0"` line from the `apps/server` and `apps/web`
   workspace entries" is not what happened: the lines moved, for `apps/server` and `packages/protocol`, and `apps/web` is
   unchanged. Nothing reads the position (see above). Also `apps/server/test/x509.test.ts:1, 4` import from
   `node:crypto` twice; merge into one import.

## Build rules

- TDD: the lane is uncommitted so I cannot see red from history; the report's red reason ("Cannot find module") is the
  plan's expected one, and the `days: 0` test's red against a temporary `||` is described. The no-SAN test never failed
  on the code; it exists to kill the `?.` -> `.` mutant and does so (gates log: KILLED at :54). Acceptable.
- crapper under 10 everywhere (max 3.0); dryer clean; functions small, names plain. Nothing private, no hostname but
  `hornhoof.org` names, no em dash. Nothing to deploy, no port left behind (the TLS test server is closed in `finally`).
