import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { gateReasons, type GateChanges } from '../src/modules/tasks/gate-triggers.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const role = (id: string) => templates.roles.get(id)!;
const clean: GateChanges = { tasks: [], paths: ['apps/web/src/Button.tsx'], diff: '+const label = "Save";', mode: 'turn' };

describe('review gate triggers', () => {
  it('always reviews code and leaves ordinary UI outside conditional gates', () => {
    expect(gateReasons(role('DEV-REV'), clean)).toEqual(['always']);
    for (const id of ['DEV-SEC', 'DEV-RED']) expect(gateReasons(role(id), clean), id).toEqual([]);
  });

  it.each(['money', 'access', 'security', 'data', 'деньги', 'доступ', 'безопасность', 'данные'])('checks any covered task with risk %s', riskClass => {
    for (const id of ['DEV-SEC', 'DEV-RED']) {
      expect(gateReasons(role(id), { ...clean, tasks: [{ riskClass: null, body: '' }, { riskClass, body: '' }] })).toContain('risk');
      expect(gateReasons(role(id), { ...clean, tasks: [{ body: `Вид: известное поведение.\nКласс риска: ${riskClass}.\n\nDetails` }] })).toContain('risk');
    }
  });

  it('accepts English risk headers but does not treat ordinary task prose as a declaration', () => {
    expect(gateReasons(role('DEV-SEC'), { ...clean, tasks: [{ body: '**Risk class:** access\n\nDetails' }] })).toContain('risk');
    expect(gateReasons(role('DEV-SEC'), { ...clean, tasks: [{ body: 'Describe access to this screen.' }] })).toEqual([]);
  });

  it.each(['apps/server/src/db/agent-sql.ts', 'apps/server/src/db/schema.ts', 'apps/server/src/auth/session.ts', 'src/permissions.ts', 'lib/secrets/key.ts', 'apps/node/src/nodes/transport.ts', 'package-lock.json', 'a/pnpm-lock.yaml', 'Cargo.lock', 'Pipfile.lock', 'src/crypto/tokens.ts', 'src/product/routes.ts', 'db/migrations/001_people.sql'])('checks sensitive path %s without declared risk', path => {
    for (const id of ['DEV-SEC', 'DEV-RED']) expect(gateReasons(role(id), { ...clean, paths: [path] }), id).toContain('path');
  });

  it.each(['+app.get("/api/new", handler);', '+app.post("/api/new", handler);', '+app.put("/api/new", handler);', '+app.patch("/api/new", handler);', '+app.delete("/api/new", handler);', '+app.route({ method: "GET" });', '+app.head("/new", handler);', '+app.options("/new", handler);', '+app.all("/new", handler);', '+const query = sql`select 1`;', '+await db.execute(query);', '+spawn("worker", []);', '+exec("worker");', '+execFile("worker", []);', '+fork("worker.js");'])('checks added risky code %s', diff => {
    for (const id of ['DEV-SEC', 'DEV-RED']) expect(gateReasons(role(id), { ...clean, diff }), id).toContain('diff');
  });

  it('ignores context lines, deleted code and diff file headers', () => {
    const diff = '+++ b/spawn.ts\n-app.get("/old", handler);\n exec("old");\n+const title = "Saved";';
    expect(gateReasons(role('DEV-SEC'), { ...clean, diff })).toEqual([]);
  });

  it('checks pre-release explicitly and never makes an improvement lane a gate', () => {
    for (const id of ['DEV-SEC', 'DEV-RED']) {
      expect(gateReasons(role(id), { ...clean, mode: 'pre-release' })).toContain('pre-release');
      expect(gateReasons(role(id), { ...clean, mode: 'improvement' })).toEqual([]);
    }
    expect(gateReasons(role('DEV-PERF'), { ...clean, mode: 'pre-release' })).toEqual([]);
    expect(role('DEV-PERF').improvementLanes).toContainEqual({ id: 'release-performance', blocking: false });
    expect(role('DEV-RED').improvementLanes).toContainEqual({ id: 'released-version', blocking: false });
  });
});

describe('release improvement procedure', () => {
  it('reaches performance, red team and head through loaded skills and rendered instructions', async () => {
    const { renderInstructions } = await import('../src/modules/agents/instructions.js');
    for (const id of ['DEV-PERF', 'DEV-RED', 'DEV-HEAD']) {
      const r = role(id);
      const rendered = renderInstructions(templates, { id: 'test', companyId: 'c', kind: r.kind === 'head' ? 'head' : 'worker', name: 'Reader', roleKey: id, skills: r.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
      expect(rendered.skills.map(s => s.name), id).toContain('dev-release-improvements');
    }
    const procedure = templates.skills.get('dev-release-improvements')!.body;
    for (const topic of ['pipeline_report', 'issue-to-acceptance', '30%', 'turn 7', 'T7', 'reviewer usefulness', 'released version', 'nonblocking', 'Before', 'Target after', 'unknown', 'company isolation', 'outbound']) expect(procedure, topic).toContain(topic);
    expect(role('DEV-RED').body).not.toContain('or public-facing');
  });
});

it('requires conditional review when a trusted comparison is unavailable', () => {
  for (const id of ['DEV-SEC', 'DEV-RED']) expect(gateReasons(role(id), { ...clean, incomplete: true })).toContain('compare-unavailable');
});

it('rejects blocking improvement metadata and unknown executable trigger patterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-gate-metadata-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL('../../../templates', import.meta.url)), dir, { recursive: true });
  const perf = join(dir, 'roles/development/DEV-PERF.md');
  const original = readFileSync(perf, 'utf8');
  writeFileSync(perf, original.replace('blocking: false', 'blocking: true'));
  expect(() => loadTemplates(dir)).toThrow(/improvementLanes/);
  writeFileSync(perf, original);
  const sec = join(dir, 'roles/development/DEV-SEC.md');
  writeFileSync(sec, readFileSync(sec, 'utf8').replace('diffPatterns: [route, sql, subprocess]', 'diffPatterns: [custom-regex]'));
  expect(() => loadTemplates(dir)).toThrow(/gateTriggers/);
});
