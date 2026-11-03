import type { AgentTime, Department, DepartmentTree, Employee, Org, TreeActivity, TreeAgent, TreeLine, TreeReview, TreeSegment } from '../src/types';
import { ME } from './api';

const at = (clock: string) => `2026-11-03T${clock}:00.000Z`;
const stamp = (clock: string) => Date.parse(at(clock));
const minute = (n: number) => new Date(stamp('00:00') + n * 60_000).toISOString();
const names = ['Hana', 'Bruno', 'Timur', 'Eva', 'Ostap', 'Vera', 'Rita', 'Gleb', 'Sid'];
const actors: TreeAgent[] = names.map((name, i) => ({ id: `a${i}`, name }));
const actor = (name: string) => actors.find(a => a.name === name)!;
const segment = (kind: TreeSegment['kind'], from: string, to: string | null): TreeSegment => ({ kind, from: at(from), to: to ? at(to) : null });

function line(number: number, agent: TreeAgent, from: string, to: string | null, segments: TreeSegment[]): TreeLine {
  return { taskId: `t${number}`, number, title: number === 62 ? 'Night checkout work' : `Checkout step ${number}`, agent,
    part: number === 109 ? null : { id: 't109', number: 109, title: 'Checkout turn' }, branch: `task-${number}`,
    createdAt: from, cutAt: from, mergedAt: to, doneAt: null, waitsFor: [], segments, moves: [], lastActionAt: to, live: false };
}

function review(number: number, opened: string, closed: string | null, during: boolean): TreeReview {
  const panel = ['Vera', 'Rita', 'Gleb'];
  return { taskId: `r${number}`, number, openedAt: at(opened), closedAt: closed ? at(closed) : null, head: actor('Hana'),
    reviewers: panel.map((name, i) => {
      const started = number === 90 ? '05:30' : '11:00';
      const ended = number === 90 ? ['06:10', '06:12', '06:13'][i]! : ['11:15', '11:20', '11:40'][i]!;
      const live = number === 121 && during && i === 2;
      return { agent: actor(name), verdict: live ? null : { at: at(ended), pass: number !== 90 || i !== 0, findings: number === 90 && i === 0 ? 2 : 0 },
        segments: [segment('work', started, live ? null : ended)], lastActionAt: at(live ? '11:29' : ended), live };
    }),
  };
}

function times(lines: TreeLine[], reviews: TreeReview[], now: string): AgentTime[] {
  return actors.map(agent => {
    const list = [...lines.filter(l => l.agent.id === agent.id).flatMap(l => l.segments), ...reviews.flatMap(r => r.reviewers.filter(p => p.agent.id === agent.id).flatMap(p => p.segments))];
    const seconds = (kind: TreeSegment['kind']) => Math.round(list.filter(s => s.kind === kind).reduce((n, s) => n + (Date.parse(s.to ?? now) - Date.parse(s.from)) / 1000, 0));
    return { agent, work: seconds('work'), after: seconds('after'), person: seconds('person'), stall: seconds('stall'), lost: seconds('lost'), alarm: seconds('alarm'), queued: agent.name === 'Hana' ? 29950 : 0, unknown: seconds('unknown') };
  });
}

export function wholeTurn(during: boolean): { tree: DepartmentTree; org: Org; department: Department } {
  const now = at(during ? '11:30' : '12:10');
  const night: TreeLine[] = [line(62, actor('Bruno'), at('02:47'), at('04:46'), [segment('work', '02:47', '04:46')])];
  for (let i = 1; i < 38; i++) {
    const number = 62 + i + (62 + i >= 90 ? 1 : 0) + (62 + i >= 94 ? 1 : 0);
    const agent = actors[2 + (i - 1) % 5]!;
    const from = minute(i * 7), to = minute(i * 7 + 18);
    night.push(line(number, agent, from, to, [{ kind: 'work', from, to }]));
  }
  const head = line(109, actor('Hana'), at('00:00'), during ? null : at('12:10'), [
    segment('unknown', '00:00', '06:11'),
    { kind: 'alarm', from: '2026-11-03T06:11:06.000Z', to: '2026-11-03T10:33:35.000Z', alarm: { reason: 'program_stalled', since: Date.parse('2026-11-03T06:11:06.000Z') } },
    segment('work', '10:34', '11:05'),
    { ...segment('lost', '11:05', during ? null : '11:35'), program: { state: 'idle', since: stamp('11:05'), tool: null } },
    ...(!during ? [segment('work', '11:35', '12:10')] : []),
  ]);
  const headHistory = head.segments;
  head.segments = [segment('unknown', '00:00', during ? null : '12:10')];
  head.live = false;
  const activity: TreeActivity[] = [{ jobId: 'c7c49849', agent: head.agent, task: null, segments: headHistory.slice(0, 2) },
    { jobId: 'head-follow-up', agent: head.agent, task: null, segments: headHistory.slice(2, 4) },
    ...(!during ? [{ jobId: 'head-final-check', agent: head.agent, task: null, segments: headHistory.slice(4) }] : []),
    ...['06:13', '06:35'].map((from, i) => ({ jobId: `review-summary-${i}`, agent: head.agent,
      task: { id: `r${i ? 95 : 90}`, number: i ? 95 : 90, title: 'Review summary' },
      segments: [{ kind: 'queued' as const, from: at(from), to: '2026-11-03T10:33:35.000Z', waitsForAgent: head.agent }],
    })),
  ];
  const fix = line(120, actor('Bruno'), at('10:35'), at('11:00'), [segment('work', '10:35', '11:00')]);
  const final = line(135, actor('Sid'), at('11:42'), during ? null : at('12:08'), [segment('work', '11:42', during ? null : '12:08')]);
  const externalWait = { reason: 'Image build', since: at('11:10'), until: at('12:00') };
  const external = line(140, actor('Ostap'), at('11:10'), during ? null : at('12:03'), [
    { ...segment('after', '11:10', during ? null : '12:00'), externalWait }, ...(!during ? [segment('work', '12:00', '12:03')] : []),
  ]);
  external.externalWait = during ? externalWait : null;
  const reviews = [review(90, '05:30', '06:13', false), review(121, '11:00', during ? null : '11:40', during)];
  const lines = [...night, head, fix, ...(during ? [] : [final]), external];
  const waiting = during ? ['Bruno', 'Timur', 'Eva', 'Vera', 'Rita'].map(name => ({ agent: actor(name), waitsForAgent: actor('Hana'),
    from: at(name === 'Vera' ? '11:15' : name === 'Rita' ? '11:20' : '11:05'), kind: 'stall' as const, taskId: name === 'Vera' || name === 'Rita' ? 'r121' : 't120', number: 120, title: 'Waiting for the head' })) : [];
  const time = times(lines, reviews, now);
  const headTime = time.find(t => t.agent.id === head.agent.id)!;
  for (const kind of ['work', 'after', 'person', 'stall', 'lost', 'alarm'] as const) {
    headTime[kind] = headHistory.filter(s => s.kind === kind).reduce((sum, s) => sum + (Date.parse(s.to ?? now) - Date.parse(s.from)) / 1000, 0);
  }
  headTime.unknown = (Date.parse(now) - stamp('00:00')) / 1000 - headTime.work - (headTime.lost ?? 0) - (headTime.alarm ?? 0);
  const idle = lines.flatMap(l => l.segments.filter((s): s is TreeSegment & { kind: Exclude<TreeSegment['kind'], 'work'> } => s.kind !== 'work').map(s => ({ ...s,
    agent: l.agent, taskId: l.taskId, number: l.number, title: l.title, waitsFor: l.waitsFor, question: null })));
  const waits = [...waiting.map(w => ({ ...w, to: null as string | null })),
    { agent: actor('Bruno'), waitsForAgent: actor('Hana'), from: at('04:46'), to: '2026-11-03T10:33:35.000Z', kind: 'stall' as const, taskId: 't62', number: 62, title: 'Night checkout work' },
    ...(!during ? ['Bruno', 'Timur', 'Eva', 'Vera', 'Rita'].map(name => ({ agent: actor(name), waitsForAgent: actor('Hana'),
      from: at(name === 'Vera' ? '11:15' : name === 'Rita' ? '11:20' : '11:05'), to: at('11:35'), kind: 'stall' as const, taskId: 't120', number: 120, title: 'Waiting for the head' })) : []),
  ];
  idle.push(...waits.map(w => ({ ...w, waitsFor: [], question: null })));
  for (const entry of time) entry.stall += waits.filter(w => w.agent.id === entry.agent.id).reduce((sum, w) => sum + (Date.parse(w.to ?? now) - Date.parse(w.from)) / 1000, 0);
  const tree: DepartmentTree = { now, turn: { id: 'turn-4', number: 4, branch: 'turn-4', startedAt: at('00:00') }, repository: true,
    stage: during ? 'review' : 'work', lines, review: reviews[1]!, reviews, waiting, activity, time, idle };
  const employees: Employee[] = actors.map(a => ({ ...a, kind: a.name === 'Hana' ? 'head' : 'worker', roleId: a.name === 'Hana' ? 'DEV-HEAD' : 'DEV-ENG',
    title: { en: a.name === 'Hana' ? 'Head of development' : 'Developer', ru: a.name === 'Hana' ? 'Руководитель разработки' : 'Разработчик' },
    model: '', modelName: null, provider: 'codex', effort: null, state: during && ['Hana', 'Gleb'].includes(a.name) ? 'working' : 'sleeping',
    status: during && ['Hana', 'Gleb'].includes(a.name) ? 'working' : 'idle', on: true, timer: null, task: null, context: null, alarm: null,
    program: !during ? null : a.name === 'Hana' ? { state: 'idle', since: stamp('11:05'), tool: null, screenAt: stamp('11:05'), reportedAt: Date.parse(now) }
      : a.name === 'Gleb' ? { state: 'tool', since: stamp('11:00'), tool: 'Bash', screenAt: Date.parse(now), reportedAt: Date.parse(now) } : null,
  }));
  const department: Department = { id: 'd2', name: null, templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: employees.length, working: during ? 2 : 0 },
    employees, roles: [
      { id: 'DEV-HEAD', title: { en: 'Head', ru: 'Руководитель' }, description: { en: '', ru: '' }, kind: 'head', gate: null },
      { id: 'DEV-ENG', title: { en: 'Developer', ru: 'Разработчик' }, description: { en: '', ru: '' }, kind: 'member', gate: null },
    ], products: [], teams: [], people: [], repository: { url: 'https://example.com/shop.git', branch: 'main', tokenLast4: null } };
  const org: Org = { company: ME.company, orchestrator: null, agents: department.agents, people: [], serverNow: now, departments: [department] };
  return { tree, org, department };
}
