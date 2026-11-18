# Hide secrets in stored text

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/tasks/1077-secret-redaction.md). These are historical results, not checks of the current release.

Task 1077. Original base: origin/turn-31, d44ecb8c7d3d0b6d7ce690e01c25046f0404b212.

The continued candidate takes origin/turn-31 at 73d4a6e9521059384503aa8f2d9a4942635d1568, regenerates the unpublished migration as 0137_secret_redactions and offers the now available company vault beside masked task text. Queue changes from the incoming release are kept; only the credential scrub calls are added.

## Plan

1. Reuse the protocol credential patterns for persisted prose and the node. Extend password labels for English and Russian. Do not treat commit hashes, UUIDs or task numbers as credentials.
2. Clean task fields and notes before any archive, conversation events, queued prompts and inbox letters before persistence. Keep metadata and private paths intact.
3. Add a person-only task endpoint with server authorization for the CEO, delegate and people running the task's department. Validate that the selected value occurs in that task's visible text or log before changing anything. Return only masked data.
4. Keep a secret suppression record containing a hash, a rolling window hash and the character length, never the value. In one transaction scrub the company's stored text, nested JSON, archived text attachments and the replication/merge journal. A merge checks the rows an old copy brings against the fingerprints, so it cannot restore the value. Ordinary database replication carries the change. (Changed in Review, see below.)
5. Add a selection action to task prose and log entries using existing controls, theme tokens, English and Russian strings and logical layout properties. Record only the actor and time of the action.
6. Prove each input source, exact marker removal, permission rejection, false-positive examples and stale-copy suppression with named local tests. Run affected types, lint and builds, and an isolated browser flow. Do not run a whole suite or run_tests. Hand the exact pushed candidate to Review, then required independent Security and Tests. Do not integrate or deploy.

## Limits

The action edits the live logical database and its ordinary replicas and merge inputs. Previously exported files, encrypted historical backups and copies outside the database are not rewritten. No live server is accessed for this task. The adjacent password vault is offered only if present in the checked base.

## Review redesign

Review found that the first design scanned every row of every company inside a database trigger on each write, with a quadratic search, and locked all tables while it swept. The head chose a different scheme (task 1077, 17 November):

- The database has no function or trigger that sees a value. The server replaces it in its own process: it reads the company's prose rows in batches through one cursor, replaces the value in memory and writes back only the masked text. The value never goes to SQL as text or as a parameter, and never into a log, an event or an answer. Other companies' rows are not read.
- The action holds this server's write gate for its transaction, with no lock on all tables.
- A suppression row keeps the SHA-256 of the value, its length in characters and a rolling hash of its code points. A merge checks each row the copy brings in one pass per length: a full hash only where the rolling hash matches. When a merge brings a fingerprint new to this side, this side's own prose of the company is checked once in the same transaction.
- A value shorter than 8 characters is refused with a plain message, as the node does.
- Frozen outbound evidence may lose a hidden value only in its prose columns, only from the server's own session, in the hiding transaction.

Measured in PGlite on the shared review machine (load 8 to 22), each task row about 500 characters of prose:

| Company prose rows | Hide request | Write gate held | One-time sweep for a new fingerprint |
| --- | --- | --- | --- |
| 10 000 | 1.1 s | 0.7 s | 1.1 to 1.2 s |
| 100 000 | 9.1 s | 10.0 s | 8.9 to 11.3 s |

A merge of a copy with 1 000 changed rows took 4.3 to 6.6 s at 10 000 rows and 5.3 to 11.6 s at 100 000 rows, with and without fingerprints; the differences are within the noise of that machine. Real PostgreSQL was not measured.
