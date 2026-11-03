import { describe, expect, it } from 'vitest';
import { treeLayout } from '../src/screens/tree';
import { DEV_TREE, REVIEW_TREE, SALES_TREE } from './api-mock';

const box = { width: 1100, height: 640, phone: false };
const minutes = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 60_000;

describe('work tree layout', () => {
  it('keeps one latest line per agent in input order, with merged lanes dimmed', () => {
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

  it('shows only reviewers, all forking at the review opening and ending at their verdicts', () => {
    const l = treeLayout(REVIEW_TREE, box, 1);
    expect(l.rows.filter(r => r.type === 'lane').map(r => r.agent?.id)).toEqual(REVIEW_TREE.review!.reviewers.map(r => r.agent.id));
    expect(l.paths.filter(p => p.kind === 'fork').every(p => p.points[0]![0] === l.x(REVIEW_TREE.review!.openedAt))).toBe(true);
    expect(l.marks.filter(m => m.kind === 'verdict').map(m => m.verdict?.findings)).toEqual([2, 0]);
    expect(l.marks).toContainEqual(expect.objectContaining({ kind: 'review', x: l.x(REVIEW_TREE.review!.openedAt) }));
  });

  it('starts the windows before the stage and clamps the minute scale before zoom', () => {
    const l = treeLayout(DEV_TREE, box, 1);
    expect(minutes(DEV_TREE.turn!.startedAt, l.from)).toBe(12);
    expect(minutes(REVIEW_TREE.review!.openedAt, treeLayout(REVIEW_TREE, box, 1).from)).toBe(10);
    expect(treeLayout(DEV_TREE, { ...box, width: 300 }, 1).scale).toBe(1.2);
    expect(treeLayout(DEV_TREE, { ...box, width: 300, phone: true }, 1).scale).toBe(.9);
    expect(treeLayout(DEV_TREE, { ...box, width: 100000 }, 1).scale).toBe(18);
    expect(treeLayout(DEV_TREE, box, 1.25).scale).toBeCloseTo(l.scale * 1.25);
  });

  it('draws plain lines without trunks or forks, starting at creation and ending in a square', () => {
    const l = treeLayout(SALES_TREE, box, 1);
    expect(l.rows.map(r => r.type)).toEqual(['axis', 'lane', 'lane', 'lane']);
    expect(l.paths.some(p => p.kind === 'fork' || p.kind === 'merge')).toBe(false);
    expect(minutes(SALES_TREE.lines[0]!.createdAt, l.from)).toBe(12);
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
  expect(next.marks.some(m => m.move?.kind === 'asked')).toBe(false);
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
  expect(l.marks.filter(m => m.kind === 'start')).toHaveLength(tree.review!.reviewers.length);
});
