import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { createTask, updateTask } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import type { CodeLine, Counts } from './apply.js';
import { queryOf } from './leader.js';
import type { Path } from './plan.js';
import { ceos } from './rules.js';
import { rangeWords, timeWords } from './words.js';

/* How many conflicts a task's text holds; the tool lists the rest. */
const LISTED = 100;
const NUMBERED: Record<string, (here: number, was: number, label: string) => string> = {
  tasks: (here, was, label) => `Task #${here} here was #${was} on ${label}.`,
  turns: (here, was, label) => `Turn ${here} here was ${was} on ${label}.`,
  test_runs: (here, was, label) => `Test run ${here} here was ${was} on ${label}.`,
  notebook_notes: (here, was, label) => `Note ${here} here was ${was} on ${label}.`,
};

type MergeRow = { id: string; label: string; path: Path | null; counts: Partial<Counts>; code: CodeLine[]; from_at: string | Date | null; to_at: string | Date | null; task_id: string | null };
type ConflictRow = { tbl: string; why: string; task_id: string | null };

const dateOf = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));
const listed = (labels: string[]): string => (labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`);
const did = (path: Path | null): string => (path === 'compare' ? 'held' : 'did while apart');

/* A task's title is stored text every reader sees alike, so its times are UTC. */
export function titleOf(merges: { label: string; path: Path | null; from: Date | null; to: Date | null }[]): string {
  if (merges.length !== 1) return `Bring back what ${listed(merges.map(merge => merge.label))} did while apart`;
  const [merge] = merges;
  const range = merge!.from && merge!.to ? ` (${rangeWords(merge!.from, merge!.to)})` : '';
  return `Bring back what ${merge!.label} ${did(merge!.path)}${range}`;
}

async function mergesOf(db: Db, ids: string[]): Promise<MergeRow[]> {
  return queryOf(db)<MergeRow>(
    'SELECT id, label, path, counts, code, from_at, to_at, task_id FROM net.merges WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) ORDER BY created_at, source',
    [JSON.stringify(ids)],
  );
}

/* The rows a merge wrote under another number than the source gave them, as sentences. */
async function renumbered(db: Db, merge: MergeRow): Promise<string[]> {
  const q = queryOf(db);
  const rows = await q<{ tbl: string; key: { id?: string }; was: { number?: number } | null }>("SELECT tbl, key, was FROM net.merge_rows WHERE merge = $1::uuid AND how = 'rewritten' AND 'number' = ANY(cols) ORDER BY tbl", [merge.id]);
  const lines: string[] = [];
  for (const row of rows) {
    const say = NUMBERED[row.tbl];
    if (!say || !row.key.id || typeof row.was?.number !== 'number') continue;
    const [here] = await q<{ number: number }>(`SELECT number FROM public."${row.tbl}" WHERE id = $1::uuid`, [row.key.id]);
    if (here) lines.push(say(here.number, row.was.number, merge.label));
  }
  return lines;
}

/* Where the source's work on each task with code lies, by the task's number here. */
async function codeLines(db: Db, merge: MergeRow): Promise<string[]> {
  const q = queryOf(db);
  const lines: string[] = [];
  for (const code of merge.code ?? []) {
    const [here] = await q<{ number: number }>('SELECT number FROM public.tasks WHERE id = $1::uuid', [code.task]);
    const where = code.machines.map(machine => `on ${machine.name} until ${timeWords(new Date(machine.at))}`).join('; ');
    lines.push(`Task #${here?.number ?? code.number} was worked on as ${code.branch}${where ? ` ${where}` : ''}.`);
  }
  return lines;
}

/* What a merge brought back and what it left to settle, in plain words, from the leader's own records alone: the source
   may be gone by now. The task summarizes work conflicts, with a count of the conflicts on the CEO's screen. */
export async function bodyOf(db: Db, mergeIds: string[]): Promise<string> {
  const q = queryOf(db);
  const parts: string[] = [];
  const merges = await mergesOf(db, mergeIds);
  const open = await q<ConflictRow & { merge: string }>(
    'SELECT merge, tbl, why, task_id FROM net.merge_conflicts WHERE picked IS NULL AND merge IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) ORDER BY task_id NULLS LAST, tbl, created_at, id',
    [JSON.stringify(mergeIds)],
  );
  const mine = open.filter(conflict => !ceos(conflict.tbl));
  for (const merge of merges) {
    const [from, to] = [dateOf(merge.from_at), dateOf(merge.to_at)];
    const when = from && to ? ` from ${rangeWords(from, to)}` : '';
    parts.push(`What ${merge.label} ${merge.path === 'compare' ? 'held' : 'did'}${when} is brought back as far as its records prove.`);
    const counts = merge.counts ?? {};
    parts.push(`Added ${counts.added ?? 0}, changed ${counts.changed ?? 0}, removed ${counts.deleted ?? 0}.`);
    const numbers = await renumbered(db, merge);
    if (numbers.length > 0) parts.push(['Numbers that were taken here:', ...numbers].join('\n'));
    const code = await codeLines(db, merge);
    if (code.length > 0) parts.push(['Code:', ...code].join('\n'));
  }
  parts.push(`To settle: ${mine.length} for you; ${open.length - mine.length} for the CEO (people, access, plans, machines or protected records), which wait on his screen.`);
  if (mine.length > 0) {
    const tasks = new Map<string, string>();
    const ids = [...new Set(mine.flatMap(conflict => conflict.task_id ?? []))];
    if (ids.length > 0) {
      for (const task of await q<{ id: string; number: number; title: string }>('SELECT id, number, title FROM public.tasks WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(ids)])) {
        tasks.set(task.id, `Task #${task.number} "${task.title.slice(0, 200)}"`);
      }
    }
    const lines: string[] = [];
    let under = '';
    for (const conflict of mine.slice(0, LISTED)) {
      const head = `${(conflict.task_id && tasks.get(conflict.task_id)) || 'No task'}, ${conflict.tbl}:`;
      if (head !== under) lines.push((under = head));
      lines.push(`  ${conflict.why}`);
    }
    if (mine.length > LISTED) lines.push(`and ${mine.length - LISTED} more; merge_conflicts lists them.`);
    parts.push(lines.join('\n'));
  }
  parts.push(
    'What to do: read the conflicts with merge_conflicts and settle each with merge_pick (here keeps what this company has now, there takes the other side, value writes yours). ' +
      'Move the code of the tasks named above onto their branches here. Tell the holders of the tasks that changed. Then report to the CEO what was kept and what he decided.',
  );
  return parts.join('\n\n');
}

/* The orchestrator's one task for a merge's conflicts, renumbered rows and code: made by him for himself, or the open
   one of an earlier merge, which this merge joins. Null when the merge left him nothing. It throws when no orchestrator
   can take a task now, and is asked again. */
export async function taskFor(ctx: Ctx, mergeId: string): Promise<string | null> {
  const { db } = ctx;
  const q = queryOf(db);
  const [merge] = await mergesOf(db, [mergeId]);
  if (!merge) return null;
  if (merge.task_id) return merge.task_id;
  const open = await q<{ tbl: string }>('SELECT tbl FROM net.merge_conflicts WHERE merge = $1::uuid AND picked IS NULL', [mergeId]);
  const numbers = await renumbered(db, merge);
  if (!open.some(conflict => !ceos(conflict.tbl)) && numbers.length === 0 && (merge.code ?? []).length === 0) return null;
  const [orchestrator] = await q<{ id: string }>("SELECT id FROM public.agents WHERE kind = 'orchestrator' AND removed_at IS NULL LIMIT 1");
  if (!orchestrator) throw new Error('The company has no orchestrator to give the task of a merge to.');
  /* More than two sides merge one at a time into the same task, while it is open. */
  const [joined] = await q<{ task_id: string }>(
    `SELECT m.task_id FROM net.merges m JOIN public.tasks t ON t.id = m.task_id WHERE m.id <> $1::uuid AND t.status NOT IN ('done', 'cancelled') ORDER BY m.created_at DESC LIMIT 1`,
    [mergeId],
  );
  if (joined) {
    const together = [...(await q<{ id: string }>('SELECT id FROM net.merges WHERE task_id = $1::uuid ORDER BY created_at, source', [joined.task_id])).map(row => row.id), mergeId];
    const all = await mergesOf(db, together);
    await updateTask(ctx, orchestrator.id, joined.task_id, { title: titleOf(all.map(titled)), body: await bodyOf(db, together) });
    await wakeAll(ctx, [{ agentId: orchestrator.id, taskId: joined.task_id, why: 'assigned' }]);
    return joined.task_id;
  }
  const moved = await createTask(ctx, { agentId: orchestrator.id }, { title: titleOf([titled(merge)]), brief: '', body: await bodyOf(db, [mergeId]), departmentId: null, assigneeAgentId: orchestrator.id });
  await wakeAll(ctx, moved.wakes);
  return moved.task.id;
}

const titled = (merge: MergeRow) => ({ label: merge.label, path: merge.path, from: dateOf(merge.from_at), to: dateOf(merge.to_at) });
