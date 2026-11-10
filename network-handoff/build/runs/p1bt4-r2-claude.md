# Plan 1b Task 4, review round 2 (Claude, read only)

Scope: the six Important findings of round 1 and the Minor list, on the package `runs/p1bt4-r2.diff` (lane files
`wt/p1bt4/apps/server/src/modules/tls/x509.ts` and `test/x509.test.ts` are byte for byte the package's). Focused run in
the lane through light.sh: `vitest run test/x509.test.ts` 19 passed. tsc, the whole suite and the gates: the lead's run.

## How the "would it fail with the code wrong" claims were checked

A scratch copy of the test file under `network-build/tmp/p1bt4-r2-claude/` (node_modules symlinked to the lane, nothing
in the lane touched) was run against the current `x509.ts` and seven wrong versions. Each wrong version was caught by
the test the finding asked for:

| version of x509.ts | failing tests |
|---|---|
| current | none, 19 pass |
| round 1 code (regex `certInfo`, no trailing newline) | newline/chain test, and all three `agrees with what TLS loads` tests |
| `toPem` without `\n` | `ends ... with a newline`, `reads the first certificate of a chain` |
| `CN=stand-in` | `is named, signed and keyed as a stand-in` |
| AKI extension removed | `carries key identifiers made from its own key` |
| curve P-384 | `is named, signed and keyed` (prime256v1 line) |
| `.filter(type === 'dns')` removed | `gives only the dNSNames of a mixed list, in order` |
| one key pair shared by every stand-in | `makes a new key each time` |

## Findings of round 1

1. **PEM trailing newline: ADDRESSED.** `toPem` appends `\n`, `certPem` goes through it from `cert.rawData`
   (x509.ts:16-18, :43). Test `ends its certificate and key with a newline...` asserts `endsWith('\n')` on both and
   `createSecureContext({ cert: a + b })` not throwing; it fails without the fix (table).
2. **certInfo reads what TLS serves: ADDRESSED, with the writer's deviation accepted.** No anchored regex; `certInfo`
   parses once with `node:crypto`'s `X509Certificate` and gives `node.raw` to `@peculiar/x509` (x509.ts:51-59). This is
   a stronger fix than anchoring: Node's constructor and `SSL_CTX_use_certificate_chain` both go through OpenSSL's
   `PEM_read_bio_X509_AUX` for the first block, so the two readers are one. Checked beyond the three inputs: a scratch
   script compared the fingerprint a `tls.createServer` serves with `certInfo(...).fingerprint256` on 15 inputs (plain,
   chain, CRLF, glued, text before BEGIN, trailing spaces, key then cert, garbage line first, trailing garbage, blank
   line inside base64, TRUSTED CERTIFICATE block, indented BEGIN, lowercase BEGIN, BEGIN with trailing space, broken
   block then cert): 0 mismatches, both throw or both pick the same certificate. The three tests each assert TLS's view
   and certInfo's view on the same text, so a regex coming back fails them (table, round 1 row).
   Minor, by design, not a gap: `certInfo` describes the first certificate only, so a chain whose second block is
   malformed (`a + b.trimEnd() + a`) gives `a` from certInfo while TLS refuses it with `bad end line` (reproduced).
   The Interface says "the first certificate of a chain", and the listener's own load reports the chain error; Task 5/7
   should keep loading the chain into the listener before they trust the row.
3. **Key in a test message: ADDRESSED.** test:119 `expect(first.keyPem !== second.keyPem, 'two stand-ins share a private
   key').toBe(true)`. Forced to fail with a shared key pair: the output is `two stand-ins share a private key: expected
   false to be true`, and a grep of the whole failure output for `BEGIN` or any base64 run of 40+ characters finds 0
   lines. Fingerprints in the second assertion are not secrets.
4. **Stand-in shape asserted: ADDRESSED.** test:68-85: subject and issuer `CN=Hornhoof stand-in`, `ec` and
   `prime256v1`, PKCS#8 header `-----BEGIN PRIVATE KEY-----\n`, SKI and AKI both equal
   `SubjectKeyIdentifierExtension.create(cert.publicKey).keyId`. Each bites: CN change, AKI removed, P-384 and a
   wrong key label all fail (table). Passing at once on finished code is right here: the behaviour already existed, the
   tests pin it.
5. **Serial content octets: ADDRESSED.** test:102-107 `it.each(['89abcdef', '0089abcdef'])` reads the DER INTEGER's
   content octets with its own helper and expects `0089abcdef`, plus Node's `89ABCDEF`. The helper was checked against
   an independent parser (asn1js on `node.raw`): `89abcdef` and `0089abcdef` both give content `0089abcdef`; `ff` gives
   `00ff`, `7f` gives `7f`, so the library keeps a positive INTEGER as the plan says. Cannot be made to fail by changing
   x509.ts (the library decides), but it fails if the library ever emits `89abcdef` or `000089abcdef`, which is what
   Task 6 needs pinned.
6. **SAN filter: ADDRESSED.** test:135-143 builds a certificate with dns, ip, url, dns and expects exactly
   `['one.hornhoof.org', 'two.hornhoof.org']`; with the filter removed it fails (table), and the order is asserted.

## Minor list

All done: `server.close` awaited in `finally` and the client destroyed on error (test:15-33); validity in exact
milliseconds (`days * DAY_MS`); one `node:crypto` import in each file; the `CryptoKey` casts are gone, only the
`webcrypto as unknown as Crypto` provider cast remains; the report's lock-file line is corrected (report lines 13-15,
78-79).

## New breakage in what the fix changed

None found. Critical: none. Important: none. Minor: the chain-with-broken-second-block note under finding 2.
