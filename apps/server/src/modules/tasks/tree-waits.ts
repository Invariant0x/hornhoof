import type { FactTask, TreeAgent, TreeFacts, TreeLine } from './tree.js';
import { countedSegments, turnSegments, type FactTurn } from './tree-programs.js';

export type TreeWait = { agent: TreeAgent; waitsForAgent: TreeAgent; from: string; kind: 'stall' | 'after'; taskId: string; number: number; title: string };
type WaitTask = Pick<TreeLine, 'taskId' | 'number' | 'title'>;

export type WaitSpan = TreeWait & { to: string | null };
type Window = { from: number; to: number | null };

/* Who acts on a task: whoever holds it, else whoever carries it out. */
export function taskActor(task: Pick<FactTask, 'assigneeAgentId' | 'executorAgentId'>): string | null {
  return task.assigneeAgentId ?? task.executorAgentId ?? null;
}

function externalStart(facts: TreeFacts, agentId: string, now: Date): number {
  const waits = facts.tasks.filter(t => taskActor(t) === agentId && t.externalWait && t.externalWait.until > now.toISOString());
  return Math.min(Infinity, ...waits.map(t => Date.parse(t.externalWait!.since)));
}

function idleWindows(turns: FactTurn[], agentId: string, from: number, now: number): Window[] {
  const out: Window[] = [];
  let cursor = from;
  const own = turns.filter(t => t.agentId === agentId && t.createdAt.getTime() <= now).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const turn of own) {
    const start = turn.createdAt.getTime(), end = turn.finishedAt?.getTime() ?? now;
    if (start > cursor) out.push({ from: cursor, to: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < now) out.push({ from: cursor, to: null });
  return out;
}

function problemWindows(facts: TreeFacts, agent: TreeAgent, now: Date): Window[] {
  const segments = (facts.turns ?? []).filter(t => t.agentId === agent.id).flatMap(t => turnSegments(t, agent));
  const external = externalStart(facts, agent.id, now);
  return countedSegments(segments, now).filter(s => s.kind === 'lost' || s.kind === 'alarm').map(s => ({
    from: Date.parse(s.from), to: s.to ? Math.min(Date.parse(s.to), external) : Number.isFinite(external) ? external : null,
  }));
}

function waitSlices(window: Window, problems: Window[], now: number): Window[] {
  return problems.filter(p => p.from < (window.to ?? now) && (p.to ?? now) > window.from).map((p, i) => ({
    from: i === 0 ? window.from : Math.max(window.from, p.from),
    to: p.to === null && window.to === null ? null : Math.min(p.to ?? now, window.to ?? now),
  }));
}

function waitFor(facts: TreeFacts, agent: TreeAgent, upstream: string | null, from: string, kind: TreeWait['kind'], task: WaitTask, now: Date): WaitSpan[] {
  const head = facts.agents.find(a => a.id === upstream);
  if (!head || head.id === agent.id) return [];
  const end = externalStart(facts, agent.id, now), problems = problemWindows(facts, head, now);
  return idleWindows(facts.turns ?? [], agent.id, Date.parse(from), now.getTime())
    .map(w => ({ ...w, to: end < (w.to ?? Infinity) ? end : w.to }))
    .flatMap(w => waitSlices(w, problems, now.getTime()))
    .filter(w => (w.to ?? now.getTime()) > w.from)
    .map(w => ({ agent, waitsForAgent: { id: head.id, name: head.name }, from: new Date(w.from).toISOString(), to: w.to === null ? null : new Date(w.to).toISOString(), kind, taskId: task.taskId, number: task.number, title: task.title }));
}

function finishedWait(facts: TreeFacts, line: TreeLine, now: Date): WaitSpan[] {
  const end = line.mergedAt ?? line.doneAt;
  if (!end || !line.part) return [];
  const parent = facts.tasks.find(t => t.id === line.part!.id);
  return parent ? waitFor(facts, line.agent, taskActor(parent), end, 'stall', line, now) : [];
}

function dependencyWait(facts: TreeFacts, line: TreeLine, now: Date): WaitSpan[] {
  return line.waitsFor.flatMap(number => {
    const task = facts.tasks.find(t => t.number === number);
    return task ? waitFor(facts, line.agent, taskActor(task), line.createdAt, 'after', line, now) : [];
  });
}

/* A wait needs an explicit upstream assignment, an idle recipient, and that upstream's recorded problem. Finished waits remain in history. */
export function waitingAgents(facts: TreeFacts, lines: TreeLine[], now: Date): WaitSpan[] {
  const candidates = lines.flatMap(line => [...finishedWait(facts, line, now), ...dependencyWait(facts, line, now)]);
  const spans = new Map<string, WaitSpan>();
  for (const wait of candidates.sort((a, b) => b.from.localeCompare(a.from))) spans.set(`${wait.agent.id}:${wait.waitsForAgent.id}:${wait.to}`, wait);
  return [...spans.values()];
}
