import { describe, expect, it } from 'vitest';
import type { AgentViewer } from '../src/auth/agent-view.js';
import { loadTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { detailFor } from '../src/modules/tasks/sight.js';
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
  /* A person who sees the task reads how many findings each stage reported and confirmed, and nothing of what they say. */
  it('shows a person who sees the task the true counts of its findings and none of their details', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing the boundary.', issues: [{ ...issue, blocking: true }] });
    const task = await loadTask(f.db, f.task.id);
    const viewer: AgentViewer = { full: false, personId: 'someone', access: { whole: false, departments: new Set([task.departmentId!]), teams: new Set() }, plans: new Set(), agents: new Set([f.reviewer.id, f.author.id]) };
    const shown = await detailFor(f.ctx, viewer, task);
    expect(findings(shown)).toMatchObject({ uniqueReported: 1, uniqueConfirmed: 0, review: { reported: 1, confirmed: 0 }, issues: [] });
    expect(JSON.stringify(findings(shown))).not.toContain(issue.harm);
    expect((shown.echelonFindings as { byVendor?: { findingIds: string[] }[] }).byVendor?.every(vendor => vendor.findingIds.length === 0)).toBe(true);
  });
  /* The owner of the task's department reads its findings whole, as the rest of the department; the owner of another one does not. */
  it('shows the owner of the task\'s department its findings with their details', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing the boundary.', issues: [{ ...issue, blocking: true }] });
    const task = await loadTask(f.db, f.task.id);
    const owning = (department: string): AgentViewer => ({ full: false, personId: 'someone', access: { whole: false, departments: new Set([task.departmentId!, department]), teams: new Set(), owns: new Set([department]) }, plans: new Set(), agents: new Set([f.reviewer.id, f.author.id]) });
    const whole = findings(await f.detail());
    const shown = await detailFor(f.ctx, owning(task.departmentId!), task);
    expect(findings(shown)).toEqual(whole);
    expect(JSON.stringify(findings(shown))).toContain(issue.harm);
    const elsewhere = await detailFor(f.ctx, owning('d0000000-0000-4000-8000-000000000009'), task);
    expect(findings(elsewhere).issues).toEqual([]);
    expect(elsewhere.echelons.candidateId).toBeNull();
  });
});
