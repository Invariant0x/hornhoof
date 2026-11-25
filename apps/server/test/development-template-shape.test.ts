import { eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { departments, teams } from '../src/db/schema.js';
import { loadTemplates } from '../src/modules/templates/load.js';
import { as, sessionFrom, SETUP, testApp } from './helpers.js';
import { TestEnvironmentV1 } from '@hornhoof/protocol';

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
    expect(templates.teamsOf('development')).toEqual([expect.objectContaining({ id: 'DEV-TEAM', turnkey: false, urgentOnly: true, members: [{ role: 'DEV-HOT', count: 1 }] })]);
    expect(templates.teams.get('DEV-TEAM')!.title).toEqual({ en: 'Hotfix', ru: expect.stringContaining('Hotfix') });
  });

  /* Its own role text and a light skill set: read the cause, the smallest change, check the touched files locally, three lines. */
  it('has its own role, whose text and skills are for an urgent fix and not for the pipeline', () => {
    const role = templates.roles.get('DEV-HOT')!;
    expect(role).toMatchObject({ department: 'development', kind: 'member' });
    expect(role.body).toMatch(/hotfix engineer[^.]*smallest safe change/i);
    expect(role.skills.filter(s => s.on).map(s => s.id)).toEqual(['dev-hotfix', 'dev-debugging', 'dev-engineering-rules', 'dev-language-rules', 'hh-work-fast']);
    expect(templates.teams.get('DEV-TEAM')!.skills).toEqual([]);
    expect(templates.roster('development').find(r => r.id === 'DEV-HOT')!.inDefault).toBe(false);
  });

  it('is taught to read the cause, make the smallest change, check only the touched files locally and report in three lines', () => {
    const skill = body('dev-hotfix');
    expect(skill).toMatch(/Read the cause before you touch code/);
    expect(skill).toMatch(/smallest change that removes that cause/);
    expect(skill).toMatch(/Check only the files you touched, locally in your own workspace[^.]*type check, lint and the one or two test files/);
    expect(skill).toMatch(/Run no whole suite, no run_tests, no browser or end-to-end test/);
    expect(skill).toMatch(/Land it on the branch the task names/);
    expect(skill).toMatch(/touches access, secrets, root processes, deletion of data or files, or the checks themselves gets its own independent Security read[^.]*any other fix goes on the strength of the release's batch stages/);
    expect(skill).toMatch(/Report in three lines: the cause, the change, and what you ran/);
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

/* When the department works and when it stands: the way its turns start is a setting of the department, a batch that is being
   checked is not joined, and a department that waits for a person is idle and says so. */
describe('the Development skills on when the department stands', () => {
  it('tell the head that a department starts its next turn by itself or only on a person\'s confirmation, and that Development waits for the person', () => {
    const lead = body('dev-lead');
    expect(lead).toMatch(/starts its next turn in one of two ways, a setting of the department/);
    expect(lead).toMatch(/automatically, so that after a release the next turn opens by itself and takes the queue in/);
    expect(lead).toMatch(/only on a person's confirmation, so that after a release the department stands, idle and shown as waiting, and nobody works the queue until a person confirms the turn/);
    expect(lead).toMatch(/Development starts in the second way/);
    expect(lead).toMatch(/Tell the person when a turn waits for them/);
  });

  it('freeze the batch from the cut of the release branch: nothing joins it and a new task waits for the next turn', () => {
    expect(body('dev-lead')).toMatch(/before the release branch is cut[\s\S]*from the cut the batch is frozen, nothing joins it, and a new task waits in the queue for the next turn/);
    expect(body('dev-task-flow')).toMatch(/From the moment the release branch is cut, while it is in Review, Security, Tests and the release, the department's developers do not start the next turn: nothing joins the batch, and a new task waits in the queue/);
  });

  it('make the developers stand while the batch is checked and after a release that waits for a person, and let only the hotfix lane and the current release go on', () => {
    const flow = body('dev-task-flow');
    expect(flow).toMatch(/Stand while the batch is checked/);
    expect(flow).toMatch(/Only the hotfix lane, and work that goes into the current release, go on/);
    expect(flow).toMatch(/starts its turns only on a person's confirmation, which Development does by default, the department stands, idle and shown as waiting, until that person confirms the turn/);
    expect(flow).toMatch(/you take no new task of your own/);
    expect(flow).not.toMatch(/Go straight on to your next task|for no next turn to open/);
    expect(body('dev-lead')).toMatch(/your developers stand; only the hotfix lane, and work that goes into the current release, go on/);
  });
});

/* Checks that need no service never wait on another machine, and the whole suite runs once per release through the check the
   project declares, started by nobody but the Tests stage. */
describe('the skills on where checks run', () => {
  const NO_SERVICE = /(?:every|a) check that needs no service/i;

  it('run a check that needs no service at once in the workspace, never queued on another machine, a service check through the warm test environment, and only a check that cannot run there through run_tests', () => {
    expect(body('hh-run-checks')).toMatch(/Run at once, in your own workspace, every check that needs no service: types, lint, unit tests, web tests and the tests of the files you touched\. Such a check is never queued on another machine\. A check that needs a service goes through the project's warm test environment\. Only a check that cannot run in your workspace at all goes to run_tests/);
    expect(body('dev-task-flow')).toMatch(/every check that needs no service \(types, lint, unit and web tests, the tests of the files you touched\): it is never queued on another machine/);
    expect(body('dev-testing-policy')).toMatch(/A check that needs no service[^.]*runs there at once and never waits in a queue on another machine[^.]*warm test environment[^.]*only a check that cannot run in your workspace at all goes to run_tests/);
    for (const id of ['hh-run-checks', 'dev-task-flow', 'dev-testing-policy']) expect(body(id), id).toMatch(NO_SERVICE);
  });

  it('run the whole suite exactly once per release, in the Tests stage, through the release check the project declares, and let nobody else start it or repeat it', () => {
    const checks = body('hh-run-checks');
    expect(checks).toMatch(/The whole suite runs exactly once per release, right before the release, in the Tests stage, through the release check the project declares\./);
    expect(checks).toMatch(/Nobody else runs the whole suite: developers, Review, Security and the hotfix lane check only what they touched, locally\./);
    expect(checks).toMatch(/The same scope is never run twice/);
    expect(body('dev-gates')).toMatch(/exactly once per release, right before the release, in the Tests stage, through the release check the project declares: its CI, a command of its own, or one run of the shared runner[^.]*Developers, Review, Security and the hotfix lane never start it/);
    expect(body('dev-testing-policy')).toMatch(/exactly once per release, in the Tests stage, through the release check the project declares/);
    expect(body('dev-task-flow')).toMatch(/never the whole suite: the Tests stage runs it exactly once per release, through the release check the project declares/);
  });

  it('say it of no host and no kind of repository: the rule names the declared check, whatever the project has', () => {
    for (const id of ['hh-run-checks', 'dev-hotfix', 'dev-task-flow', 'dev-gates']) expect(body(id), id).not.toMatch(/github|git ci\b|\bgitlab\b/i);
  });

  it('are declared by the project beside its full run: a mechanism of its own CI, a command, or one run of the shared runner', () => {
    const manifest = TestEnvironmentV1.parse(JSON.parse(readFileSync(join(TEMPLATES, '..', '.hornhoof', 'test-environment.json'), 'utf8')));
    expect(manifest.execution?.fullRun).toBeDefined();
    expect(manifest.execution?.releaseCheck).toEqual({ mechanism: 'ci' });
  });
});
