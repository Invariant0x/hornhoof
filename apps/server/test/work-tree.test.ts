import { emptyEchelonFindings, type EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { describe, expect, it } from 'vitest';
import { agentTime, workTree, type DepartmentTree, type TreeFacts, type TreeLine } from '../src/modules/tasks/tree.js';

const T0 = Date.parse('2026-05-01T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const iso = (minutes: number): string => at(minutes).toISOString();

type TaskInput = Omit<TreeFacts['tasks'][number], 'echelons' | 'echelonFindings' | 'ownerSince'> & Partial<Pick<TreeFacts['tasks'][number], 'echelons' | 'echelonFindings' | 'ownerSince'>>;

/* Pure rendering inputs carry a canonical route, without claiming an executed engine acceptance. */
function taskFact(input: TaskInput): TreeFacts['tasks'][number] {
  const closed = input.status === 'done' || input.status === 'cancelled';
  const stage = input.executorAgentId ? (input.status === 'review' ? 'review' : 'development') : null;
  const ownerAgentId = closed ? null : input.assigneeAgentId ?? input.executorAgentId;
  const echelons: EchelonsSnapshot = { kind: 'development_echelons', version: 1, revision: 1, resultKind: stage ? 'code' : 'coordination', stage,
    phase: closed ? 'done' : 'active', ownerAgentId, candidateId: null, assignment: null,
    security: { required: false, reason: null, addedBy: null }, stages: stage ? [
      { stage: 'architecture', status: 'skipped', ownerAgentId: null, inputCandidateId: null, candidateId: null, reason: 'small_task' },
      { stage: 'development', status: closed || stage === 'review' ? 'complete' : 'active', ownerAgentId: input.executorAgentId, inputCandidateId: null, candidateId: null, reason: null },
      { stage: 'review', status: closed ? 'complete' : stage === 'review' ? 'active' : 'pending', ownerAgentId: stage === 'review' ? ownerAgentId : null, inputCandidateId: null, candidateId: null, reason: null },
      { stage: 'security', status: 'skipped', ownerAgentId: null, inputCandidateId: null, candidateId: null, reason: 'no_declared_risk' },
      { stage: 'tests', status: closed ? 'complete' : 'pending', ownerAgentId: null, inputCandidateId: null, candidateId: null, reason: null },
    ] : [] };
  return { echelons, echelonFindings: emptyEchelonFindings(), ownerSince: input.createdAt, ...input };
}

function baseFacts(overrides: Partial<Omit<TreeFacts, 'tasks'>> & { tasks?: TaskInput[] } = {}): TreeFacts {
  return {
    repository: true,
    turn: { id: 'turn-3', number: 3, createdAt: at(0), openedAt: at(0) },
    agents: [
      { id: 'head', name: 'Nika', createdAt: at(-60) },
      { id: 'mira', name: 'Mira', createdAt: at(-50) },
      { id: 'timur', name: 'Timur', createdAt: at(-40) },
      { id: 'eva', name: 'Eva', createdAt: at(-30) },
      { id: 'ostap', name: 'Ostap', createdAt: at(-20) },
      { id: 'vera', name: 'Vera', createdAt: at(-15) },
      { id: 'gleb', name: 'Gleb', createdAt: at(-10) },
      { id: 'rita', name: 'Rita', createdAt: at(-5) },
    ],
    related: [],
    events: [],
    requests: [],
    signs: [],
    jobs: [],
    ...overrides,
    tasks: (overrides.tasks ?? []).map(taskFact),
  };
}

function assertCoversWithoutGaps(line: TreeLine, nowIso: string): void {
  const expectedEnd = line.mergedAt ?? line.doneAt ?? null;
  expect(line.segments.length).toBeGreaterThan(0);
  expect(line.segments[0]!.from).toBe(line.ownerSince);
  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i]!;
    const segEnd = seg.to ?? nowIso;
    expect(Date.parse(segEnd)).toBeGreaterThanOrEqual(Date.parse(seg.from));
    if (i < line.segments.length - 1) {
      expect(seg.to).not.toBeNull();
      expect(seg.to).toBe(line.segments[i + 1]!.from);
    } else {
      expect(seg.to).toBe(expectedEnd);
    }
  }
}

function assertAllLinesCovered(tree: DepartmentTree): void {
  for (const line of tree.lines) assertCoversWithoutGaps(line, tree.now);
}

function waitingFacts(): TreeFacts {
  const tasks: TaskInput[] = [
    { id: 'head-task', number: 109, title: 'Whole department turn', status: 'working', parentId: null,
      executorAgentId: null, assigneeAgentId: 'head', after: [], inRepository: true, createdAt: at(0), closedAt: null },
    { id: 'mira-task', number: 110, title: 'Checkout', status: 'done', parentId: 'head-task',
      executorAgentId: 'mira', after: [], inRepository: true, createdAt: at(1), closedAt: at(10) },
  ];
  return baseFacts({ tasks, turns: [
    { id: 'head-job', taskId: 'head-task', agentId: 'head', createdAt: at(0), startedAt: at(0), finishedAt: null, status: 'running',
      history: [{ at: at(0), program: { state: 'gone', since: at(0).getTime(), tool: null }, alarm: null }] },
    { id: 'mira-job', taskId: 'mira-task', agentId: 'mira', createdAt: at(1), startedAt: at(1), finishedAt: at(10), status: 'done',
      history: [{ at: at(1), program: { state: 'thinking', since: at(1).getTime(), tool: null }, alarm: null }] },
  ] });
}

describe('workTree', () => {
  it('keeps a quiet idle program ordinary without attributing a problem to its waiting worker', () => {
    const facts = waitingFacts();
    facts.turns![0]!.history[0]!.program!.state = 'idle';
    const tree = workTree(facts, at(40));
    expect(tree.lines.find(line => line.taskId === 'head-task')!.segments).toEqual([
      { kind: 'stall', from: iso(0), to: null, program: { state: 'idle', since: at(0).getTime(), tool: null } },
    ]);
    expect(tree.time.find(time => time.agent.id === 'head')).toMatchObject({ stall: 2400, lost: 0, alarm: 0 });
    expect(tree.waiting).toEqual([]);
    expect(tree.idle.filter(wait => wait.agent.id === 'mira' && wait.waitsForAgent)).toEqual([]);
  });

  it('attributes a recorded idle alarm to its waiting worker and ends the wait when the alarm clears', () => {
    const facts = waitingFacts();
    facts.turns![0]!.history[0]!.program!.state = 'idle';
    const alarm = { reason: 'program_stalled' as const, since: at(0).getTime() };
    facts.turns![0]!.history.push({ at: at(30), program: { state: 'idle', since: at(0).getTime(), tool: null }, alarm });
    const tree = workTree(facts, at(40));
    expect(tree.waiting).toEqual([
      { agent: { id: 'mira', name: 'Mira' }, waitsForAgent: { id: 'head', name: 'Nika' }, from: iso(10), kind: 'stall', taskId: 'mira-task', number: 110, title: 'Checkout' },
    ]);
    expect(tree.time.find(time => time.agent.id === 'head')).toMatchObject({ alarm: 2400, lost: 0 });
    facts.turns![0]!.history.push({ at: at(35), program: { state: 'idle', since: at(0).getTime(), tool: null }, alarm: null });
    const cleared = workTree(facts, at(40));
    expect(cleared.waiting).toEqual([]);
    expect(cleared.idle).toContainEqual(expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, from: iso(10), to: iso(35), waitsForAgent: { id: 'head', name: 'Nika' } }));
  });

  it('shows an explicit external wait as ordinary waiting until its deadline', () => {
    const externalWait = { reason: 'Image build', since: iso(20), until: iso(60) };
    const facts = baseFacts({ tasks: [{ id: 't1', number: 1, title: 'Checkout', status: 'working', parentId: null, executorAgentId: 'head', after: [],
      inRepository: true, createdAt: at(0), closedAt: null, externalWait }], turns: [{ id: 'j1', taskId: 't1', agentId: 'head', createdAt: at(0), startedAt: at(0), finishedAt: null,
      status: 'running', history: [{ at: at(0), program: { state: 'thinking', since: at(0).getTime(), tool: null }, alarm: null }] }] });
    const tree = workTree(facts, at(40));
    expect(tree.lines[0]!.segments.at(-1)).toEqual({ kind: 'after', from: iso(20), to: null, externalWait });
    expect(tree.time[0]).toMatchObject({ work: 1200, after: 1200, lost: 0, alarm: 0 });
    facts.turns![0]!.history[0]!.program!.state = 'idle';
    facts.tasks.push(taskFact({ id: 'finished-child', number: 2, title: 'Finished child', status: 'done', parentId: 't1', executorAgentId: 'mira', after: [], inRepository: true, createdAt: at(1), closedAt: at(10) }));
    expect(workTree(facts, at(40)).waiting).toEqual([]);
  });

  it('counts a checked-result message queued for the head separately from the finished worker', () => {
    const facts = waitingFacts();
    facts.turns![0]!.taskId = null;
    facts.turns!.push({ id: 'checked-message', taskId: 'mira-task', agentId: 'head', createdAt: at(20), startedAt: null, finishedAt: null, status: 'queued', history: [] });
    const tree = workTree(facts, at(40));
    expect(tree.activity).toContainEqual(expect.objectContaining({ jobId: 'head-job', agent: { id: 'head', name: 'Nika' }, task: null, segments: [expect.objectContaining({ kind: 'lost', from: iso(0), to: null })] }));
    expect(tree.activity).toContainEqual(expect.objectContaining({ jobId: 'checked-message', task: { id: 'mira-task', number: 110, title: 'Checkout' } }));
    expect(tree.time.find(t => t.agent.id === 'head')).toMatchObject({ lost: 2400, queued: 1200 });
    expect(tree.waiting.find(w => w.agent.id === 'mira')).toMatchObject({ waitsForAgent: { id: 'head', name: 'Nika' }, from: iso(10), taskId: 'mira-task' });
  });

  it('names the head a finished worker is waiting for, from the time its own work ended', () => {
    const facts = waitingFacts();
    const tree = workTree(facts, at(40));
    expect(tree.waiting).toEqual([{ agent: { id: 'mira', name: 'Mira' }, waitsForAgent: { id: 'head', name: 'Nika' }, from: iso(10), kind: 'stall', taskId: 'mira-task', number: 110, title: 'Checkout' }]);
    expect(tree.time.find(t => t.agent.id === 'mira')).toMatchObject({ work: 540, stall: 1800, lost: 0 });
    facts.turns![0]!.history.push({ at: at(35), program: { state: 'thinking', since: at(35).getTime(), tool: null }, alarm: null });
    const resumed = workTree(facts, at(40));
    expect(resumed.waiting).toEqual([]);
    expect(resumed.idle).toContainEqual(expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, from: iso(10), to: iso(35), waitsForAgent: { id: 'head', name: 'Nika' } }));
    expect(resumed.time.find(t => t.agent.id === 'mira')).toMatchObject({ stall: 1500 });
    facts.turns!.push({ id: 'next-mira-job', taskId: null, agentId: 'mira', createdAt: at(20), startedAt: at(20), finishedAt: null, status: 'running', history: [] });
    expect(workTree(facts, at(40)).waiting).toEqual([]);
    facts.turns!.at(-1)!.finishedAt = at(25);
    facts.turns!.at(-1)!.status = 'done';
    facts.turns![0]!.history.push({ at: at(40), program: { state: 'gone', since: at(40).getTime(), tool: null }, alarm: null });
    const later = workTree(facts, at(60));
    expect(later.waiting).toEqual([expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, from: iso(40) })]);
    expect(later.idle.filter(i => i.agent.id === 'mira' && i.waitsForAgent).map(i => [i.from, i.to])).toEqual([
      [iso(40), null], [iso(25), iso(35)], [iso(10), iso(20)],
    ]);
    expect(later.time.find(t => t.agent.id === 'mira')).toMatchObject({ stall: 2400 });
  });

  it('does not assign a future upstream problem to an earlier free interval, regardless of job order', () => {
    const facts = waitingFacts();
    facts.turns![0]!.history = [
      { at: at(0), program: { state: 'thinking', since: at(0).getTime(), tool: null }, alarm: null },
      { at: at(30), program: { state: 'gone', since: at(30).getTime(), tool: null }, alarm: null },
    ];
    for (const [start, end] of [[20, 40], [50, 55]]) facts.turns!.push({ id: `next-${start}`, agentId: 'mira', taskId: null,
      createdAt: at(start!), startedAt: at(start!), finishedAt: at(end!), status: 'done', history: [] });
    facts.turns!.reverse();
    const tree = workTree(facts, at(60));
    expect(tree.waiting).toEqual([expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, from: iso(55) })]);
    expect(tree.idle.filter(i => i.agent.id === 'mira' && i.waitsForAgent).map(i => [i.from, i.to])).toEqual([[iso(55), null], [iso(40), iso(50)]]);
    expect(tree.time.find(t => t.agent.id === 'mira')).toMatchObject({ stall: 900 });
  });

  it('ends an idle wait when a new job is queued at the current instant', () => {
    const facts = waitingFacts();
    facts.turns!.push({ id: 'new-now', agentId: 'mira', taskId: null, createdAt: at(40), startedAt: null, finishedAt: null, status: 'queued', history: [] });
    const tree = workTree(facts, at(40));
    expect(tree.waiting).toEqual([]);
    expect(tree.idle).toContainEqual(expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, from: iso(10), to: iso(40), waitsForAgent: { id: 'head', name: 'Nika' } }));
  });

  it('names the actual prerequisite and keeps another employee external wait independent', () => {
    const task = (id: string, number: number, executorAgentId: string, created: number): TaskInput => ({
      id, number, executorAgentId, title: id, status: 'working', parentId: null, after: [], inRepository: true, createdAt: at(created), closedAt: null,
    });
    const facts = baseFacts({ tasks: [task('unrelated', 1, 'head', 0), task('upstream', 2, 'timur', 0),
      { ...task('waiting', 3, 'mira', 10), status: 'waiting', after: ['upstream'] },
      { ...task('external', 4, 'ostap', 5), externalWait: { reason: 'Image build', since: iso(15), until: iso(60) } },
    ], turns: [{ id: 'timur-job', agentId: 'timur', taskId: 'upstream', createdAt: at(0), startedAt: at(0), finishedAt: null, status: 'running',
      history: [{ at: at(0), program: { state: 'gone', since: at(0).getTime(), tool: null }, alarm: null }] }] });
    const expected = [expect.objectContaining({ agent: { id: 'mira', name: 'Mira' }, waitsForAgent: { id: 'timur', name: 'Timur' }, from: iso(10), kind: 'after', taskId: 'waiting', number: 3 })];
    expect(workTree(facts, at(40)).waiting).toEqual(expected);
    facts.tasks[1]!.externalWait = { reason: 'Earlier wait', since: iso(20), until: iso(40) };
    expect(workTree(facts, at(40)).waiting).toEqual(expected);
  });

  it('keeps hidden agents, hidden task turns and earlier-turn tasks out of unlinked activity', () => {
    const task = (id: string, number: number, executorAgentId: string, visible: boolean): TaskInput => ({
      id, number, executorAgentId, visible, title: id, status: 'working', parentId: null, after: [], inRepository: true, createdAt: at(0), closedAt: null,
    });
    const job = (id: string, agentId: string, taskId: string | null): NonNullable<TreeFacts['turns']>[number] => ({ id, agentId, taskId,
      createdAt: at(0), startedAt: at(0), finishedAt: null, status: 'running',
      history: [{ at: at(0), program: { state: 'thinking', since: at(0).getTime(), tool: null }, alarm: null }] });
    const facts = baseFacts({ tasks: [task('visible', 1, 'mira', true), task('hidden-agent-task', 2, 'timur', false), task('hidden-mira-task', 3, 'mira', false)],
      turns: [job('visible-unlinked', 'mira', null), job('hidden-agent', 'timur', 'hidden-agent-task'),
        job('hidden-task', 'mira', 'hidden-mira-task'), job('outside-this-turn', 'mira', 'earlier-task')] });
    const tree = workTree(facts, at(40));
    expect(tree.lines.map(l => l.taskId)).toEqual(['visible']);
    expect(tree.activity.map(a => a.jobId)).toEqual(['visible-unlinked']);
    expect(tree.time.map(t => t.agent.id)).toEqual(['mira']);
    expect(tree.time[0]).toMatchObject({ work: 2400 });
  });

  it('shows a newly assigned task before any time or program report has arrived', () => {
    const facts = waitingFacts();
    facts.tasks = [facts.tasks[0]!];
    facts.turns = [];
    const tree = workTree(facts, at(0));
    expect(tree.lines[0]!.segments).toEqual([{ kind: 'unknown', from: iso(0), to: null }]);
  });

  it.each(['work', 'after', 'person', 'stall', 'lost', 'alarm', 'queued', 'unknown'] as const)('rounds %s elapsed time without phantom milliseconds', kind => {
    for (const [ms, expected] of [[499, 0], [500, 1]]) {
      const zero = { work: 0, after: 0, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 0 };
      const end = new Date(at(0).getTime() + ms!);
      const totals = agentTime(baseFacts().agents, [{ agentId: 'head', segments: [{ kind, from: iso(0), to: end.toISOString() }] }], at(0), end);
      expect(totals[0]).toMatchObject({ ...zero, [kind]: expected });
    }
  });

  it('does not make activity from a turn cancelled before it started with no elapsed time or program evidence', () => {
    const facts = baseFacts({ tasks: [{ id: 'r90', number: 90, title: 'Review', status: 'review', parentId: null,
      executorAgentId: 'head', after: [], inRepository: true, createdAt: at(10), closedAt: null }],
      turns: [{ id: 'never-started', agentId: 'head', taskId: null, createdAt: at(10), startedAt: null, finishedAt: at(10), status: 'failed', history: [] }] });
    expect(workTree(facts, at(40)).activity).toEqual([]);
  });

  it('keeps the department head assignment even when it has no member executor', () => {
    const tree = workTree(baseFacts({ tasks: [{ id: 'head-task', number: 109, title: 'Whole department turn', status: 'working', parentId: null,
      executorAgentId: null, assigneeAgentId: 'head', after: [], inRepository: true, createdAt: at(0), closedAt: null }] }), at(40));
    expect(tree.lines.map(l => [l.number, l.agent.id])).toEqual([[109, 'head']]);
  });

  it('counts one agent minute once when multiple task lifetimes overlap', () => {
    const tasks = [1, 2].map(n => ({ id: `t${n}`, number: n, title: 'Checkout', status: 'working' as const, parentId: null,
      executorAgentId: 'head', after: [], inRepository: true, createdAt: at(0), closedAt: null }));
    const tree = workTree(baseFacts({ tasks, turns: [{ id: 'j1', taskId: 't1', agentId: 'head', createdAt: at(0), startedAt: at(0), finishedAt: null, status: 'running',
      history: [{ at: at(0), program: { state: 'thinking', since: at(0).getTime(), tool: null }, alarm: null }] }] }), at(40));
    expect(tree.time[0]).toMatchObject({ work: 2400, unknown: 0 });
  });

  it.each(['thinking', 'tool'] as const)('counts forty minutes of reported %s as work, not silence', state => {
    const facts = baseFacts({
      tasks: [{ id: 't1', number: 1, title: 'Checkout', status: 'working', parentId: null, executorAgentId: 'head', after: [], inRepository: true, createdAt: at(0), closedAt: null }],
      turns: [{ id: 'j1', taskId: 't1', agentId: 'head', createdAt: at(0), startedAt: at(0), finishedAt: null, status: 'running',
        history: [{ at: at(0), program: { state, since: at(0).getTime(), tool: state === 'tool' ? 'Bash' : null }, alarm: null }] }],
    });
    const tree = workTree(facts, at(40));
    expect(tree.lines[0]!.segments).toEqual([{ kind: 'work', from: iso(0), to: null, program: { state, since: at(0).getTime(), tool: state === 'tool' ? 'Bash' : null } }]);
    expect(tree.time[0]).toMatchObject({ work: 2400, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 0 });
  });

  it('uses an old proven alarm for the four-hour lost interval and counts queued task messages separately', () => {
    const start = new Date('2026-11-03T06:10:00.000Z'), stopped = new Date('2026-11-03T10:33:35.000Z');
    const since = Date.parse('2026-11-03T06:11:06.000Z');
    const queued = ['2026-11-03T06:13:00.000Z', '2026-11-03T06:35:00.000Z'];
    const facts = baseFacts({
      turn: { id: 'turn-4', number: 4, createdAt: start, openedAt: start },
      tasks: [0, 1, 2].map(i => ({ id: `t${i}`, number: i === 0 ? 109 : i === 1 ? 90 : 95, title: 'Work', status: 'working', parentId: null,
        executorAgentId: 'head', after: [], inRepository: true, createdAt: i ? new Date(queued[i - 1]!) : start, closedAt: null })),
      turns: [
        { id: 'c7c49849', taskId: 't0', agentId: 'head', createdAt: start, startedAt: start, finishedAt: stopped, status: 'failed',
          history: [{ at: new Date('2026-11-03T06:41:06.000Z'), program: null, alarm: { reason: 'program_stalled', since } }] },
        ...queued.map((time, i) => ({ id: `queued-${i}`, taskId: `t${i + 1}`, agentId: 'head', createdAt: new Date(time), startedAt: null, finishedAt: null, status: 'queued' as const, history: [] })),
      ],
    });
    const tree = workTree(facts, stopped);
    expect(tree.lines[0]!.segments).toContainEqual({ kind: 'alarm', from: new Date(since).toISOString(), to: stopped.toISOString(), alarm: { reason: 'program_stalled', since } });
    expect(tree.time[0]).toMatchObject({ work: 0, stall: 0, alarm: 15749, queued: 29950 });
    expect(tree.lines[1]!.segments[0]).toMatchObject({ kind: 'queued', from: queued[0], waitsForAgent: { id: 'head', name: 'Nika' } });
  });

  it('shows missing historical program evidence as unknown instead of inventing work or a stall', () => {
    const tree = workTree(baseFacts({ tasks: [{ id: 't1', number: 1, title: 'Old work', status: 'working', parentId: null,
      executorAgentId: 'head', after: [], inRepository: false, createdAt: at(0), closedAt: null }] }), at(40));
    expect(tree.lines[0]!.segments).toEqual([{ kind: 'unknown', from: iso(0), to: null }]);
    expect(tree.time[0]).toMatchObject({ work: 0, stall: 0, unknown: 2400 });
  });

  it('keeps unreported history unknown regardless of the gaps between task events, and ignores nudges', () => {
    const facts = baseFacts({
      tasks: [
        {
          id: 't43',
          number: 43,
          title: 'Payment screen',
          status: 'working',
          parentId: null,
          executorAgentId: 'timur',
          after: [],
          inRepository: true,
          createdAt: at(20),
          closedAt: null,
        },
      ],
      events: [
        { taskId: 't43', agentId: 'head', kind: 'created', text: 'Build screen.', data: {}, createdAt: at(20) },
        /* Task events remain visible, but prove no continuous program state. */
        { taskId: 't43', agentId: 'timur', kind: 'comment', text: 'Layout ready.', data: {}, createdAt: at(49) },
        /* Nudges are neither moves nor proof of program state. */
        { taskId: 't43', agentId: null, kind: 'reminded', text: 'Still on it?', data: {}, createdAt: at(65) },
        { taskId: 't43', agentId: null, kind: 'continued', text: 'Continue.', data: {}, createdAt: at(70) },
        { taskId: 't43', agentId: null, kind: 'stuck', text: 'Stuck.', data: {}, createdAt: at(80) },
        /* Moves again at 91 (42 minutes after 49). */
        { taskId: 't43', agentId: 'timur', kind: 'comment', text: 'Card expiry check done.', data: {}, createdAt: at(91) },
      ],
    });

    const tree = workTree(facts, at(110));
    expect(tree.lines).toHaveLength(1);
    const line = tree.lines[0]!;
    expect(line.segments).toEqual([{ kind: 'unknown', from: iso(20), to: null }]);
    expect(line.moves.map(m => m.kind)).toEqual(['created', 'comment', 'comment']);
    assertAllLinesCovered(tree);
  });

  it('keeps lastActionAt without interpreting it as historical program state', () => {
    const facts = baseFacts({
      tasks: [
        {
          id: 't1',
          number: 1,
          title: 'Agent acted later',
          status: 'working',
          parentId: null,
          executorAgentId: 'mira',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: null,
        },
        {
          id: 't2',
          number: 2,
          title: 'Task moved later',
          status: 'blocked',
          parentId: null,
          executorAgentId: 'timur',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: null,
        },
      ],
      events: [
        { taskId: 't1', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't1', agentId: 'mira', kind: 'comment', text: 'Started.', data: {}, createdAt: at(25) },
        { taskId: 't2', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't2', agentId: 'timur', kind: 'blocked', text: 'Missing schema.', data: {}, createdAt: at(50) },
      ],
      signs: [
        { taskId: 't1', agentId: 'mira', at: at(40) },
        { taskId: 't2', agentId: 'timur', at: at(30) },
      ],
      jobs: [
        { taskId: 't1', agentId: 'mira', lastActionAt: at(40), live: true },
        { taskId: 't2', agentId: 'timur', lastActionAt: at(30), live: false },
      ],
    });

    const tree = workTree(facts, at(90));
    const [first, second] = tree.lines;
    expect(first!.segments).toEqual([
      { kind: 'unknown', from: iso(10), to: null },
    ]);
    expect(first!.lastActionAt).toBe(iso(40));
    expect(first!.live).toBe(true);

    expect(second!.segments).toEqual([
      { kind: 'unknown', from: iso(10), to: null },
    ]);
    expect(second!.lastActionAt).toBe(iso(30));
    expect(second!.live).toBe(false);
    assertAllLinesCovered(tree);
  });

  it('draws a wait for a person from request to answer (or to now when open, or next sign when closed unanswered) instead of stall', () => {
    const longQuestion = 'How many days after payment can a customer request a full refund? '.repeat(4);
    const facts = baseFacts({
      tasks: [
        {
          id: 't49',
          number: 49,
          title: 'Refunds on server',
          status: 'waiting',
          parentId: null,
          executorAgentId: 'eva',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: null,
        },
        {
          id: 't51',
          number: 51,
          title: 'Withdrawn question',
          status: 'working',
          parentId: null,
          executorAgentId: 'mira',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: null,
        },
      ],
      events: [
        { taskId: 't49', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't49', agentId: 'eva', kind: 'asked', text: longQuestion, data: {}, createdAt: at(20) },
        { taskId: 't49', agentId: null, kind: 'answered', text: '30 days.', data: {}, createdAt: at(85) },
        { taskId: 't49', agentId: 'eva', kind: 'asked', text: 'Include partial refunds?', data: {}, createdAt: at(100) },
        { taskId: 't51', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't51', agentId: 'mira', kind: 'comment', text: 'Found the answer in docs.', data: {}, createdAt: at(75) },
      ],
      requests: [
        /* 65 minutes waiting for a person is person, not stall. */
        { taskId: 't49', agentId: 'eva', text: longQuestion, status: 'answered', createdAt: at(20), answeredAt: at(85) },
        /* Open request runs to now. */
        { taskId: 't49', agentId: 'eva', text: 'Include partial refunds?', status: 'open', createdAt: at(100), answeredAt: null },
        /* Closed without answeredAt ends at the next sign of life (75). */
        { taskId: 't51', agentId: 'mira', text: 'Need API docs?', status: 'withdrawn', createdAt: at(30), answeredAt: null },
      ],
    });

    const tree = workTree(facts, at(140));
    const evaLine = tree.lines.find(l => l.taskId === 't49')!;
    expect(evaLine.segments).toEqual([
      { kind: 'unknown', from: iso(10), to: iso(20) },
      { kind: 'person', from: iso(20), to: iso(85) },
      { kind: 'unknown', from: iso(85), to: iso(100) },
      { kind: 'person', from: iso(100), to: null },
    ]);
    expect(evaLine.moves[1]!.text).toHaveLength(160);

    const miraLine = tree.lines.find(l => l.taskId === 't51')!;
    expect(miraLine.segments).toEqual([
      { kind: 'unknown', from: iso(10), to: iso(30) },
      { kind: 'person', from: iso(30), to: iso(75) },
      { kind: 'unknown', from: iso(75), to: null },
    ]);

    const answeredIdle = tree.idle.find(i => i.taskId === 't49' && i.kind === 'person' && i.to !== null)!;
    expect(answeredIdle.question).toBe(longQuestion.slice(0, 160));
    expect(answeredIdle.question).toHaveLength(160);
    assertAllLinesCovered(tree);
  });

  it('tracks after until started (cutAt), and keeps cutAt null with waitsFor while still waiting', () => {
    const facts = baseFacts({
      tasks: [
        {
          id: 'p1',
          number: 40,
          title: 'Refunds feature',
          status: 'open',
          parentId: null,
          executorAgentId: null,
          after: [],
          inRepository: true,
          createdAt: at(5),
          closedAt: null,
        },
        {
          id: 't49',
          number: 49,
          title: 'Refund API',
          status: 'done',
          parentId: 'p1',
          executorAgentId: 'eva',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: at(60),
        },
        {
          id: 't50',
          number: 50,
          title: 'Refund button',
          status: 'working',
          parentId: 'p1',
          executorAgentId: 'ostap',
          after: ['t49'],
          inRepository: true,
          createdAt: at(15),
          closedAt: null,
        },
        {
          id: 't52',
          number: 52,
          title: 'Refund receipt',
          status: 'open',
          parentId: 'p1',
          executorAgentId: 'mira',
          after: ['t50'],
          inRepository: true,
          createdAt: at(20),
          closedAt: null,
        },
      ],
      events: [
        { taskId: 't49', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't49', agentId: 'eva', kind: 'report', text: 'Accepted the checked candidate.', data: { acceptedCandidate: { integration: { branch: 'turn-3', commit: 'b'.repeat(40) } } }, createdAt: at(60) },
        { taskId: 't50', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(15) },
        { taskId: 't50', agentId: null, kind: 'started', text: '#49 is done.', data: {}, createdAt: at(60) },
        { taskId: 't52', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(20) },
      ],
    });

    const tree = workTree(facts, at(80));
    const started = tree.lines.find(l => l.taskId === 't50')!;
    expect(started.part).toEqual({ id: 'p1', number: 40, title: 'Refunds feature' });
    expect(started.cutAt).toBe(iso(60));
    expect(started.waitsFor).toEqual([]);
    expect(started.segments).toEqual([
      { kind: 'after', from: iso(15), to: iso(60) },
      { kind: 'unknown', from: iso(60), to: null },
    ]);

    const waiting = tree.lines.find(l => l.taskId === 't52')!;
    expect(waiting.cutAt).toBeNull();
    expect(waiting.waitsFor).toEqual([50]);
    expect(waiting.segments).toEqual([{ kind: 'after', from: iso(20), to: null }]);
    assertAllLinesCovered(tree);
  });

  it('ends a merged line at mergedAt with task branch, and a non-repository done task at doneAt with branch null', () => {
    const facts = baseFacts({
      repository: false,
      tasks: [
        {
          id: 't1',
          number: 42,
          title: 'Payment gateway',
          status: 'done',
          parentId: null,
          executorAgentId: 'mira',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: at(95),
        },
        {
          id: 't2',
          number: 62,
          title: 'Customer list',
          status: 'done',
          parentId: null,
          executorAgentId: 'timur',
          after: [],
          inRepository: false,
          createdAt: at(15),
          closedAt: at(80),
        },
      ],
      events: [
        { taskId: 't1', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
        { taskId: 't1', agentId: 'mira', kind: 'submitted', text: 'Handed in.', data: {}, createdAt: at(85) },
        { taskId: 't1', agentId: 'mira', kind: 'report', text: 'Accepted the checked candidate.', data: { acceptedCandidate: { integration: { branch: 'turn-3', commit: 'b'.repeat(40) } } }, createdAt: at(90) },
        { taskId: 't2', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(15) },
        { taskId: 't2', agentId: 'timur', kind: 'comment', text: 'Halfway.', data: {}, createdAt: at(40) },
        { taskId: 't2', agentId: 'timur', kind: 'report', text: '240 customers.', data: {}, createdAt: at(80) },
      ],
      signs: [{ taskId: 't1', agentId: 'mira', at: at(35) }, { taskId: 't1', agentId: 'mira', at: at(60) }],
    });

    const tree = workTree(facts, at(150));
    const mergedLine = tree.lines.find(l => l.taskId === 't1')!;
    expect(mergedLine.branch).toBe('task-42');
    expect(mergedLine.mergedAt).toBe(iso(90));
    expect(mergedLine.doneAt).toBeNull();
    expect(mergedLine.segments).toEqual([{ kind: 'unknown', from: iso(10), to: iso(90) }]);

    const plainDone = tree.lines.find(l => l.taskId === 't2')!;
    expect(plainDone.branch).toBeNull();
    expect(plainDone.mergedAt).toBeNull();
    expect(plainDone.doneAt).toBe(iso(80));
    expect(plainDone.segments).toEqual([
      { kind: 'unknown', from: iso(15), to: iso(80) },
    ]);
    assertAllLinesCovered(tree);
  });

  it('sums time per agent in seconds across multiple lines in staff createdAt order, and orders idle stretches', () => {
    const facts = baseFacts({
      /* Put agents out of order in facts to verify sorting by createdAt. */
      agents: [
        { id: 'ostap', name: 'Ostap', createdAt: at(-10) },
        { id: 'mira', name: 'Mira', createdAt: at(-50) },
        { id: 'eva', name: 'Eva', createdAt: at(-30) },
        { id: 'timur', name: 'Timur', createdAt: at(-40) },
      ],
      tasks: [
        /* Mira line 1 has no program reports. */
        {
          id: 'm1',
          number: 1,
          title: 'First Mira task',
          status: 'done',
          parentId: null,
          executorAgentId: 'mira',
          after: [],
          inRepository: true,
          createdAt: at(0),
          closedAt: at(20),
        },
        /* Mira line 2: ten minutes waiting for its dependency, then unreported work. */
        {
          id: 'm2',
          number: 2,
          title: 'Second Mira task',
          status: 'working',
          parentId: null,
          executorAgentId: 'mira',
          after: ['m1'],
          inRepository: true,
          createdAt: at(20),
          closedAt: null,
        },
        /* Timur has no historical program evidence. */
        {
          id: 't1',
          number: 3,
          title: 'Timur task',
          status: 'working',
          parentId: null,
          executorAgentId: 'timur',
          after: [],
          inRepository: true,
          createdAt: at(50),
          closedAt: null,
        },
        /* Eva: ended person 25m (10..35), then ongoing person since 85 (15m at now=100). */
        {
          id: 'e1',
          number: 4,
          title: 'Eva task',
          status: 'waiting',
          parentId: null,
          executorAgentId: 'eva',
          after: [],
          inRepository: true,
          createdAt: at(10),
          closedAt: null,
        },
        /* Ostap: ongoing after waiting for #3 since 40 (60m at now=100). */
        {
          id: 'o1',
          number: 5,
          title: 'Ostap task',
          status: 'open',
          parentId: null,
          executorAgentId: 'ostap',
          after: ['t1'],
          inRepository: true,
          createdAt: at(40),
          closedAt: null,
        },
      ],
      events: [
        { taskId: 'm1', agentId: 'mira', kind: 'report', text: 'Accepted the checked candidate.', data: { acceptedCandidate: { integration: { branch: 'turn-3', commit: 'b'.repeat(40) } } }, createdAt: at(20) },
        { taskId: 'm2', agentId: null, kind: 'started', text: 'Started.', data: {}, createdAt: at(30) },
        { taskId: 'm2', agentId: 'mira', kind: 'comment', text: 'Progress.', data: {}, createdAt: at(45) },
        { taskId: 'm2', agentId: 'mira', kind: 'comment', text: 'Back at it.', data: {}, createdAt: at(80) },
        { taskId: 'e1', agentId: 'eva', kind: 'comment', text: 'Working.', data: {}, createdAt: at(60) },
      ],
      requests: [
        { taskId: 'e1', agentId: 'eva', text: 'First question?', status: 'answered', createdAt: at(10), answeredAt: at(35) },
        { taskId: 'e1', agentId: 'eva', text: 'Second question?', status: 'open', createdAt: at(85), answeredAt: null },
      ],
    });

    const tree = workTree(facts, at(100));
    assertAllLinesCovered(tree);

    expect(tree.time).toEqual([
      { agent: { id: 'mira', name: 'Mira' }, work: 0, after: 600, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 5400 },
      { agent: { id: 'timur', name: 'Timur' }, work: 0, after: 0, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 3000 },
      { agent: { id: 'eva', name: 'Eva' }, work: 0, after: 0, person: 2400, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 3000 },
      { agent: { id: 'ostap', name: 'Ostap' }, work: 0, after: 3600, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 0 },
    ]);
    expect(tree.idle.map(i => [i.kind, i.to === null ? 'open' : 'ended', i.number])).toEqual([
      ['person', 'open', 4], ['after', 'open', 5], ['unknown', 'open', 2], ['unknown', 'open', 3],
      ['unknown', 'ended', 4], ['person', 'ended', 4], ['unknown', 'ended', 1], ['after', 'ended', 2],
    ]);
    expect(tree.idle[0]!.question).toBe('Second question?');
    expect(tree.idle[1]!.waitsFor).toEqual([3]);
  });

  it('returns an empty work tree when there is no open turn', () => {
    const tree = workTree(baseFacts({ turn: null, repository: false }), at(10));
    expect(tree).toEqual({
      now: iso(10),
      turn: null,
      repository: false,
      lines: [],
      waiting: [],
      activity: [],
      time: [],
      idle: [],
    });
  });
});
