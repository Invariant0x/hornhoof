import { describe, expect, it } from 'vitest';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { confirmFinding } from '../src/modules/tasks/review-findings.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed totals and tests.', review: { baseCommit: BASE } };
const issue = { category: 'data' as const, blocking: false, path: 'logic/totals.ts', line: 1, harm: 'The boundary needs an explicit contract.' };
type View = { uniqueReported: number; uniqueConfirmed: number; review: { reported: number; confirmed: number }; security: { reported: number; confirmed: number }; issues: { findingId: string; revision: string; stage: string; candidateId: string }[] };
const findings = (detail: unknown) => (detail as { echelonFindings: View }).echelonFindings;

describe('immutable echelon finding provenance', () => {
  it('keeps Review and Security occurrences without counting the same issue twice', async () => {
    const f = await fixture({ riskClass: 'security' });
    await submit(f.ctx, f.author.id, f.task.id, code);
    const candidateId = (await f.detail()).echelons.candidateId;
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed this boundary.', issues: [issue] });
    await verdict(f.ctx, f.security.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'The same boundary is a data risk.', issues: [issue] });
    const view = findings(await f.detail());
    expect(view).toMatchObject({ uniqueReported: 1, uniqueConfirmed: 0, review: { reported: 1, confirmed: 0 }, security: { reported: 1, confirmed: 0 } });
    expect(view.issues).toHaveLength(2);
    expect(new Set(view.issues.map(value => value.findingId)).size).toBe(1);
    expect(view.issues.map(value => value.stage)).toEqual(['review', 'security']);
    expect(view.issues.every(value => value.candidateId === candidateId)).toBe(true);
  });
  it('counts an independently confirmed finding once and refuses checker self-confirmation', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, reviewedCommit: HEAD, comment: 'I will fix it.', issues: [{ ...issue, blocking: true }] });
    const [finding] = findings(await f.detail()).issues;
    const confirmation = { findingId: finding!.findingId, revision: finding!.revision, confirmed: true, reason: 'Confirmed the boundary defect independently.' };
    await expect(confirmFinding(f.ctx, f.reviewer.id, await (await import('../src/modules/tasks/engine.js')).loadTask(f.db, f.task.id), confirmation)).rejects.toMatchObject({ status: 403 });
    const current = await (await import('../src/modules/tasks/engine.js')).loadTask(f.db, f.task.id);
    await confirmFinding(f.ctx, f.head.id, current, confirmation);
    await confirmFinding(f.ctx, f.head.id, current, confirmation);
    expect(findings(await f.detail())).toMatchObject({ uniqueReported: 1, uniqueConfirmed: 1, review: { reported: 1, confirmed: 1 } });
  });
});
