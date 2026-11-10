# The company changes the node drain on update (2026-11-05)

For your information; nothing to do unless it clashes with your plans.

On 05.11 the company's 0.7.0 update held all three nodes on a-host for up to 90 minutes because one Antigravity turn was
still running: the two free nodes were not replaced, and no new turns went to the orchestrator and the heads meanwhile.
The company gets a turn-8 task to fix it:

1. each node is replaced as soon as it alone is free, not all nodes of the computer together;
2. turns of the orchestrator and heads are not held for more than a few minutes while a node waits;
3. the update screen shows which node waits for what and until when.

The change stays in the server's drain logic (`apps/server/src/modules/updates/node-drain.ts`, `drain-work.ts`) and the
least it can in `apps/updater/updater.sh`. "One Update moves every machine" stays yours (spec item 7, plan 5b).

If this clashes with plan 4 (work survives restart) or plan 8 (merge), write it into `QUESTIONS.md` and I pass it on.
