import { describe, expect, it } from 'vitest';
import { currentTaskNumber, treeLayout } from '../src/screens/tree';
import { DEV_TREE, REVIEW_TREE, SALES_TREE } from './api-mock';

const box = { width: 1100, phone: false };
const minutes = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 60_000;

describe('work tree layout', () => {
  it('keeps a live signal on a short work interval at phone scale', () => {
    const line = { ...DEV_TREE.lines[0]!, createdAt: '2026-10-30T11:30:00.000Z', cutAt: '2026-10-30T11:30:00.000Z',
      mergedAt: null, doneAt: null, live: true, moves: [], segments: [{ kind: 'work' as const, from: '2026-10-30T11:30:00.000Z', to: null }] };
    const tree = { ...DEV_TREE, now: '2026-10-30T12:00:00.000Z', turn: { ...DEV_TREE.turn!, startedAt: '2026-10-30T00:00:00.000Z' },
      lines: [line], reviews: [], review: null, waiting: [], activity: [], idle: [] };
    const layout = treeLayout(tree, { width: 375, phone: true }, 1);
    expect(layout.pulses).toHaveLength(1);
    expect(layout.pulses[0]![1]![0] - layout.pulses[0]![0]![0]).toBeCloseTo(19);
  });

  it('labels a running assignment ahead of a newer task still waiting in the queue', () => {
    const running = { ...DEV_TREE.lines[0]!, taskId: 'running', live: true, mergedAt: null };
    const queued = { ...running, taskId: 'queued', live: false, createdAt: DEV_TREE.now };
    const layout = treeLayout({ ...DEV_TREE, lines: [running, queued] }, box, 1);
    expect(layout.rows.find(r => r.agent?.id === running.agent.id)?.line?.taskId).toBe('running');
  });

  it('keeps the department lane order when a reviewer starts a later task', () => {
    const order = REVIEW_TREE.review!.reviewers.map(r => r.agent.id).concat(REVIEW_TREE.lines.map(l => l.agent.id));
    const layout = treeLayout(REVIEW_TREE, { ...box, agentOrder: order }, 1);
    expect(layout.rows.filter(r => r.type === 'lane').map(r => r.agent!.id)).toEqual(order);
  });

  it('keeps a finished wait for the head on the lane after the head resumes', () => {
    const line = DEV_TREE.lines[0]!;
    const waiting = { agent: line.agent, taskId: line.taskId, number: line.number, title: line.title, kind: 'stall' as const,
      from: '2026-10-30T11:00:00.000Z', to: '2026-10-30T12:00:00.000Z', waitsForAgent: { id: 'h', name: 'Hana' }, waitsFor: [], question: null };
    const layout = treeLayout({ ...DEV_TREE, idle: [waiting], waiting: [] }, box, 1);
    expect(layout.targets).toContainEqual(expect.objectContaining({ segment: waiting, row: line.agent.id }));
    expect(layout.badges.some(b => b.waitsForAgent)).toBe(false);
  });

  it('uses the same current task number for lanes and Speed, including a review-only agent', () => {
    expect(currentTaskNumber(REVIEW_TREE, REVIEW_TREE.lines[0]!.agent.id)).toBe(REVIEW_TREE.lines[0]!.number);
    expect(currentTaskNumber(REVIEW_TREE, REVIEW_TREE.review!.reviewers[0]!.agent.id)).toBe(REVIEW_TREE.review!.number);
    expect(currentTaskNumber(REVIEW_TREE, 'not-in-this-turn')).toBeUndefined();
  });

  it('keeps an unlinked head turn and queued review messages on one head lane', () => {
    const head = REVIEW_TREE.review!.head;
    const activity = [{ jobId: 'held-head', agent: head, task: null, segments: [{ kind: 'alarm' as const, from: REVIEW_TREE.turn!.startedAt, to: null,
      alarm: { reason: 'node_silent' as const, since: Date.parse(REVIEW_TREE.turn!.startedAt) } }] },
    { jobId: 'queued-review', agent: head, task: { id: 'r90', number: 90, title: 'Review' }, segments: [{ kind: 'queued' as const, from: REVIEW_TREE.review!.openedAt, to: null, waitsForAgent: head }] }];
    const tree = { ...REVIEW_TREE, activity };
    const layout = treeLayout(tree, box, 1);
    expect(layout.rows.filter(r => r.agent?.id === head.id)).toHaveLength(1);
    expect(layout.paths).toContainEqual(expect.objectContaining({ row: head.id, cls: 'seg al' }));
    expect(layout.targets).toContainEqual(expect.objectContaining({ pick: { kind: 'activity', agentId: head.id, jobId: 'held-head', segmentIndex: 0 } }));
    expect(layout.badges).toContainEqual(expect.objectContaining({ row: head.id, kind: 'alarm' }));
    expect(currentTaskNumber(tree, head.id)).toBeUndefined();
    expect(currentTaskNumber({ ...tree, activity: [activity[1]!] }, head.id)).toBe(90);
  });

  it('keeps all 38 tasks in time order on one lane, labelled by the current task', () => {
    const lines = Array.from({ length: 38 }, (_, i) => {
      const from = new Date(Date.parse(DEV_TREE.turn!.startedAt) + i * 480_000).toISOString();
      const to = new Date(Date.parse(from) + 480_000).toISOString();
      return { ...DEV_TREE.lines[0]!, taskId: `night-${i}`, number: 62 + i, createdAt: from, cutAt: from,
        mergedAt: i < 37 ? to : null, doneAt: null, segments: [{ kind: 'work' as const, from, to: i < 37 ? to : null }], moves: [] };
    });
    const layout = treeLayout({ ...DEV_TREE, lines: lines.reverse() }, box, 1);
    const lanes = layout.rows.filter(r => r.type === 'lane');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.line?.taskId).toBe('night-37');
    expect(layout.marks.filter(m => m.kind === 'fork' && m.pick.kind === 'line').map(m => m.pick.taskId)).toEqual(Array.from({ length: 38 }, (_, i) => `night-${i}`));
    expect(layout.paths.filter(p => p.kind === 'segment')).toHaveLength(38);
  });

  it('keeps developers and every review in the same lanes during and after review', () => {
    const first = { ...REVIEW_TREE.review!, taskId: 'r90', number: 90, openedAt: DEV_TREE.turn!.startedAt,
      closedAt: REVIEW_TREE.review!.openedAt };
    for (const stage of ['review', 'work'] as const) {
      const last = { ...REVIEW_TREE.review!, closedAt: stage === 'work' ? REVIEW_TREE.now : null, reviewers: REVIEW_TREE.review!.reviewers.map(r => ({ ...r, live: stage === 'review' && r.live })) };
      const tree = { ...REVIEW_TREE, stage, reviews: [first, last] };
      const layout = treeLayout(tree, box, 1);
      const agentIds = new Set([...tree.lines.map(l => l.agent.id), ...first.reviewers.map(r => r.agent.id)]);
      expect(layout.rows.filter(r => r.type === 'lane').map(r => r.agent!.id)).toEqual([...agentIds]);
      expect(layout.from).toBe(treeLayout(DEV_TREE, box, 1).from);
      expect(layout.marks.filter(m => m.kind === 'review').map(m => m.pick.taskId)).toEqual(['r90', 'r54']);
      expect(layout.marks.filter(m => m.kind === 'verdict')).toHaveLength(4);
    }
  });

  it('labels each agent by its latest line and keeps historical lines dimmed', () => {
    const old = { ...DEV_TREE.lines[0]!, taskId: 'old', createdAt: '2026-10-30T09:01:00.000Z' };
    const layout = treeLayout({ ...DEV_TREE, lines: [old, ...DEV_TREE.lines] }, box, 1);
    const lanes = layout.rows.filter(r => r.type === 'lane');
    expect(lanes.map(r => r.line?.taskId)).toEqual(DEV_TREE.lines.map(l => l.taskId));
    expect(layout.paths.some(p => p.row === 'b1' && p.dim)).toBe(true);
  });

  it('forks down and bends 45 degrees, then mirrors the merge into the turn', () => {
    const l = treeLayout(DEV_TREE, box, 1);
    const turn = l.rows.find(r => r.type === 'turn')!;
    const lane = l.rows.find(r => r.line?.taskId === 'b42')!;
    const y = lane.y + lane.h / 2, yt = turn.y + turn.h / 2;
    const fx = l.x(DEV_TREE.lines[0]!.cutAt!);
    const mx = l.x(DEV_TREE.lines[0]!.mergedAt!);
    expect(l.paths.find(p => p.kind === 'fork' && p.row === 'b1')?.points).toEqual([[fx, yt], [fx, y - 8], [fx + 8, y]]);
    expect(l.paths.find(p => p.kind === 'merge' && p.row === 'b1')?.points).toEqual([[mx - 8, y], [mx, y - 8], [mx, yt]]);
    expect(l.marks).toContainEqual(expect.objectContaining({ kind: 'merge', x: mx, y: yt }));
  });

  it('keeps developer lanes while reviewers fork at the review opening and end at verdicts', () => {
    const l = treeLayout(REVIEW_TREE, box, 1);
    expect(l.rows.filter(r => r.type === 'lane').map(r => r.agent?.id)).toEqual([...REVIEW_TREE.lines.map(r => r.agent.id), ...REVIEW_TREE.review!.reviewers.map(r => r.agent.id)]);
    expect(l.paths.filter(p => p.kind === 'fork' && REVIEW_TREE.review!.reviewers.some(r => r.agent.id === p.row)).every(p => p.points[0]![0] === l.x(REVIEW_TREE.review!.openedAt))).toBe(true);
    expect(l.marks.filter(m => m.kind === 'verdict').map(m => m.verdict?.findings)).toEqual([2, 0]);
    expect(l.marks).toContainEqual(expect.objectContaining({ kind: 'review', x: l.x(REVIEW_TREE.review!.openedAt) }));
  });

  it('starts every window before the turn and clamps the minute scale before zoom', () => {
    const l = treeLayout(DEV_TREE, box, 1);
    expect(minutes(DEV_TREE.turn!.startedAt, l.from)).toBe(12);
    expect(minutes(REVIEW_TREE.turn!.startedAt, treeLayout(REVIEW_TREE, box, 1).from)).toBe(12);
    expect(treeLayout(DEV_TREE, { ...box, width: 300 }, 1).scale).toBe(1.2);
    expect(treeLayout(DEV_TREE, { ...box, width: 300, phone: true }, 1).scale).toBe(.9);
    expect(treeLayout(DEV_TREE, { ...box, width: 100000 }, 1).scale).toBe(18);
    expect(treeLayout(DEV_TREE, box, 1.25).scale).toBeCloseTo(l.scale * 1.25);
  });

  it('gives plates the same room on a phone and on a desktop', () => {
    expect(treeLayout(DEV_TREE, { ...box, width: 375, phone: true }, 1).labelWidth).toBe(250);
    expect(treeLayout(DEV_TREE, box, 1).labelWidth).toBe(250);
  });

  it('keeps every row its natural height on any screen and beside any number of lanes', () => {
    const heights = (tree: typeof DEV_TREE, phone: boolean) => treeLayout(tree, { width: phone ? 375 : 1100, phone }, 1).rows.map(r => [r.type, r.h]);
    const one = { ...DEV_TREE, lines: DEV_TREE.lines.slice(0, 1), idle: [], waiting: [], activity: [], reviews: [], review: null };
    const natural = [['axis', 32], ['main', 40], ['turn', 48], ['lane', 96]];
    expect(heights(one, false)).toEqual(natural);
    expect(heights(one, true)).toEqual(natural);
    const lanes = treeLayout(DEV_TREE, box, 1).rows.filter(r => r.type === 'lane');
    expect(lanes.length).toBeGreaterThan(1);
    for (const phone of [false, true]) {
      expect(heights(DEV_TREE, phone)).toEqual([...natural.slice(0, 3), ...lanes.map(() => ['lane', 96])]);
    }
  });

  it('makes a row as tall as its plate measures, and moves the rows below with their lines', () => {
    const plain = treeLayout(DEV_TREE, box, 1), first = DEV_TREE.lines[0]!.agent.id, next = DEV_TREE.lines[1]!.agent.id;
    const grown = treeLayout(DEV_TREE, { ...box, plates: { main: 50, [first]: 130 } }, 1);
    const row = (layout: typeof plain, id: string) => layout.rows.find(r => r.agent?.id === id)!;
    expect(grown.rows.find(r => r.type === 'main')!.h).toBe(58);
    expect(row(grown, first).h).toBe(142);
    expect(grown.height).toBe(plain.height + 18 + 46);
    expect(row(grown, next).y).toBe(row(plain, next).y + 18 + 46);
    const middle = row(grown, next).y + row(grown, next).h / 2;
    const drawn = grown.paths.filter(p => p.kind === 'segment' && p.row === next);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.flatMap(p => p.points.map(point => point[1]))).toEqual(drawn.flatMap(p => p.points.map(() => middle)));
    expect(grown.targets.find(hit => hit.row === next && hit.x === 0)).toMatchObject({ y: row(grown, next).y, height: row(grown, next).h });
    const turn = grown.rows.find(r => r.type === 'turn')!, fork = grown.paths.find(p => p.kind === 'fork' && p.row === next)!;
    expect(fork.points[0]![1]).toBe(turn.y + turn.h / 2);
    expect(fork.points.at(-1)![1]).toBe(middle);
  });

  it('keeps the natural height of a plate the page could not measure', () => {
    const agent = DEV_TREE.lines[0]!.agent.id;
    expect(treeLayout(DEV_TREE, { ...box, plates: { [agent]: 0 } }, 1).rows.find(r => r.agent?.id === agent)!.h).toBe(96);
  });

  it('draws plain lines without trunks or forks, starting at creation and ending in a square', () => {
    const l = treeLayout(SALES_TREE, box, 1);
    expect(l.rows.map(r => r.type)).toEqual(['axis', 'lane', 'lane', 'lane']);
    expect(l.paths.some(p => p.kind === 'fork' || p.kind === 'merge')).toBe(false);
    expect(minutes(SALES_TREE.turn!.startedAt, l.from)).toBe(12);
    expect(l.marks).toContainEqual(expect.objectContaining({ kind: 'start', x: l.x(SALES_TREE.lines[0]!.createdAt) }));
    expect(l.marks.some(m => m.kind === 'done')).toBe(true);
  });

  it('only badges current stall, person and after segments, counting to now', () => {
    const l = treeLayout(DEV_TREE, box, 1);
    expect(l.badges.map(b => b.kind)).toEqual(['stall', 'person', 'after']);
    expect(l.badges.map(b => b.minutes)).toEqual([130, 50, 220]);
    expect(l.badges[2]!.waitsFor).toEqual([49]);
    expect(l.marks.filter(m => m.kind === 'move').some(m => m.move?.kind === 'started')).toBe(false);
  });
});

it('breathes only unanswered question rings, keeps historical stalls, and pulses at most 200 pixels', () => {
  const l = treeLayout(DEV_TREE, box, 1);
  expect(l.marks.find(m => m.move?.kind === 'asked')?.cls).toContain('br');
  expect(l.paths.some(p => p.row === 'b2' && p.cls === 'seg st')).toBe(true);
  expect(l.pulses).toHaveLength(1);
  expect(l.pulses.every(pts => pts[1]![0] - pts[0]![0] <= 200)).toBe(true);
  const next = treeLayout(REVIEW_TREE, box, 1);
  expect(next.marks.some(m => m.move?.kind === 'asked')).toBe(true);
});

it('does not fork an uncut task even in a department with a repository', () => {
  const l = treeLayout(DEV_TREE, box, 1);
  expect(l.paths.some(p => p.row === 'b5' && (p.kind === 'fork' || p.kind === 'merge'))).toBe(false);
  expect(l.marks.some(m => m.kind === 'start' && m.pick.agentId === 'b5')).toBe(true);
});

it('keeps review lines plain too when there is no repository', () => {
  const tree = { ...REVIEW_TREE, repository: false };
  const l = treeLayout(tree, box, 1);
  expect(l.rows.some(r => r.type === 'main' || r.type === 'turn')).toBe(false);
  expect(l.paths.some(p => p.kind === 'fork' || p.kind === 'merge')).toBe(false);
  expect(l.marks.filter(m => m.kind === 'start')).toHaveLength(tree.lines.length + tree.review!.reviewers.length);
});
