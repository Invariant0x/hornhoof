import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_KEYS, type TemplateKey } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, departments } from '../src/db/schema.js';
import { instructionsOf, renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';
import { as, setUpCompany, TEST_API_KEY, testApp } from './helpers.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);

/* Default selections are preserved; the selected ability plans checks for its assigned scope in any department. */
const STANDALONE_PIPELINES = {
  operations: 'ops-work-pipeline', development: 'dev-work-pipeline', design: 'dsn-work-pipeline',
  marketing: 'mkt-work-pipeline', sales: 'sal-work-pipeline', business_development: 'biz-work-pipeline',
  support: 'sup-work-pipeline', finance: 'fin-work-pipeline', home_devices: 'home-work-pipeline', household: 'home-work-pipeline',
};
const PIPELINES: Record<TemplateKey, string> = { ...STANDALONE_PIPELINES, video_production: 'vid-work-pipeline' };
const SKILL_IDS = [...new Set(Object.values(STANDALONE_PIPELINES))];
const bodyOf = (id: string) => templates.skills.get(id)!.body;
const localIds = /\b(?:dev|dsn|fin|sup|ops|sal|mkt|biz|home|hh|orch)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;

/* Assertions protect meaning and evidence, not one heading layout, role roster or review schedule. */
const COMMON = [
  /assign(?:ment|ed)/i,
  /task(?:s| gates)?/i,
  /scope|candidate|output|records/i,
];
const POINTS: Record<string, RegExp[]> = {
  'sup-work-pipeline': [
    /sort each ticket by type and impact/i,
    /refer unresolved cases to the head or the person responsible/i,
    /highest urgency[\s\S]*security or privacy[\s\S]*at once/i,
    /Replies go from the department's own mailbox[\s\S]*sign-in only in the vault[\s\S]*phone queue/i,
    /Every contact is marked at once in the department's git[\s\S]*committed/i,
    /asked not to be written to is marked so and never written to again/i,
    /customer's language, with no silent language fallback/i,
    /untrusted data[\s\S]*sign-in stays in the vault[\s\S]*raw secrets/i,
    /timestamps[\s\S]*never estimated/i,
    /failed sample[\s\S]*every reply/i,
  ],
  'fin-work-pipeline': [
    /budget, business need, vendor, terms and applicable department limit/i,
    /material figures, source records and tolerance/i,
    /checker must not be its maker[\s\S]*without fixing/i,
    /a person pays or signs/i,
    /sample[\s\S]*without the maker's help/i,
  ],
  'dsn-work-pipeline': [
    /states[\s\S]*widths[\s\S]*themes[\s\S]*languages/i,
    /independent checker is not the author[\s\S]*does not edit/i,
    /contrast[\s\S]*token use[\s\S]*overflow/i,
    /breaking system change needs the decision of the department's own responsible people[\s\S]*cost/i,
  ],
  'ops-work-pipeline': [
    /blast radius[\s\S]*rollback/i,
    /orchestrator applies machine grants/i,
    /route that can supply any independent security check required by the risk/i,
    /failed check[\s\S]*rollback before investigation/i,
    /valid and rejected cases/i,
  ],
  'home-work-pipeline': [
    /Check changes to devices and scenes on each affected device[\s\S]*restore the previous setting/i,
    /Irreversible deletion needs the CEO's yes[\s\S]*a person makes payments and signs in the company's name/i,
    /Streams and recordings need a separate assignment and existing access/i,
    /Group routine checks and changes the notebook allows/i,
    /private to the home[\s\S]*never ask for or store card, bank or account secrets/i,
  ],
  'sal-work-pipeline': [
    /claims, links, prices and "do not write" marks[\s\S]*daily limits/i,
    /every contact is marked in the department's git at once and committed/i,
    /Sign-ins stay in the vault/i,
    /second read by another employee in a fresh context/i,
    /Custom prices and discounts go by the department's price rule/i,
    /waits for nobody unless its department set an approval rule[\s\S]*human signs contracts/i,
    /stop condition before sending[\s\S]*verifies the cause and correction/i,
  ],
  'mkt-work-pipeline': [
    /Public items wait for nobody unless the department set an approval rule/i,
    /deletion of a public record for good needs the CEO's yes/i,
    /Sign-ins stay in the vault, and every post is marked in the department's git at once and committed/i,
    /prices, claims and links[\s\S]*"do not write" marks[\s\S]*limits/i,
    /second read by another employee in a fresh context/i,
    /stop condition before sending[\s\S]*verifies the cause and correction/i,
  ],
  'biz-work-pipeline': [
    /supporting facts with the partner records[\s\S]*send contracts to their signer/i,
    /score totals[\s\S]*market-size arithmetic[\s\S]*sourced inputs[\s\S]*formulas or a script/i,
    /unsupported number is a finding/i,
    /decisions need independent assessment/i,
  ],
  'dev-work-pipeline': [
    /task, employee assignment[\s\S]*rather than a fixed sequence of roles/i,
    /risk and required independent checks in the assigned route before integrating/i,
    /one pinned commit[\s\S]*full candidate validation is assigned/i,
    /collected graph[\s\S]*not execution evidence/i,
    /neither creates a tester handoff nor changes the department's release approval policy/i,
  ],
};

function problemsOf(id: string, body: string): string[] {
  const problems = [...COMMON, ...(POINTS[id] ?? [])].filter(rule => !rule.test(body)).map(rule => `missing ${rule}`);
  for (const ref of new Set(body.match(localIds) ?? [])) problems.push(`skill dependency ${ref}`);
  if (/[Ѐ-ӿ]|\b(?:Claude|Codex|GitHub)\b|#\d+|\b202\d-\d{2}-\d{2}\b|@\S+\.\S+|\/(?:Users|home)\/\w+/.test(body)) problems.push('incident or non-English body');
  if (/\bper-item approval\b|\bexplicit (?:human )?approval of each\b/i.test(body)) problems.push('a person\'s yes to what goes out by default');
  return problems;
}

describe('standalone verification planning abilities', () => {
  it.each(TEMPLATE_KEYS)('preserves the default selected planning ability for %s', key => {
    const [head] = templates.roster(key);
    expect(head!.skills.find(s => s.id === PIPELINES[key])).toMatchObject({ on: true, locked: false });
  });

  it.each(SKILL_IDS)('%s retains domain safeguards without a role workflow or skill dependency', id => {
    expect(templates.skills.get(id)).toMatchObject({ kind: 'procedure', grants: [] });
    expect(problemsOf(id, bodyOf(id))).toEqual([]);
  });

  it.each(SKILL_IDS)('%s is delivered alone to a worker in another department', id => {
    const role = templates.roles.get('DEV-ENG')!;
    const rendered = renderInstructions(templates, { id: 'a', companyId: 'c', kind: 'worker', name: 'Ari', roleKey: role.id, skills: [id], overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });
    expect(rendered.skills.find(file => file.name === id)?.body).toContain(bodyOf(id));
    for (const other of SKILL_IDS.filter(other => other !== id)) expect(rendered.skills.some(file => file.name === other)).toBe(false);
    expect(rendered.raw).not.toMatch(/when that one is not on your list/);
  });

  it.each([
    ['responsible decision owner', (body: string) => body.replace('Refer unresolved cases to the head or the person responsible', 'Decide unresolved cases yourself')],
    ['the record in git', (body: string) => body.replaceAll("department's git", "head's memory")],
    ['skill dependency', (body: string) => `${body} Follow sup-support-policy.`],
    ['incident', (body: string) => `${body} See task #42.`],
    ['the stop mark', (body: string) => body.replace('never written to again', 'written to again later')],
    ['no default yes to what goes out', (body: string) => `${body} Public items require explicit human approval of each exact rendered item.`],
  ])('rejects loss of %s', (_, broken) => {
    const original = bodyOf('sup-work-pipeline');
    const changed = broken(original);
    expect(changed).not.toBe(original);
    expect(problemsOf('sup-work-pipeline', original)).toEqual([]);
    expect(problemsOf('sup-work-pipeline', changed)).not.toEqual([]);
  });

  it('goes through the one loader: a head that names it without its file does not load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-pipeline-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DIR, dir, { recursive: true });
    rmSync(join(dir, 'skills', 'sup-work-pipeline.md'), { force: true });
    expect(() => loadTemplates(dir)).toThrow(/SUP-HEAD\.md names the skill sup-work-pipeline/);
  });

  it('reaches a head hired from the roster of each department, as a file and whole on a node that writes none', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: TEMPLATE_KEYS.map(template => ({ template })) }, ...as(ceo) });
    expect(built.statusCode).toBeLessThan(300);
    const plan = await app.inject({ method: 'POST', url: '/api/subscriptions', payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Team key', apiKey: TEST_API_KEY, target: { kind: 'any' } }, ...as(ceo) });
    const subscription = plan.json().subscription.id as string;
    const seen = new Set<string>();
    for (const dept of await db.select().from(departments).where(isNull(departments.parentId))) {
      const key = dept.templateKey as TemplateKey;
      const { people } = (await app.inject({ url: `/api/departments/${dept.id}/roster`, ...as(ceo) })).json() as { people: object[] };
      const hired = await app.inject({ method: 'POST', url: `/api/departments/${dept.id}/staff`, payload: { people: people.map(line => ({ ...line, subscription })) }, ...as(ceo) });
      expect(hired.statusCode, `${key}: ${hired.body}`).toBe(201);
      const [head] = await db.select().from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head')));
      const id = PIPELINES[key];
      const asFile = await instructionsOf(app.ctx, head!);
      expect(asFile.skills.find(f => f.name === id)?.body, key).toContain(bodyOf(id));
      expect(asFile.text, key).toContain(`\n- ${id}: `);
      seen.add(key);
    }
    expect([...seen].sort()).toEqual([...TEMPLATE_KEYS].sort());
  });
});
