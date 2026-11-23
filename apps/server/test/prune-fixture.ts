import { eq } from 'drizzle-orm';
import { tasks, turns } from '../src/db/schema.js';
import { fixture } from './development-echelons-fixture.js';
import { serve, type Repository } from './turn-release-fixture.js';

/* #1964: Hornhoof prunes the branches of a company's repositories by its own records and what the repository says. The
   history in these tests: main goes M1, M2; the open turn goes on from M2 with T1; the work of closed tasks that nothing
   holds stands apart at U1. */
export const DAY = 86_400_000;
export const sha = (c: string) => c.repeat(40);
export const M1 = sha('1'), M2 = sha('2'), T1 = sha('3'), U1 = sha('4'), U2 = sha('5');
export const HOLDS: Record<string, string[]> = { [M2]: [M1], [T1]: [M2, M1], [U1]: [M1], [U2]: [M1] };

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function withTask(f: Fixture, title: string, change: { status?: string; closedDaysAgo?: number; paused?: boolean }) {
  const { task } = await f.create({ title });
  const set = {
    ...(change.status ? { status: change.status as 'done' } : {}),
    ...(change.closedDaysAgo !== undefined ? { closedAt: new Date(Date.now() - change.closedDaysAgo * DAY) } : {}),
    ...(change.paused ? { paused: { at: new Date().toISOString(), reason: 'waiting', by: { agentId: f.head.id }, root: task.id } } : {}),
  };
  if (Object.keys(set).length) await f.db.update(tasks).set(set).where(eq(tasks.id, task.id));
  return task.number;
}

/* A repository that takes a push as a host does, for the ref changes of a prune: a branch goes only from the head the push names,
   and a ref under refs/hornhoof/ is made only where none stands. */
export function takingPrunes(f: Fixture, repo: Repository) {
  const archived: Record<string, string> = {};
  const pushed: { ref: string; old: string | null; next: string | null }[] = [];
  f.ctx.pushRefs = async (_repo, updates) => {
    const refs: Record<string, string | null> = {};
    for (const update of updates) {
      pushed.push(update);
      const { ref, old, next } = update;
      if (ref.startsWith('refs/hornhoof/')) {
        refs[ref] = next && archived[ref] === undefined ? null : 'already there';
        if (refs[ref] === null) archived[ref] = next!;
        continue;
      }
      const branch = ref.slice('refs/heads/'.length);
      refs[ref] = repo.heads[branch] === old ? null : 'stale info';
      if (refs[ref] === null && next === null) delete repo.heads[branch];
    }
    return { refs };
  };
  return { archived, pushed };
}

export async function company() {
  const f = await fixture();
  const [turn] = await f.db.select().from(turns).where(eq(turns.companyId, f.task.companyId));
  const branch = `turn-${turn!.number}`;
  const repo: Repository = { heads: { main: M2, [branch]: T1 }, tags: {}, holds: HOLDS, between: {}, cut: new Set() };
  serve(f.ctx, repo);
  return { ...f, repo, branch, ...takingPrunes(f, repo) };
}

