# Server import boundaries

Task 1369 starts at 4ad5de5820d6c8d9a537addf84930816ee585753. The runtime import graph contains one cyclic component of 96 files. Reproduce the measurement with `node scripts/server-imports.mjs`; it parses static value imports and reexports, excluding type-only imports and dynamic imports. The named check is `node --test scripts/test/server-imports.test.mjs`.

Keep behavior, database records, transaction boundaries, public entry points and lock identities unchanged. There is no schema change. Existing responsibility handoff already belongs to `tracker/handoff.ts`, rather than startup upgrade code.

Cut dependencies from the leaves inward:

- Task types, state queries and event writes belong below task commands and tracker edits. Move their existing implementations to focused modules and import their actual owner at runtime. Preserve the engine entry points for existing callers while moving internal consumers off its facade.
- Job lookup and test-run constants belong below dispatchers. Repository reads must not pull in department operations.
- Conversation insertion and claiming remain with the queue. Placement, session recovery and outgoing packet assembly get explicit typed functions in separate modules; they consume data and narrow callbacks rather than importing the queue back.
- Decision input and dispatch keep separate maps and identities, with both calling the protocol's `inLane` implementation.

First run existing named queue, task, tracker, decision and offboarding tests as characterization evidence. Make structural changes in small commits, rerunning their affected files. Add a runtime import cycle check that fails on the starting graph and passes when cycles are removed. Run server types, lint, release checks and own code/security review on the final candidate before fast-forward integration into the open turn branch.

The main risk is changing the order of writes, wakes or lock acquisition while extracting code. Move existing bodies without altering their order, and use existing concurrency and recorded delivery tests to check it. New imports must point downward; replacing a static cycle with a dynamic import is not a fix.
