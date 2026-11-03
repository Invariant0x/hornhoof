import { describe, expect, it } from 'vitest';
import { STALL_MS, workTree, type DepartmentTree, type TreeFacts, type TreeLine } from '../src/modules/tasks/tree.js';

const T0 = Date.parse('2026-05-01T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const iso = (minutes: number): string => at(minutes).toISOString();

function baseFacts(overrides: Partial<TreeFacts> = {}): TreeFacts {
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
    tasks: [],
    related: [],
    events: [],
    requests: [],
    signs: [],
    jobs: [],
    ...overrides,
  };
}

function assertCoversWithoutGaps(line: TreeLine, nowIso: string): void {
  const expectedEnd = line.mergedAt ?? line.doneAt ?? null;
  expect(line.segments.length).toBeGreaterThan(0);
  expect(line.segments[0]!.from).toBe(line.createdAt);
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

describe('workTree', () => {
  it('marks 42 silent minutes as stall from the last sign, keeps 29 silent minutes as work, and ignores nudges', () => {
    expect(STALL_MS).toBe(30 * 60_000);
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
        /* 29 minutes of silence from 20 to 49 stays work. */
        { taskId: 't43', agentId: 'timur', kind: 'comment', text: 'Layout ready.', data: {}, createdAt: at(49) },
        /* Nudges inside a 42 minute silence are neither moves nor signs of life. */
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
    expect(line.segments).toEqual([
      { kind: 'work', from: iso(20), to: iso(49) },
      { kind: 'stall', from: iso(49), to: iso(91) },
      { kind: 'work', from: iso(91), to: null },
    ]);
    expect(line.moves.map(m => m.kind)).toEqual(['created', 'comment', 'comment']);
    assertAllLinesCovered(tree);
  });

  it('starts an ongoing stall at the later of the last task event and the last agent event, with to null', () => {
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
      { kind: 'work', from: iso(10), to: iso(40) },
      { kind: 'stall', from: iso(40), to: null },
    ]);
    expect(first!.lastActionAt).toBe(iso(40));
    expect(first!.live).toBe(true);

    expect(second!.segments).toEqual([
      { kind: 'work', from: iso(10), to: iso(50) },
      { kind: 'stall', from: iso(50), to: null },
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
      { kind: 'work', from: iso(10), to: iso(20) },
      { kind: 'person', from: iso(20), to: iso(85) },
      { kind: 'work', from: iso(85), to: iso(100) },
      { kind: 'person', from: iso(100), to: null },
    ]);
    expect(evaLine.moves[1]!.text).toHaveLength(160);

    const miraLine = tree.lines.find(l => l.taskId === 't51')!;
    expect(miraLine.segments).toEqual([
      { kind: 'work', from: iso(10), to: iso(30) },
      { kind: 'person', from: iso(30), to: iso(75) },
      { kind: 'stall', from: iso(75), to: null },
    ]);

    const answeredIdle = tree.idle.find(i => i.taskId === 't49' && i.to !== null)!;
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
        { taskId: 't49', agentId: 'eva', kind: 'submitted', text: 'Merged.', data: { merged: true }, createdAt: at(60) },
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
      { kind: 'work', from: iso(60), to: null },
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
        { taskId: 't1', agentId: 'mira', kind: 'submitted', text: 'Merged.', data: { merged: true }, createdAt: at(90) },
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
    expect(mergedLine.segments).toEqual([{ kind: 'work', from: iso(10), to: iso(90) }]);

    const plainDone = tree.lines.find(l => l.taskId === 't2')!;
    expect(plainDone.branch).toBeNull();
    expect(plainDone.mergedAt).toBeNull();
    expect(plainDone.doneAt).toBe(iso(80));
    expect(plainDone.segments).toEqual([
      { kind: 'work', from: iso(15), to: iso(40) },
      { kind: 'stall', from: iso(40), to: iso(80) },
    ]);
    assertAllLinesCovered(tree);
  });

  it('builds the turn review with verdicts and findings, sets stage to review while open and work once closed, and leaves it out of lines', () => {
    const makeReviewFacts = (reviewStatus: 'review' | 'done', closedAt: Date | null) =>
      baseFacts({
        tasks: [
          {
            id: 't42',
            number: 42,
            title: 'Payment gateway',
            status: 'done',
            parentId: null,
            executorAgentId: 'mira',
            after: [],
            inRepository: true,
            createdAt: at(10),
            closedAt: at(40),
          },
          {
            id: 'r54',
            number: 54,
            title: 'Review of turn 3',
            status: reviewStatus,
            parentId: null,
            executorAgentId: 'head',
            after: [],
            inRepository: true,
            createdAt: at(40),
            closedAt,
          },
        ],
        events: [
          { taskId: 't42', agentId: 'head', kind: 'created', text: '', data: {}, createdAt: at(10) },
          { taskId: 't42', agentId: 'mira', kind: 'submitted', text: 'Merged.', data: { merged: true }, createdAt: at(40) },
          {
            taskId: 'r54',
            agentId: 'head',
            kind: 'created',
            text: 'Check turn-3.',
            data: { turnReview: true, panel: ['vera', 'gleb', 'rita'] },
            createdAt: at(40),
          },
          { taskId: 'r54', agentId: 'rita', kind: 'verdict', text: 'Clean.', data: { pass: true, stage: 1, round: 0, findings: 0 }, createdAt: at(55) },
          { taskId: 'r54', agentId: 'vera', kind: 'verdict', text: 'Two bugs.', data: { pass: false, stage: 1, round: 0, findings: 2 }, createdAt: at(58) },
        ],
        /* Vera's verdict at 58 must not count as a sign of life for Gleb: Gleb has been silent since 40, so at 80 Gleb is stalled. */
        jobs: [{ taskId: 'r54', agentId: 'gleb', lastActionAt: null, live: true }],
      });

    const openTree = workTree(makeReviewFacts('review', null), at(80));
    expect(openTree.stage).toBe('review');
    expect(openTree.lines.map(l => l.taskId)).toEqual(['t42']);
    expect(openTree.review).toEqual({
      taskId: 'r54',
      number: 54,
      openedAt: iso(40),
      closedAt: null,
      head: { id: 'head', name: 'Nika' },
      reviewers: [
        {
          agent: { id: 'vera', name: 'Vera' },
          verdict: { at: iso(58), pass: false, findings: 2 },
          segments: [{ kind: 'work', from: iso(40), to: iso(58) }],
          lastActionAt: null,
          live: false,
        },
        {
          agent: { id: 'gleb', name: 'Gleb' },
          verdict: null,
          segments: [{ kind: 'stall', from: iso(40), to: null }],
          lastActionAt: null,
          live: true,
        },
        {
          agent: { id: 'rita', name: 'Rita' },
          verdict: { at: iso(55), pass: true, findings: 0 },
          segments: [{ kind: 'work', from: iso(40), to: iso(55) }],
          lastActionAt: null,
          live: false,
        },
      ],
    });

    const closedFacts = makeReviewFacts('done', at(75));
    closedFacts.events.push({
      taskId: 'r54',
      agentId: 'gleb',
      kind: 'verdict',
      text: 'Looks fine.',
      data: { pass: true, stage: 1, round: 0 },
      createdAt: at(65),
    });
    const closedTree = workTree(closedFacts, at(80));
    expect(closedTree.stage).toBe('work');
    expect(closedTree.review!.closedAt).toBe(iso(75));
    expect(closedTree.review!.reviewers[1]!.verdict).toEqual({ at: iso(65), pass: true, findings: null });
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
        /* Mira line 1: 20m work (from 0 to 20). */
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
        /* Mira line 2: 10m after (20..30), 15m work (30..45), 35m ended stall (45..80), 20m work (80..100). */
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
        /* Timur: ongoing stall since 50 (50m at now=100). */
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
        { taskId: 'm1', agentId: 'mira', kind: 'submitted', text: 'Merged.', data: { merged: true }, createdAt: at(20) },
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

    /* Agents ordered by createdAt: Mira (-50), Timur (-40), Eva (-30), Ostap (-10). */
    expect(tree.time).toEqual([
      {
        agent: { id: 'mira', name: 'Mira' },
        /* (20 + 15 + 20)m = 55m = 3300s work; 10m = 600s after; 35m = 2100s stall. */
        work: 55 * 60,
        after: 10 * 60,
        person: 0,
        stall: 35 * 60,
      },
      {
        agent: { id: 'timur', name: 'Timur' },
        work: 0,
        after: 0,
        person: 0,
        stall: 50 * 60,
      },
      {
        agent: { id: 'eva', name: 'Eva' },
        /* 50m (35..85) work; (25 + 15)m = 40m person. */
        work: 50 * 60,
        after: 0,
        person: 40 * 60,
        stall: 0,
      },
      {
        agent: { id: 'ostap', name: 'Ostap' },
        work: 0,
        after: 60 * 60,
        person: 0,
        stall: 0,
      },
    ]);

    /* Idle order: ongoing first (stall, then person, then after), then ended longest first (35m, 25m, 10m). */
    expect(tree.idle.map(i => [i.kind, i.to === null ? 'open' : 'ended', i.number])).toEqual([
      ['stall', 'open', 3],
      ['person', 'open', 4],
      ['after', 'open', 5],
      ['stall', 'ended', 2],
      ['person', 'ended', 4],
      ['after', 'ended', 2],
    ]);
    expect(tree.idle[1]!.question).toBe('Second question?');
    expect(tree.idle[2]!.waitsFor).toEqual([3]);
  });

  it('returns an empty work tree when there is no open turn', () => {
    const tree = workTree(baseFacts({ turn: null, repository: false }), at(10));
    expect(tree).toEqual({
      now: iso(10),
      turn: null,
      repository: false,
      stage: 'work',
      lines: [],
      review: null,
      time: [],
      idle: [],
    });
  });
});
