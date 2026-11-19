import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const role = (id: string) => templates.roles.get(id)!;
describe('release improvement procedure', () => {
  it('reaches performance, red team and head through loaded skills and rendered instructions', async () => {
    const { renderInstructions } = await import('../src/modules/agents/instructions.js');
    for (const id of ['DEV-PERF', 'DEV-RED', 'DEV-HEAD']) {
      const r = role(id);
      const rendered = renderInstructions(templates, { id: 'test', companyId: 'c', kind: r.kind === 'head' ? 'head' : 'worker', name: 'Reader', roleKey: id, skills: r.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
      expect(rendered.skills.map(s => s.name), id).toContain('dev-release-improvements');
    }
    const procedure = templates.skills.get('dev-release-improvements')!.body;
    for (const topic of ['issue-to-acceptance', 'reviewer usefulness', 'released version', 'nonblocking', 'Before', 'Target after', 'unknown', 'company isolation', 'outbound']) expect(procedure, topic).toContain(topic);
    expect(procedure).toMatch(/owner and schedule come from that assignment/);
    expect(procedure).toMatch(/authorized isolated measurement or a recorded baseline supplied by the owner/);
    expect(procedure).toMatch(/Agree a relative target with the task owner/);
    expect(procedure).toMatch(/Do not run an expensive operation against production merely because a measurement ability is enabled/);
    expect(role('DEV-RED').body).not.toContain('or public-facing');
  });
});

it('rejects blocking improvement metadata and unknown executable trigger patterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-gate-metadata-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL('../../../templates', import.meta.url)), dir, { recursive: true });
  const perf = join(dir, 'roles/development/DEV-PERF.md');
  const original = readFileSync(perf, 'utf8');
  writeFileSync(perf, original.replace('skills:', 'improvementLanes: [{ id: release-performance, blocking: true }]\nskills:'));
  expect(() => loadTemplates(dir)).toThrow(/improvementLanes/);
  writeFileSync(perf, original);
  const sec = join(dir, 'roles/development/DEV-SEC.md');
  writeFileSync(sec, readFileSync(sec, 'utf8').replace('skills:', 'gateTriggers: { diffPatterns: [custom-regex] }\nskills:'));
  expect(() => loadTemplates(dir)).toThrow(/gateTriggers/);
});
