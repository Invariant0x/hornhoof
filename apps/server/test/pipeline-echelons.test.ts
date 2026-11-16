import { describe, expect, it } from 'vitest';
import { pipelineFacts, type FactsEvent, type FactsInput } from '../src/modules/tasks/pipeline-facts.js';

const start = Date.parse('2026-11-08T00:00:00Z');
const at = (minutes: number) => new Date(start + minutes * 60_000);
const event = (kind: FactsEvent['kind'], minutes: number, data: Record<string, unknown>): FactsEvent => ({ taskId: 'task', kind, createdAt: at(minutes), data });
const submitted = (minutes: number, stage: 'development' | 'review') => event('submitted', minutes, { candidate: { producedBy: { stage } } });
const verified = (minutes: number) => event('report', minutes, { verifiedCandidate: { candidateId: 'candidate', routeRevision: 4 } });
function facts(events: FactsEvent[], closed = false) {
  const input: FactsInput = { openedAt: at(0), until: at(90),
    tasks: [{ id: 'task', number: 1, parentId: null, executorAgentId: 'author', status: closed ? 'done' : 'working', after: [], workKind: null, firstLine: '', createdAt: at(0), closedAt: closed ? at(60) : null }],
    events, requests: [], runs: [], jobs: [], agentTime: [], timings: [],
  };
  return pipelineFacts(input);
}

describe('forward candidate timing', () => {
  it.each([false, true])('keeps checking time through Tests until final verification=%s', ready => {
    const result = facts([submitted(10, 'development'), event('verdict', 20, { pass: true, stage: 'review' }), ...(ready ? [verified(50)] : [])]);
    expect(result.stages).toEqual({ work: 600, review: ready ? 2400 : 4800, fixes: 0, merge: ready ? 2400 : 0, turnReview: 0 });
  });

  it('counts checker repairs without inventing a return to the author', () => {
    const result = facts([submitted(10, 'development'), event('verdict', 20, { pass: false, stage: 'review' }), submitted(30, 'review'),
      event('verdict', 40, { pass: true, stage: 'security' }), verified(50), event('report', 60, { acceptedCandidate: { candidateId: 'candidate', commit: 'a'.repeat(40) } })], true);
    expect(result.stages).toEqual({ work: 600, review: 1800, fixes: 600, merge: 600, turnReview: 0 });
    expect(result).toMatchObject({ returns: 0, fixRounds: 1 });
  });

  it('does not treat a failed verification report as integration readiness', () => {
    const result = facts([submitted(10, 'development'), event('verdict', 20, { pass: true, stage: 'review' }), event('report', 50, { failedVerification: { candidateId: 'candidate', routeRevision: 4 } })]);
    expect(result.stages).toEqual({ work: 600, review: 4800, fixes: 0, merge: 0, turnReview: 0 });
  });
});
