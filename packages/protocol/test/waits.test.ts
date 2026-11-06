import { describe, expect, it } from 'vitest';
import {
  EndSourceWait, ReplanWait, SyncSourceWaits, signalsOnce, TaskWaitView, validSourceKey, WaitFinalReview, WaitOwnerBinding, WaitPlan, WaitSourceState,
} from '../src/waits.js';

const AGENT = '00000000-0000-4000-8000-000000000001';
const PERSON = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const OPERATION = '00000000-0000-4000-8000-000000000004';
const WAIT = '00000000-0000-4000-8000-000000000005';

const plan = {
  version: 1 as const,
  ownerDueAt: '2030-01-01T10:00:00.000Z',
  headDueAt: '2030-01-01T11:00:00.000Z',
  decisionDueAt: '2030-01-01T12:00:00.000Z',
  provenance: { kind: 'explicit_promise' as const, actor: { agentId: AGENT }, ref: 'promise-1', revision: 1, origin: 'wait_for' },
  finalReview: { headAgentId: AGENT, anchorAt: '2030-01-01T13:00:00.000Z', intervalMs: 3_600_000 },
};
const sync = { taskId: TASK, kind: 'external' as const, sourceKey: `operation:${OPERATION}`, sourceRevision: 1, ownerBinding: { agentId: AGENT }, plan, sourceState: {} };

describe('who owns a wait', () => {
  it.each([{ agentId: AGENT }, { personId: PERSON }])('takes one real agent or person %#', binding => {
    expect(WaitOwnerBinding.parse(binding)).toEqual(binding);
  });

  it.each([
    {}, { agentId: AGENT, personId: PERSON }, { agentId: 'machine' }, { personId: 'ceo' }, { agentId: AGENT, name: 'Hana' },
    { kind: 'external', event: 'machine' },
  ])('refuses no owner, both, a label and extra fields %#', binding => {
    expect(WaitOwnerBinding.safeParse(binding).success).toBe(false);
  });
});

describe('the plan of a wait', () => {
  it('takes absolute dates, where they come from and an explicit final review', () => {
    expect(WaitPlan.parse(plan)).toEqual(plan);
  });

  it.each(['explicit_promise', 'department_policy', 'source_contract'])('names its source as %s', kind => {
    expect(WaitPlan.safeParse({ ...plan, provenance: { ...plan.provenance, kind } }).success).toBe(true);
  });

  it.each([
    ['no date', { ownerDueAt: undefined }],
    ['a date that is no date', { headDueAt: 'soon' }],
    ['a head date before the owner\'s', { headDueAt: '2030-01-01T09:00:00.000Z' }],
    ['a decision date before the head\'s', { decisionDueAt: '2030-01-01T10:30:00.000Z' }],
    ['another version', { version: 2 }],
    ['a common deadline besides the dates', { slaMs: 1000 }],
    ['no source of the dates', { provenance: undefined }],
    ['an unknown source of the dates', { provenance: { ...plan.provenance, kind: 'createdAt_plus_timeout' } }],
    ['a source without its actor', { provenance: { ...plan.provenance, actor: undefined } }],
    ['no final review', { finalReview: undefined }],
  ])('refuses %s', (_name, change) => {
    expect(WaitPlan.safeParse({ ...plan, ...change }).success).toBe(false);
  });

  it.each([
    ['no interval', { intervalMs: 0 }],
    ['a backward interval', { intervalMs: -1 }],
    ['a finite list of reviews', { times: 3 }],
    ['no anchor', { anchorAt: undefined }],
    ['no real head', { headAgentId: 'head' }],
  ])('refuses a final review with %s', (_name, change) => {
    expect(WaitFinalReview.safeParse({ ...plan.finalReview, ...change }).success).toBe(false);
  });
});

describe('what a wait waits for', () => {
  it.each([
    ['after', `task:${TASK}`],
    ['review', `review:${TASK}:2:${AGENT}`],
    ['person', `request:${OPERATION}`],
    ['run', `run:${OPERATION}`],
    ['external', `wait_for:${OPERATION}`],
    ['external', `operation:${OPERATION}`],
  ] as const)('%s takes %s', (kind, key) => {
    expect(validSourceKey(kind, key)).toBe(true);
  });

  it.each([
    ['external', 'machine'], ['external', ''], ['external', 'operation:'], ['external', `run:${OPERATION}`],
    ['run', `run:${OPERATION}:1`], ['run', 'run:7'], ['after', TASK], ['person', `task:${TASK}`], ['review', `review:${TASK}:${AGENT}`],
  ] as const)('%s refuses %j', (kind, key) => {
    expect(validSourceKey(kind, key)).toBe(false);
  });

  it('keeps only known facts of a source', () => {
    expect(WaitSourceState.parse({ stage: 'host_slot', nextActionAt: '2030-01-01T10:00:00.000Z', route: 'operations' })).toMatchObject({ stage: 'host_slot' });
    expect(WaitSourceState.safeParse({ stage: 'whenever' }).success).toBe(false);
    expect(WaitSourceState.safeParse({ command: 'npm test' }).success).toBe(false);
  });
});

describe('what the ports take', () => {
  it('takes a whole source', () => {
    expect(SyncSourceWaits.parse(sync)).toEqual(sync);
  });

  it.each([
    ['no owner', { ownerBinding: undefined }],
    ['no plan', { plan: undefined }],
    ['a source key of another kind', { sourceKey: `run:${OPERATION}` }],
    ['no source key', { sourceKey: undefined }],
    ['the task\'s version instead of a revision', { sourceRevision: undefined, version: 3 }],
    ['a revision below zero', { sourceRevision: -1 }],
    ['an unknown kind', { kind: 'thinking' }],
    ['an extra field', { generation: 9 }],
  ])('refuses %s', (_name, change) => {
    expect(SyncSourceWaits.safeParse({ ...sync, ...change }).success).toBe(false);
  });

  it('ends a source with its outcome and its proof', () => {
    const end = { taskId: TASK, kind: 'run' as const, sourceKey: `run:${OPERATION}`, sourceRevision: 2, outcome: 'resolved' as const, proofRef: `run:${OPERATION}:passed` };
    expect(EndSourceWait.parse(end)).toEqual(end);
    expect(EndSourceWait.safeParse({ ...end, outcome: 'done' }).success).toBe(false);
    expect(EndSourceWait.safeParse({ ...end, proofRef: '' }).success).toBe(false);
    expect(EndSourceWait.safeParse({ ...end, proofRef: undefined }).success).toBe(false);
  });

  it('plans a wait again only with something new, a reason and the generation it read', () => {
    const replan = { waitId: WAIT, expectedGeneration: 2, plan, reason: 'The head gave a new promise.' };
    expect(ReplanWait.parse(replan)).toEqual(replan);
    expect(ReplanWait.safeParse({ waitId: WAIT, expectedGeneration: 2, reason: 'Nothing new.' }).success).toBe(false);
    expect(ReplanWait.safeParse({ ...replan, reason: ' ' }).success).toBe(false);
    expect(ReplanWait.safeParse({ ...replan, expectedGeneration: 0 }).success).toBe(false);
  });
});

describe('a source that signals once', () => {
  const once = { ...plan, finalReview: { ...plan.finalReview, intervalMs: null } };
  const of = (kind: string, sourceKey: string) => ({ ...sync, kind, sourceKey, plan: once });

  it('lets an external operation say it has no repeats', () => {
    expect(SyncSourceWaits.safeParse(of('external', `operation:${OPERATION}`)).success).toBe(true);
    expect(signalsOnce('external', `operation:${OPERATION}`)).toBe(true);
  });

  it.each([
    ['a prerequisite', 'after', `task:${OPERATION}`],
    ['a review', 'review', `review:${OPERATION}:1:${AGENT}`],
    ['a person', 'person', `request:${OPERATION}`],
    ['a run', 'run', `run:${OPERATION}`],
    ['a wait_for', 'external', `wait_for:${OPERATION}`],
  ])('keeps the reviews of %s repeating', (_name, kind, sourceKey) => {
    expect(SyncSourceWaits.safeParse(of(kind, sourceKey)).success).toBe(false);
    expect(signalsOnce(kind as 'external', sourceKey)).toBe(false);
  });

  it('adds no other number and no zero for it', () => {
    expect(WaitFinalReview.safeParse({ ...plan.finalReview, intervalMs: 0 }).success).toBe(false);
    expect(WaitFinalReview.safeParse({ ...plan.finalReview, intervalMs: undefined }).success).toBe(false);
    expect(WaitFinalReview.safeParse({ ...plan.finalReview, intervalMs: null, repeats: 1 }).success).toBe(false);
  });

  it('takes three equal dates from the source contract', () => {
    const at = '2030-01-01T12:00:00.000Z';
    const contract = { ...once, ownerDueAt: at, headDueAt: at, decisionDueAt: at, provenance: { ...plan.provenance, kind: 'source_contract' } };
    expect(SyncSourceWaits.safeParse({ ...sync, plan: contract }).success).toBe(true);
  });
});

describe('what a person sees of a wait', () => {
  const view = {
    id: WAIT, taskId: TASK, kind: 'external', state: 'active', generation: 1, level: 0, owner: { agentId: AGENT },
    ownerDueAt: plan.ownerDueAt, headDueAt: plan.headDueAt, decisionDueAt: plan.decisionDueAt, nextActionAt: plan.ownerDueAt, stage: null,
  };

  it('shows its owner, dates and level', () => {
    expect(TaskWaitView.parse(view)).toEqual(view);
  });

  it('shows an old wait with no owner or dates as it is', () => {
    const legacy = { ...view, state: 'legacy_needs_plan', owner: null, ownerDueAt: null, headDueAt: null, decisionDueAt: null, nextActionAt: null };
    expect(TaskWaitView.parse(legacy)).toEqual(legacy);
  });

  it.each(['sourceKey', 'proofRef', 'route'])('never carries %s', field => {
    expect(TaskWaitView.safeParse({ ...view, [field]: 'private' }).success).toBe(false);
  });
});
