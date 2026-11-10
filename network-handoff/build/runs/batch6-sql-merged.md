# Batch 6, sql-check slice: what the fix round does

Reports: `network-build/runs/batch6-sql-claude.md` (Claude) and `network-build/runs/batch6-sql-r2-agy.md` (Antigravity). Read both from the top.

## Important
1. Within the tool's 20,000 character limit, a text such as `SELECT 1` followed by `+1` 9,990 times overflows the WASM stack and leaks; after about 39 of them every call throws `memory access out of bounds` until a restart. It fails closed, but the orchestrator loses its database tool with no log line, and looping output has that very shape. Claude's report has the reproduction. Failing test first: 60 such texts, then `SELECT 1` still resolves, and the deep ones are refused with kind `syntax`. Parse where a broken parser can be thrown away: a worker that holds the WASM instance and is replaced after any failure that is not the parser's own `SqlError`. The worker must not keep the process alive, and must work both under vitest and from the built `dist`; show the second, for instance with a small built-output check, or say plainly what you could not show. Log one line when a parser is replaced, with no SQL text in it. Say what a call costs now, and whether a stuck parser can hold a caller for ever: it must not, so give it a bound.

## Minor worth doing here
2. `refusedColumn` refuses an alias named like a function before a star: `SELECT lo_rows.* FROM (SELECT 1) lo_rows`. Look at the last field itself.
3. `entriesOf` walks sibling statements right to left, so `COMMIT; SELECT pg_cancel_backend(1)` reports `function`. Make the first violation in SQL order win.

The deep test depending on which stack gives out first: make it hold on the worker's own limits rather than Node's default.

## Not yours
`REFUSED_FUNCTIONS`'s home: the later writer re-exports it. The rest of Task 3 stays that task's.
