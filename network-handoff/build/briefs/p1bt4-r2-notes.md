# Notes for this review from the build lead

- This is review round 2 of plan task 4, written in the lane `/home/altera/hornhoof-network/wt/p1bt4`. The change under review is the package
  `/home/altera/hornhoof-network/network-build/runs/p1bt4-r2.diff`: the lane's own work against its start, the tag `lanebase`. What it stacks on is reviewed separately.
- The writer's report, claims to verify and not to trust: `/home/altera/hornhoof-network/network-build/runs/p1bt4-report.md`. It says what ran and how each test failed first.
- Where this task meets others: `/home/altera/hornhoof-network/network-build/parallel-map.md` sections 1, 3 and 4 for this task, and section 5's rulings, all taken. Build ruling 5: migration numbers are the plan's plus 11.
- The lead runs the full suite and the three gates itself, on the test machine. You run at most focused tests, in the lane, through
  `/home/altera/hornhoof-network/network-build/light.sh <command>`.

# This is a scoped re-review, round 2

Say for each finding below ADDRESSED or NOT ADDRESSED, with how you checked it, and whether its test really fails without the fix. Report new Critical or Important breakage only in what the fix changed. Do not reopen what was accepted or deferred, and do not review the rest of the task again.

# Plan 1b Task 4, review round 1: what the lead accepted

Reviewers: Claude fable (runs/p1bt4-r1-claude.md: 0 Critical, 0 Important, 7 Minor), Antigravity Argon high (runs/p1bt4-r1-agy.md: 0 Critical, 6 Important). Read both for detail. Where they
differ, judged by what a person would get.

## Important: one fix round, each from a test that fails first

1. **PEM with no trailing newline breaks a chain.** `a.certPem + b.certPem` fails in `tls.createSecureContext` with `ERR_OSSL_PEM_BAD_END_LINE` (reproduced). Tasks 5, 7 and 8 build chains: a certificate that loads in the check and fails in
   the listener takes a company's link down. `certPem` and `keyPem` end with `\n`. Test: `tls.createSecureContext` takes the chain.
2. **`certInfo` can read a different certificate from the one TLS serves.** Its regular expression is not anchored and two parsers read the text (three mismatches reproduced). Anchor the block to whole lines, parse once with `node:crypto`, and hand `node.raw` to `@peculiar/x509`, so both read
   the same DER. Test each of the three inputs against what `tls.createSecureContext` does: `certInfo` must agree with it or refuse.
3. **A private key can reach a test message.** `expect(first.keyPem).not.toBe(second.keyPem)` prints both on failure. Compare with a boolean and a fixed message. Throwaway keys, but the rule has no exception.
4. **The stand-in's stated shape is not asserted.** subject and issuer `CN=Hornhoof stand-in`, SKI and AKI matching the key (Task 6 rests on them), ec `prime256v1`, PKCS#8 header.
5. **The serial test does not pin what Task 6 rests on.** Both `89abcdef` and `0089abcdef` must give DER content octets `0089abcdef`. Drop the zero-stripping.
6. **The SAN filter is unpinned.** A certificate with mixed SAN entries and several dNSNames: only the dns ones, in order.

## Minor: do these while you are there
- `test/x509.test.ts`: `server.close()` awaited and the client destroyed on error; exact millisecond validity instead of a rounded day; one `node:crypto` import. The unneeded `CryptoKey` casts go, if tsc stays clean. Correct the report's line about the lock's version lines: npm moved them.

## Deferred (ledger)
Dates parsed from OpenSSL text rather than validFromDate (Node 22.23 has it; only if `node.raw` work makes it natural); SAN names keep their case, Task 8's name comparison must lowercase.
