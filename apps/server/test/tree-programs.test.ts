import { expect, it } from 'vitest';
import { countedSegments, turnSegments, withExternalWait, withPrograms, type FactTurn, type ProgramPoint } from '../src/modules/tasks/tree-programs.js';

const date = (ms: number) => new Date(Date.parse('2026-11-03T00:00:00.000Z') + ms);
const iso = (ms: number) => date(ms).toISOString();
const agent = { id: 'a', name: 'Bruno' };
const turn = (history: ProgramPoint[], end: number | null = null): FactTurn => ({ id: 'j', agentId: 'a', taskId: 't',
  status: end === null ? 'running' : 'done', createdAt: date(0), startedAt: date(0), finishedAt: end === null ? null : date(end), history });
const point = (state: NonNullable<ProgramPoint['program']>['state'], since: number): ProgramPoint => ({ at: date(since),
  program: { state, since: date(since).getTime(), tool: state === 'tool' ? 'Bash' : null }, alarm: null });
const base = [{ kind: 'unknown' as const, from: iso(0), to: null }];

it('keeps the state of a turn that has just started, before any time has elapsed', () => {
  expect(withPrograms(base, [turn([point('thinking', 0)])], agent, date(0))).toEqual([
    { kind: 'work', from: iso(0), to: null, program: point('thinking', 0).program },
  ]);
});

it.each([
  ['thinking', 'work'], ['retrying', 'work'], ['tool', 'work'], ['asking', 'person'], ['gone', 'lost'], ['idle', 'stall'],
] as const)('counts recorded %s as %s, without inferring it from silence', (state, kind) => {
  expect(withPrograms(base, [turn([point(state, 0)])], agent, date(1000))).toMatchObject([{ kind, from: iso(0), to: null }]);
});

it('keeps idle calm at any age until the program reports its end, as in the live view', () => {
  expect(withPrograms(base, [turn([point('idle', 0)])], agent, date(60_000))[0]!.kind).toBe('stall');
  expect(withPrograms(base, [turn([point('idle', 0)])], agent, date(3_600_000))[0]!.kind).toBe('stall');
});

it('ends an alarm when it is cleared and resumes the same recorded work state', () => {
  const thinking = point('thinking', 0);
  const history = [thinking, { ...thinking, at: date(2000), alarm: { reason: 'node_silent' as const, since: date(1000).getTime() } },
    { ...thinking, at: date(4000) }];
  const segments = withPrograms(base, [turn(history)], agent, date(5000));
  expect(segments.map(s => [s.kind, s.from, s.to])).toEqual([
    ['work', iso(0), iso(1000)], ['alarm', iso(1000), iso(4000)], ['work', iso(4000), null],
  ]);
});

it('ends recorded work at the finished turn and leaves later time unknown', () => {
  expect(withPrograms(base, [turn([point('tool', 0)], 1000)], agent, date(2000)).map(s => [s.kind, s.to]))
    .toEqual([['work', iso(1000)], ['unknown', null]]);
});

it('counts queue time even without a running program and does not invent unobserved work', () => {
  const queued = { ...turn([]), startedAt: null, status: 'queued' as const };
  expect(withPrograms(base, [queued], agent, date(2000))).toMatchObject([{ kind: 'queued', waitsForAgent: agent }]);
  expect(countedSegments([{ kind: 'queued', from: iso(0), to: iso(2000) }], date(3000))).toHaveLength(1);
  expect(withPrograms(base, [], agent, date(2000))).toEqual(base);
});

it('clips a job that began before its task and finished after the task closed', () => {
  const job = { ...turn([point('tool', -1000)], 3000), createdAt: date(-1000), startedAt: date(-1000) };
  const bounded = [{ kind: 'unknown' as const, from: iso(0), to: iso(2000) }];
  expect(withPrograms(bounded, [job], agent, date(4000))).toEqual([
    { kind: 'work', from: iso(0), to: iso(2000), program: point('tool', -1000).program },
  ]);
});

it('keeps dependency waiting before a task starts and recorded work after it starts', () => {
  const job = { ...turn([point('thinking', 1000)]), createdAt: date(1000), startedAt: date(1000) };
  const waiting = [{ kind: 'after' as const, from: iso(0), to: iso(1000) }, { kind: 'unknown' as const, from: iso(1000), to: null }];
  expect(withPrograms(waiting, [job], agent, date(2000)).map(s => [s.kind, s.from, s.to]))
    .toEqual([['after', iso(0), iso(1000)], ['work', iso(1000), null]]);
});

it('keeps a current alarm open when the running job has no finish time', () => {
  const thinking = point('thinking', 0), alarm = { reason: 'node_silent' as const, since: date(1000).getTime() };
  const history = [thinking, { ...thinking, at: date(2000), alarm }];
  expect(withPrograms(base, [turn(history)], agent, date(5000)).at(-1)).toEqual({ kind: 'alarm', from: iso(1000), to: null, alarm });
});

it('keeps a new alarm reason distinct while the program state stays the same', () => {
  const thinking = point('thinking', 0);
  const history = [thinking,
    { ...thinking, at: date(2000), alarm: { reason: 'node_silent' as const, since: date(1000).getTime() } },
    { ...thinking, at: date(4000), alarm: { reason: 'program_stalled' as const, since: date(3000).getTime() } },
    { ...thinking, at: date(6000) },
  ];
  expect(withPrograms(base, [turn(history)], agent, date(7000)).map(s => [s.kind, s.from, s.to, s.alarm?.reason])).toEqual([
    ['work', iso(0), iso(1000), undefined], ['alarm', iso(1000), iso(3000), 'node_silent'],
    ['alarm', iso(3000), iso(6000), 'program_stalled'], ['work', iso(6000), null, undefined],
  ]);
});

it('keeps tool details when thinking changes to a tool without interrupting work', () => {
  const list = withPrograms(base, [turn([point('thinking', 0), point('tool', 1000)])], agent, date(2000));
  expect(list.map(s => [s.kind, s.from, s.program?.state])).toEqual([['work', iso(0), 'thinking'], ['work', iso(1000), 'tool']]);
});

it('keeps the name of each upstream agent when one dependency follows another', () => {
  const mira = { id: 'mira', name: 'Mira' }, rita = { id: 'rita', name: 'Rita' };
  const list = countedSegments([
    { kind: 'after', from: iso(0), to: iso(1000), waitsForAgent: mira },
    { kind: 'after', from: iso(1000), to: iso(2000), waitsForAgent: rita },
  ], date(3000));
  expect(list.map(s => [s.from, s.to, s.waitsForAgent])).toEqual([[iso(0), iso(1000), mira], [iso(1000), iso(2000), rita]]);
});

it('keeps the reason when an external wait starts during ordinary dependency waiting', () => {
  const externalWait = { reason: 'Image build', since: iso(1000), until: iso(3000) };
  const list = withExternalWait([{ kind: 'after', from: iso(0), to: null }], externalWait, date(2000));
  expect(list).toEqual([{ kind: 'after', from: iso(0), to: iso(1000) }, { kind: 'after', from: iso(1000), to: null, externalWait }]);
  expect(withExternalWait(base, externalWait, date(3000)).at(-1)!.to).toBe(iso(3000));
});
it('keeps the Bash and Read boundaries and removes only an identical repeated Read point', () => {
  const bash = point('tool', 0);
  const read = { ...point('tool', 1000), program: { state: 'tool' as const, tool: 'Read', since: date(1000).getTime() } };
  const repeated = { ...read, at: date(2000), program: { ...read.program } };
  expect(withPrograms(base, [turn([bash, read, repeated])], agent, date(3000))).toEqual([
    { kind: 'work', from: iso(0), to: iso(1000), program: { state: 'tool', tool: 'Bash', since: date(0).getTime() } },
    { kind: 'work', from: iso(1000), to: null, program: { state: 'tool', tool: 'Read', since: date(1000).getTime() } },
  ]);
});

it('deduplicates against the latest point after more than two changes', () => {
  const history = [point('thinking', 0), point('tool', 1000), point('idle', 2000)];
  const idle = { ...point('idle', 2000), at: date(3000) };
  expect(turnSegments(turn([...history, idle]), agent).filter(s => s.program).map(s => s.program))
    .toEqual(history.map(p => p.program));
});

it.each([
  { state: 'thinking', tool: 'Bash', since: 0 },
  { state: 'tool', tool: 'Read', since: 0 },
  { state: 'tool', tool: 'Bash', since: 1000 },
] as const)('retains a point when only a program identity field changes to %j', next => {
  const bash = point('tool', 0);
  const changed = { at: date(1000), program: { ...next, since: date(next.since).getTime() }, alarm: null };
  const repeated = { ...changed, at: date(2000), program: { ...changed.program } };
  const programs = turnSegments(turn([bash, changed, repeated]), agent).filter(s => s.program).map(s => s.program);
  expect(programs).toEqual([
    { state: 'tool', tool: 'Bash', since: date(0).getTime() },
    { state: next.state, tool: next.tool, since: date(next.since).getTime() },
  ]);
});
