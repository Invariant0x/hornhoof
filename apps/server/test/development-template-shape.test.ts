import { eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { departments, teams } from '../src/db/schema.js';
import { loadTemplates } from '../src/modules/templates/load.js';
import { as, sessionFrom, SETUP, testApp } from './helpers.js';

/* The shape Ivan gave Development on 24.11 for every new company: the code pipeline is a tree (Development first, Review after
   it, then Security and Tests and the release; Architecture on request as a fork from Development), no turnkey team, one
   urgent-only unit named Hotfix, and five slots. The two non-code pipelines stay chains. */

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(TEMPLATES);
const CODE = 'development-changes';
const body = (id: string) => templates.skills.get(id)!.body;

describe('the code pipeline of the Development template', () => {
  const stages = templates.catalogs.get('development')!.pipelines.find(p => p.key === CODE)!.stages;
  const parentOf = (name: string) => stages.find(s => s.name === name)!.parent;

  it('starts at Development and runs Review, Security, Tests and the release in turn after it', () => {
    expect(stages[0]).toMatchObject({ name: 'Build the change', echelon: 'development' });
    expect(stages[0]!.parent).toBeUndefined();
    expect(parentOf('Review the change')).toBe('Build the change');
    expect(parentOf('Check security')).toBe('Tidy the change');
    expect(parentOf('Tidy the change')).toBe('Review the change');
    expect(parentOf('Run tests')).toBe('Check security');
    expect(parentOf('Release the turn')).toBe('Run tests');
  });

  it('puts Architecture on request as a fork from Development, not a stage ahead of it', () => {
    expect(parentOf('Plan the change')).toBe('Build the change');
    expect(stages.findIndex(s => s.name === 'Plan the change')).toBeGreaterThan(0);
  });

  it('leaves the technical guides and the release pipelines as chains', () => {
    for (const key of ['development-docs', 'development-release']) {
      const pipeline = templates.catalogs.get('development')!.pipelines.find(p => p.key === key)!;
      expect(pipeline.stages.some(s => s.parent !== undefined), key).toBe(false);
    }
  });

  /* A parent must be a stage before the stage that names it, or the template does not load. */
  it.each([
    ['a parent that is no stage of the pipeline', (text: string) => text.replace('parent: "Build the change"', 'parent: "Nobody"')],
    ['a parent that comes after the stage', (text: string) => text.replace('echelon: "development" }', 'echelon: "development", parent: "Run tests" }')],
  ])('refuses %s', (_, change) => {
    const copy = mkdtempSync(join(tmpdir(), 'hornhoof-shape-'));
    onTestFinished(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(TEMPLATES, copy, { recursive: true });
    const file = join(copy, 'pipelines', 'development.md');
    const text = readFileSync(file, 'utf8');
    expect(change(text)).not.toBe(text);
    writeFileSync(file, change(text));
    expect(() => loadTemplates(copy)).toThrow(/names .* as its parent, which is no stage before it/);
  });
});

describe('the Hotfix unit of the Development template', () => {
  it('is the one team of the department: urgent work only, no turnkey, one developer', () => {
    expect(templates.teamsOf('development')).toEqual([expect.objectContaining({ id: 'DEV-TEAM', turnkey: false, urgentOnly: true, members: [{ role: 'DEV-ENG', count: 1 }] })]);
    expect(templates.teams.get('DEV-TEAM')!.title).toEqual({ en: 'Hotfix', ru: expect.stringContaining('Hotfix') });
  });

  it('leaves no turnkey team in Development, while the other departments keep theirs', () => {
    const turnkey = [...templates.teams.values()].filter(t => t.turnkey).map(t => t.department);
    expect(turnkey).not.toContain('development');
    expect(turnkey.length).toBeGreaterThan(0);
  });
});

describe('a new company', () => {
  async function company() {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' }, template: 'project' } });
    expect(res.statusCode).toBe(201);
    const ceo = sessionFrom(res);
    const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
    return { app, db, ceo, dev: dev! };
  }

  it('gets a Development department with the pipeline as a tree, five slots and one Hotfix unit that takes only urgent work', async () => {
    const { app, db, ceo, dev } = await company();
    expect(dev.slotCap).toBe(5);
    expect(await db.select().from(teams).where(eq(teams.departmentId, dev.id))).toEqual([expect.objectContaining({ name: 'Hotfix', urgentOnly: true, turnkey: false })]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json().departments.find((d: { id: string }) => d.id === dev.id);
    const code = org.pipelines.find((p: { catalogKey: string }) => p.catalogKey === CODE);
    const byName = new Map<string, { id: string; parentId: string | null }>(code.stages.map((s: { name: string; id: string; parentId: string | null }) => [s.name, s]));
    const up = (name: string) => byName.get(name)!.parentId;
    expect(up('Build the change')).toBeNull();
    expect(up('Plan the change')).toBe(byName.get('Build the change')!.id);
    expect(up('Review the change')).toBe(byName.get('Build the change')!.id);
    expect(up('Check security')).toBe(byName.get('Tidy the change')!.id);
    expect(up('Run tests')).toBe(byName.get('Check security')!.id);
    expect(up('Release the turn')).toBe(byName.get('Run tests')!.id);
    const docs = org.pipelines.find((p: { catalogKey: string }) => p.catalogKey === 'development-docs');
    expect(docs.stages.map((s: { parentId: string | null }, i: number) => s.parentId === (i ? docs.stages[i - 1].id : null))).toEqual([true, true, true, true]);
  });
});

/* What the head and the developers read: the batch stages, the two modes of a stage with several members, the shared lanes. */
describe('the Development skills', () => {
  it('give a stage with several members two modes, pieces and whole batch each, with branches cut from the turn branch and merged by the head', () => {
    for (const id of ['dev-gates', 'dev-lead']) {
      expect(body(id), id).toMatch(/"Pieces"|"pieces"/);
      expect(body(id), id).toMatch(/"Whole batch each"|"whole batch each"/);
      expect(body(id), id).toMatch(/own branch cut from the turn branch/);
      expect(body(id), id).toMatch(/head merges their branches into one|merge their branches into one/);
    }
    expect(body('dev-gates')).toMatch(/same subscription use "pieces"[^.]*"whole batch each" is only for members on different subscriptions or models/);
    expect(body('dev-gates')).toMatch(/one member of a stage for each distinct subscription/i);
  });

  it('keep the head to five developers, a queue behind the slots, several pipelines side by side and one Hotfix lane for all of them', () => {
    expect(body('dev-lead')).toMatch(/up to five developers[^.]*never more unless the CEO orders it/);
    expect(body('dev-lead')).toMatch(/waits in the queue for the next turn/);
    expect(body('dev-lead')).toMatch(/several pipelines side by side[\s\S]*only you link them and accept done or not done for all of them/);
    expect(body('dev-lead')).toMatch(/hotfix lane and Performance serve every pipeline/);
  });

  it('send no developer to a per-task Review, Security or Tests, and no one back to a developer', () => {
    expect(body('dev-task-flow')).toMatch(/own route is Development only/);
    expect(body('dev-task-flow')).toMatch(/Start no shared test run for the task/);
    expect(body('dev-gates')).toMatch(/nothing returns to the developer who wrote the code/);
  });
});
