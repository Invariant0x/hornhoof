# Historical evidence

Keep short reports in the repository. Attach raw logs, profiles, screenshots,
receipts and intermediate patches to their task or release with `hh-attach`.
Do not make evidence-only commits. Browser captures use the test output directory
and the test's attachments, not a tracked documentation folder.

Task 1364 archived the evidence present at release 0.32.0 before removing its raw
copies from the source tree. The attachment `task-1364-source-evidence.tar.gz`
contains 429 original files, including the unabridged reports, and
`archive-manifest.json`. The manifest records the source commit, original paths,
sizes and SHA-256 values. It is also attached separately to task 1364.

Archive SHA-256: `3bbe0605f4f22efddab07631e005895de06aa6b6d9c11efd64da4de27b6003fa`.

Retrieve it with `hh-fetch 1364 task-1364-source-evidence.tar.gz`. Verify the archive
hash before extracting into a separate directory, then verify each file against
the manifest. The archive preserves the old relative paths, so old verification
scripts can be read alongside their records; a historical script is not a check
of today's source.

For readers without task storage, the originals remain in Git at
[`509b469f086cf28f63ec4799ad6187498bf96da0`](https://github.com/invariant0x/hornhoof/tree/509b469f086cf28f63ec4799ad6187498bf96da0/docs).
Report links to removed files point to that exact tree. This cleanup rewrites no
Git history and changes no previous result or approval.
