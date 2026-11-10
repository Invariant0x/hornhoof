# Preparation note for Task 9, not a launch brief

Do not start Task9 until preceding tasks are accepted/committed and the actual base is assigned.

When introducing the token-owned edge client identity, keep the Task6 ownership protections across every Login path, including edge's special authentication path. Check the reserved literal edge identity as well as CLIENT-shaped identities; the Task6 CLIENT regex only covers link/peer/visit names. Genuine legacy behavior and the shared plugin deadline must remain. Use only local fixture tests and existing helpers; no new general wire tooling or external targets. This is an integration check for the new privileged identity, not a Task6 scope expansion or a new ruling.

The plan's negative custom-domain fixture globex.example.com is outside test_public.py's existing allowlist, whereas example.com is allowed. Before writing, resolve that synthetic fixture under the lead's public-host rulings without weakening the allowlist or changing unlisted files.
