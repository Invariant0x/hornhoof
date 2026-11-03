import { expect, it } from 'vitest';
import { LOST_END_MS } from '@hornhoof/protocol/map';
import { countedSegments, withPrograms, type FactTurn, type ProgramPoint } from '../src/modules/tasks/tree-programs.js';

const date = (ms: number) => new Date(ms);
const iso = (ms: number) => date(ms).toISOString();
const agent = { id: 'a', name: 'Bruno' };
const turn = (history: ProgramPoint[], end: number | null = null): FactTurn => ({ id: 'j', agentId: 'a', taskId: 't',
  status: end === null ? 'running' : 'done', createdAt: date(0), startedAt: date(0), finishedAt: end === null ? null : date(end), history });
const point = (state: NonNullable<ProgramPoint['program']>['state'], since: number): ProgramPoint => ({ at: date(since),
  program: { state, since, tool: state === 'tool' ? 'Bash' : null }, alarm: null });
const base = [{ kind: 'unknown' as const, from: iso(0), to: null }];

it('keeps the state of a turn that has just started, before any time has elapsed', () => {
  expect(withPrograms(base, [turn([point('thinking', 0)])], agent, date(0))).toEqual([
    { kind: 'work', from: iso(0), to: null, program: point('thinking', 0).program },
  ]);
});

it.each([
  ['thinking', 'work'], ['tool', 'work'], ['asking', 'person'], ['gone', 'lost'], ['idle', 'stall'],
] as const)('counts recorded %s as %s, without inferring it from silence', (state, kind) => {
  expect(withPrograms(base, [turn([point(state, 0)])], agent, date(1000))).toMatchObject([{ kind, from: iso(0), to: null }]);
});

it('marks recorded idle as a lost end at the same protocol threshold as the live view', () => {
  expect(withPrograms(base, [turn([point('idle', 0)])], agent, date(LOST_END_MS - 1))[0]!.kind).toBe('stall');
  expect(withPrograms(base, [turn([point('idle', 0)])], agent, date(LOST_END_MS))[0]!.kind).toBe('lost');
});

it('ends an alarm when it is cleared and resumes the same recorded work state', () => {
  const thinking = point('thinking', 0);
  const history = [thinking, { ...thinking, at: date(2000), alarm: { reason: 'node_silent' as const, since: 1000 } },
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
