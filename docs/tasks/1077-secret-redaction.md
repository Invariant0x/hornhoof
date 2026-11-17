# Hide secrets in stored text

Task 1077. Original base: origin/turn-31, d44ecb8c7d3d0b6d7ce690e01c25046f0404b212.

The continued candidate takes origin/turn-31 at 73d4a6e9521059384503aa8f2d9a4942635d1568, regenerates the unpublished migration as 0137_secret_redactions and offers the now available company vault beside masked task text. Queue changes from the incoming release are kept; only the credential scrub calls are added.

## Plan

1. Reuse the protocol credential patterns for persisted prose and the node. Extend password labels for English and Russian. Do not treat commit hashes, UUIDs or task numbers as credentials.
2. Clean task fields and notes before any archive, conversation events, queued prompts and inbox letters before persistence. Keep metadata and private paths intact.
3. Add a person-only task endpoint with server authorization for the CEO, delegate and people running the task's department. Validate that the selected value occurs in that task's visible text or log before changing anything. Return only masked data.
4. Keep a secret suppression record containing a hash and character length, never the value. In one transaction scrub stored text, nested JSON, archived text attachments and the replication/merge journal. Apply suppression on subsequent writes and merges, so an old copy cannot restore the value. Ordinary database replication carries the change.
5. Add a selection action to task prose and log entries using existing controls, theme tokens, English and Russian strings and logical layout properties. Record only the actor and time of the action.
6. Prove each input source, exact marker removal, permission rejection, false-positive examples and stale-copy suppression with named local tests. Run affected types, lint and builds, and an isolated browser flow. Do not run a whole suite or run_tests. Hand the exact pushed candidate to Review, then required independent Security and Tests. Do not integrate or deploy.

## Limits

The action edits the live logical database and its ordinary replicas and merge inputs. Previously exported files, encrypted historical backups and copies outside the database are not rewritten. No live server is accessed for this task. The adjacent password vault is offered only if present in the checked base.
