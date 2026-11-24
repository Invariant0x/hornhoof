---
id: dev-test-environment
kind: procedure
sources: []
---
Discover the exact revision's requirements from its build manifests, locks, test profiles, service configuration, migrations and fixtures. The product owner and assigned environment owner choose the product's languages. Several programs may need distinct runtimes. Follow declared versions, including `.tool-versions` where the project uses it.

Use a verified prepared environment when it matches the revision and assigned runner. Approved preparation fetches tools once for each product and declared runtime fingerprint when the result is reusable. A changed version or preparation input invalidates that result. Another product's runtime is no evidence that this product is ready. If preparation or a local build is needed, report it separately from test execution.

Use the installed runtime's current environment contract. Record profiles, dependency inputs, service readiness, migration and seed inputs, isolation, reset behavior, test inventory, selection and evidence. Keep immutable preparation separate from private mutable state. Prove readiness, recovery from interruption and isolation between attempts. Do not patch running containers or expose host sockets or node credentials to product tests.

For a missing contract or unsupported runner, record what could be established from the repository and the exact unproved prerequisite. Check profile and fingerprint before reusing a prior pass. Report what actually ran, what was reused and any reason reuse was unavailable.

For assigned mutation testing, choose changed risky pure logic and its covering tests. Use the same isolated scope for baseline coverage and mutation. Keep fixture protections, and record which results the tool actually established.
