import { fileURLToPath } from 'node:url';
import { OLD_NODE_INSTRUCTIONS } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import type { agents } from '../src/db/schema.js';
import { orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates, textHash, type Role, type Skill, type SkillKind, type Templates } from '../src/modules/templates/load.js';

const skill = (id: string, title: string, body: string, kind: SkillKind = 'procedure', description = ''): Skill => ({
  id,
  title: { en: title, ru: title },
  description: { en: description, ru: description },
  kind,
  body,
  hash: textHash(body),
  sources: [],
  grants: [],
});

const ROLE: Role = {
  id: 'DEV-BE',
  department: 'development',
  kind: 'member',
  title: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' },
  description: { en: '', ru: '' },
  tier: 'standard',
  perProduct: false,
  inDefault: true,
  gate: null,
  schema: null,
  timer: null,
  skills: [
    { id: 'hh-report-to-head', on: true, locked: true },
    { id: 'dev-tdd', on: true, locked: false },
    { id: 'dev-migrations', on: false, locked: false },
  ],
  body: 'You own the server side.',
  hash: textHash('You own the server side.'),
};

const SKILLS = [
  skill('hh-report-to-head', 'Report to your head', 'Report in five lines.', 'core'),
  skill('dev-tdd', 'Test first', 'Write the test first.', 'procedure', 'Writes the test before the code.'),
  skill('dev-migrations', 'Migrations', 'Never edit a shipped migration.'),
];

const T: Templates = { roles: new Map([[ROLE.id, ROLE]]), skills: new Map(SKILLS.map(s => [s.id, s])), roster: () => [ROLE] };

type AgentRow = typeof agents.$inferSelect;

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000002',
  kind: 'worker',
  name: 'Bruno',
  model: 'sonnet',
  departmentId: null,
  teamId: null,
  subscriptionId: null,
  nodeId: null,
  roleKey: 'DEV-BE',
  skills: ['hh-report-to-head', 'dev-tdd'],
  overrides: {},
  templateHashes: { 'DEV-BE': ROLE.hash, 'hh-report-to-head': SKILLS[0]!.hash, 'dev-tdd': SKILLS[1]!.hash },
  productId: null,
  createdBy: null,
  switchedOffAt: null,
  contextUsed: null,
  effort: null,
  timerMinutes: null,
  timerOrder: null,
  timerAt: null,
  timerForWork: false,
  removedAt: null,
  createdAt: new Date(),
  ...over,
});

const PLACE = { company: 'Acme', department: 'Development', product: 'Mascot' };

describe('renderInstructions', () => {
  it('shows the header, the role and each enabled skill between markers on the card', () => {
    const { parts, raw } = renderInstructions(T, agent(), PLACE);
    expect(parts.map(p => [p.kind, p.id])).toEqual([
      ['header', null],
      ['base', 'DEV-BE'],
      ['skill', 'hh-report-to-head'],
      ['skill', 'dev-tdd'],
    ]);
    expect(parts[0]!.text).toContain('You are Bruno, the Backend engineer of the Development department at Acme, working on Mascot.');
    expect(parts[0]!.text).toContain('Hornhoof');
    expect(parts[0]!.text).toContain('Work comes to you as tasks');
    expect(parts[0]!.text).toContain('When your conversation was compacted');
    expect(parts[0]!.text).not.toContain('later version');
    expect(parts[1]!.text).toBe('You own the server side.');
    expect(parts[3]!.text).toBe('<!-- hh:skill dev-tdd -->\n## Test first\n\nWrite the test first.\n<!-- /hh:skill -->');
    expect(raw).toBe(parts.map(p => p.text).join('\n\n'));
    expect(raw).not.toContain('Never edit a shipped migration.');
    expect(parts.every(p => !p.overridden && !p.templateChanged)).toBe(true);
  });

  it('tells the program its role and core rules whole and its other skills as a list, which go to the node as files', () => {
    const { parts, text, hash, skills } = renderInstructions(T, agent(), PLACE);
    expect(text.startsWith(`${parts[0]!.text}\n\nYou own the server side.\n\n${parts[2]!.text}\n\n## Skills`)).toBe(true);
    expect(text).not.toContain('Write the test first.');
    expect(text).toContain('\n- dev-tdd: Test first. Writes the test before the code.');
    expect(text).toContain('.claude/skills/<name>/SKILL.md');
    expect(text).toContain('.agents/skills/<name>/SKILL.md');
    expect(text).not.toContain('dev-migrations');
    expect(skills).toEqual([{ name: 'dev-tdd', description: 'Test first. Writes the test before the code.', body: '# Test first\n\nWrite the test first.' }]);
    expect(hash).toBe(textHash(text));
  });

  it('keeps the program going when only a skill body changes, which it reads from its file', () => {
    const before = renderInstructions(T, agent(), PLACE);
    const rewritten = renderInstructions(T, agent({ overrides: { skills: { 'dev-tdd': 'Tests come first, always.' } } }), PLACE);
    expect(rewritten.hash).toBe(before.hash);
    expect(rewritten.skills[0]!.body).toBe('# Test first\n\nTests come first, always.');
    const off = renderInstructions(T, agent({ skills: ['hh-report-to-head'] }), PLACE);
    expect(off.hash).not.toBe(before.hash);
    expect(off.skills).toEqual([]);
    expect(off.text).not.toContain('## Skills');
  });

  it('names the human partner the superpowers skills speak of and says a task from the head is approved', () => {
    const member = renderInstructions(T, agent(), PLACE).parts[0]!.text;
    expect(member).toContain('superpowers');
    expect(member).toContain('is whoever gave you the task: your head, or the person who wrote to you');
    expect(member).toContain('A task your head gave you is already approved');
    expect(member).toContain('never by waiting for an answer in your terminal');
    expect(member).toContain('Use it only when your task asks for a design');
    expect(member).toContain('A small task needs no written plan: test, code, check, submit. writing-plans and executing-plans are for a new or large feature only.');
    const head = renderInstructions(T, agent({ kind: 'head' }), PLACE).parts[0]!.text;
    expect(head).toContain('is whoever gave you the task: the orchestrator, or the person who wrote to you');
    expect(head).toContain('A task the orchestrator gave you is already approved');
    expect(head).toContain('you and your architects use it only when a task asks for a design');
  });

  it("tells employees and the orchestrator that Claude Code's SendMessage reaches no one in Hornhoof", () => {
    const told = [renderInstructions(T, agent(), PLACE).text, renderInstructions(T, agent({ kind: 'head' }), PLACE).text, orchestratorSteady(T).text];
    for (const text of told) {
      expect(text).toContain('When you run in Claude Code, never answer with its SendMessage tool: what it sends reaches no one in Hornhoof.');
      expect(text).toContain("Answer in your reply or with Hornhoof's tools.");
    }
  });

  it('keeps every skill whole in the text for a node that writes no skill files, as before', () => {
    const { parts, whole } = renderInstructions(T, agent(), PLACE);
    expect(whole.startsWith('You are Bruno')).toBe(true);
    expect(whole).toContain('\n\nYou own the server side.\n\n');
    expect(whole.endsWith(`${parts[2]!.text}\n\n${parts[3]!.text}`)).toBe(true);
    /* Such a node has no superpowers and no files to list. */
    expect(whole).not.toContain('superpowers');
    expect(whole).not.toContain('## Skills');
  });

  it('keeps that text whole however long it is, and a turn too long for the node does not go out', () => {
    const long = 'Test first. '.repeat(2000);
    const { whole } = renderInstructions(T, agent({ overrides: { skills: { 'dev-tdd': long } } }), PLACE);
    expect(whole.length).toBeGreaterThan(OLD_NODE_INSTRUCTIONS);
    expect(whole).toContain(`${long}\n<!-- /hh:skill -->`);
  });

  it("uses an override instead of the template's text and marks it", () => {
    const { parts } = renderInstructions(T, agent({ overrides: { base: 'You own the API.', skills: { 'dev-tdd': 'Tests come first, always.' } } }), PLACE);
    expect(parts[1]).toMatchObject({ text: 'You own the API.', overridden: true });
    expect(parts[3]).toMatchObject({ overridden: true });
    expect(parts[3]!.text).toContain('Tests come first, always.');
    expect(parts[2]!.overridden).toBe(false);
  });

  it('marks a part whose template moved on since the employee was hired', () => {
    const { parts } = renderInstructions(T, agent({ templateHashes: { 'DEV-BE': 'old000000000', 'hh-report-to-head': SKILLS[0]!.hash, 'dev-tdd': 'old111111111' } }), { ...PLACE, product: null });
    expect(parts.map(p => p.templateChanged)).toEqual([false, true, false, true]);
    expect(parts[0]!.text).toContain('the Backend engineer of the Development department at Acme.');
  });

  it('delivers differential second-look, author evidence and provenance rules in DEV-REV and DEV-SEC skill files', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-REV', 'DEV-SEC'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      const delivered = rendered.skills.map(s => s.body).join('\n\n');
      expect(delivered, roleKey).toContain('first look');
      expect(delivered, roleKey).toContain('reviewedCommit..fixCommit');
      expect(delivered, roleKey).not.toContain('at high effort');
      expect(rendered.whole, roleKey).toContain('reviewedCommit..fixCommit');
    }
    const revRole = shipped.roles.get('DEV-REV')!;
    const revRendered = renderInstructions(shipped, agent({ roleKey: 'DEV-REV', skills: revRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
    const revFiles = new Map(revRendered.skills.map(s => [s.name, s.body]));
    expect(revFiles.get('dev-review-diff')).toContain('task.reviewPlan');
    expect(revFiles.get('dev-review-diff')).toContain('task.fixReview');
    expect(revFiles.get('dev-review-verdict')).toContain('confirm_finding');
    expect(revFiles.get('dev-review-verdict')).toMatch(/internal role or skill rules[^.!?]*never[^.!?]*(?:main|release) approval/i);
  });

  it('delivers the mandatory UI panel-wrapping and dynamic language rule to DEV-ENG and DEV-FE through pointers, on-demand skill files and whole instructions', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-ENG', 'DEV-FE'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      expect(rendered.text, roleKey).toContain('.agents/skills/<name>/SKILL.md');
      expect(rendered.text, roleKey).toContain('.claude/skills/<name>/SKILL.md');
      expect(rendered.text, roleKey).toContain('\n- dev-frontend-ui: User interface engineering.');
      const uiSkill = rendered.skills.find(s => s.name === 'dev-frontend-ui');
      expect(uiSkill, roleKey).toBeDefined();
      expect(Buffer.byteLength(uiSkill!.body), roleKey).toBeLessThan(22_000);
      for (const delivered of [uiSkill!.body, rendered.whole]) {
        expect(delivered, roleKey).toMatch(/whole group|together as one group/i);
        expect(delivered, roleKey).toMatch(/non-visual[\s\S]*in parallel/i);
        expect(delivered, roleKey).toMatch(/longest[\s\S]*shortest[\s\S]*(?:shipped|supported)/i);
        expect(delivered, roleKey).toMatch(/explicit[\s\S]*browser default[\s\S]*scrollbar space/i);
        expect(delivered, roleKey).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
      }
    }
  });

  it('delivers internal-first hh-questions with its Materials guidance inline across files=true and files=false for workers, heads and the orchestrator within byte budgets', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-ENG', 'DEV-FE', 'DEV-HEAD', 'DSN-UI', 'OPS-HEAD', 'OPS-WATCH'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const kind = role.kind === 'head' ? 'head' : 'worker';
      const skills = role.skills.filter(s => s.on).map(s => s.id);
      const rendered = renderInstructions(shipped, agent({ kind, roleKey, skills, templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      expect(rendered.skills.map(s => s.name), roleKey).not.toContain('hh-questions');
      for (const target of [rendered.text, rendered.whole]) {
        expect(target, roleKey).toContain('<!-- hh:skill hh-questions -->');
        expect(target, roleKey).toContain('ready_result');
        expect(target, roleKey).toContain('human_only_action');
        expect(target, roleKey).toContain('- **Materials**:');
        expect(target, roleKey).toMatch(/attach[\s\S]*materials[\s\S]*question tool/i);
        expect(target, roleKey).not.toContain('after three a person steps in');
      }
    }

    const steady = orchestratorSteady(shipped);
    expect(Buffer.byteLength(steady.text)).toBeLessThan(24_000);
    expect(steady.skills.map(s => s.name)).not.toContain('hh-questions');
    for (const target of [steady.text, steady.whole]) {
      expect(target).toContain('<!-- hh:skill hh-questions -->');
      expect(target).toContain('ready_result');
      expect(target).toContain('human_only_action');
      expect(target).toContain('- **Materials**:');
    }

    const devHead = shipped.roles.get('DEV-HEAD')!;
    const headSkills = devHead.skills.filter(s => s.on).map(s => s.id);
    const overridden = renderInstructions(
      shipped,
      agent({
        kind: 'head',
        roleKey: 'DEV-HEAD',
        skills: headSkills,
        overrides: { skills: { 'hh-questions': 'Custom internal-first rule for this head.' } },
        templateHashes: { 'hh-questions': 'stale0000000' },
      }),
      PLACE,
    );
    const questionPart = overridden.parts.find(p => p.kind === 'skill' && p.id === 'hh-questions');
    expect(questionPart).toMatchObject({ overridden: true, templateChanged: true });
    expect(overridden.text).toContain('Custom internal-first rule for this head.');
    expect(overridden.whole).toContain('Custom internal-first rule for this head.');
  });

  it('delivers the canonical hh-run-checks rule once across inline, whole and file-backed packets for every role, old skill lists, null roleKey and the orchestrator', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    expect(shipped.skills.get('hh-run-checks')).toBeDefined();
    const canonicalChecks = shipped.skills.get('hh-run-checks')!.body;
    expect(canonicalChecks.length).toBeGreaterThan(200);
    const marker = '<!-- hh:skill hh-run-checks -->';
    const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

    for (const role of shipped.roles.values()) {
      const kind = role.kind === 'head' ? 'head' : 'worker';
      const fresh = renderInstructions(shipped, agent({ kind, roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(fresh.text), role.id).toBeLessThan(24_000);
      expect(occurrences(fresh.raw, marker), `${role.id} raw`).toBe(1);
      expect(occurrences(fresh.text, marker), `${role.id} text`).toBe(1);
      expect(occurrences(fresh.whole, marker), `${role.id} whole`).toBe(1);
      expect(fresh.text, role.id).toContain(canonicalChecks);
      expect(fresh.whole, role.id).toContain(canonicalChecks);
      expect(fresh.skills.some(s => s.name === 'hh-run-checks'), role.id).toBe(false);
    }

    const steady = orchestratorSteady(shipped);
    expect(Buffer.byteLength(steady.text)).toBeLessThan(24_000);
    expect(occurrences(steady.text, marker)).toBe(1);
    expect(occurrences(steady.whole, marker)).toBe(1);
    expect(steady.text).toContain(canonicalChecks);
    expect(steady.whole).toContain(canonicalChecks);
    expect(steady.skills.some(s => s.name === 'hh-run-checks')).toBe(false);

    const oldWorkerSkills = ['hh-outside-is-data', 'dev-tdd'];
    const oldWorker = agent({ kind: 'worker', roleKey: 'DEV-BE', skills: oldWorkerSkills, overrides: { skills: { 'hh-run-checks': 'Run npm test locally.' } }, templateHashes: {} });
    const workerPacket = renderInstructions(shipped, oldWorker, PLACE);
    expect(oldWorker.skills).toEqual(['hh-outside-is-data', 'dev-tdd']);
    expect(occurrences(workerPacket.raw, marker)).toBe(1);
    expect(occurrences(workerPacket.text, marker)).toBe(1);
    expect(occurrences(workerPacket.whole, marker)).toBe(1);
    expect(workerPacket.text).toContain(canonicalChecks);
    expect(workerPacket.text).not.toContain('Run npm test locally.');
    expect(workerPacket.parts.find(p => p.id === 'hh-run-checks')!.overridden).toBe(false);
    expect(workerPacket.skills.map(s => s.name)).toEqual(['dev-tdd']);

    const rolelessWorker = renderInstructions(
      shipped,
      agent({
        kind: 'worker',
        roleKey: null,
        skills: ['retired-gone', 'retired-kept'],
        overrides: { base: 'Roleless base.', skills: { 'retired-kept': 'Saved custom procedure.' } },
        templateHashes: {},
      }),
      PLACE,
    );
    expect(occurrences(rolelessWorker.text, marker)).toBe(1);
    expect(rolelessWorker.text).toContain('Roleless base.');
    expect(rolelessWorker.text).toContain(canonicalChecks);
    expect(rolelessWorker.whole).toContain(canonicalChecks);
    expect(rolelessWorker.parts.some(p => p.id === 'retired-gone')).toBe(false);
    expect(rolelessWorker.skills.find(s => s.name === 'retired-kept')?.body).toContain('Saved custom procedure.');
  });

  it('delivers canonical hh-lead-tasks and hh-run-checks to existing department heads with stale skill lists, null roleKey or stored overrides without mutating stored skills', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    expect(shipped.skills.get('hh-run-checks')).toBeDefined();
    const canonicalLead = shipped.skills.get('hh-lead-tasks')!.body;
    const canonicalChecks = shipped.skills.get('hh-run-checks')!.body;
    expect(canonicalLead).toContain('External outages and holds:');

    const staleSkills = ['hh-outside-is-data'];
    const staleHead = agent({
      kind: 'head',
      roleKey: 'DEV-HEAD',
      skills: staleSkills,
      overrides: {
        skills: {
          'hh-lead-tasks': 'Keep holds in your own queue.',
          'hh-run-checks': 'Run full suites locally.',
        },
      },
      templateHashes: {},
    });
    const headPacket = renderInstructions(shipped, staleHead, PLACE);
    expect(staleHead.skills).toEqual(['hh-outside-is-data']);
    expect(Buffer.byteLength(headPacket.text)).toBeLessThan(24_000);
    expect(headPacket.text).toContain(canonicalLead);
    expect(headPacket.whole).toContain(canonicalLead);
    expect(headPacket.raw).toContain(canonicalLead);
    expect(headPacket.text).toContain(canonicalChecks);
    expect(headPacket.text).not.toContain('Keep holds in your own queue.');
    expect(headPacket.text).not.toContain('Run full suites locally.');
    expect(headPacket.parts.find(p => p.id === 'hh-lead-tasks')!.overridden).toBe(false);
    expect(headPacket.parts.find(p => p.id === 'hh-run-checks')!.overridden).toBe(false);

    const rolelessHead = renderInstructions(shipped, agent({ kind: 'head', roleKey: null, skills: [], templateHashes: {} }), PLACE);
    expect(Buffer.byteLength(rolelessHead.text)).toBeLessThan(24_000);
    expect(rolelessHead.text).toContain(canonicalLead);
    expect(rolelessHead.text).toContain(canonicalChecks);

    const mktHead = shipped.roles.get('MKT-HEAD')!;
    const headWithoutNotebookCast = renderInstructions(
      shipped,
      agent({ kind: 'worker', roleKey: 'MKT-HEAD', skills: mktHead.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
    expect(headWithoutNotebookCast.parts.some(p => p.id === 'hh-task-flow')).toBe(false);
    expect(headWithoutNotebookCast.parts.some(p => p.id === 'hh-report-to-head')).toBe(false);
  });

  it('delivers the strict mechanical finding category and Wake.mechanical boundary in loaded DEV-REV skill files and whole instructions', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const revRole = shipped.roles.get('DEV-REV')!;
    const rendered = renderInstructions(shipped, agent({ roleKey: 'DEV-REV', skills: revRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
    expect(Buffer.byteLength(rendered.text)).toBeLessThan(24_000);
    expect(rendered.text).toContain('\n- dev-review-diff: Reviewing a change.');
    expect(rendered.text).toContain('\n- dev-review-verdict: Review verdict.');
    const files = new Map(rendered.skills.map(s => [s.name, s.body]));
    for (const id of ['dev-review-diff', 'dev-review-verdict'] as const) {
      const body = files.get(id)!;
      expect(Buffer.byteLength(body), id).toBeLessThan(22_000);
      expect(body, id).toContain('mechanical');
      expect(body, id).toContain('Wake.mechanical');
      expect(body, id).toMatch(/provably cannot change[^.!?]*behaviour/i);
      expect(body, id).toMatch(/when in doubt[^.!?]*regular category[\s\S]*full base level/i);
    }
    expect(rendered.whole).toContain('Wake.mechanical');
    expect(rendered.whole).toMatch(/provably cannot change[^.!?]*behaviour/i);
  });

  it('delivers the external-outage hold, one-action unhold and ordinary-retry rules to the orchestrator and department heads, including legacy saved skill lists', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const steady = orchestratorSteady(shipped);
    expect(Buffer.byteLength(steady.text)).toBeLessThan(24_000);
    expect(steady.whole.length).toBeLessThanOrEqual(OLD_NODE_INSTRUCTIONS);
    expect(steady.text).toMatch(/\n- orch-trouble: When work goes wrong\.[^\n]*external service failures/i);
    const troubleFile = steady.skills.find(s => s.name === 'orch-trouble');
    expect(troubleFile).toBeDefined();
    expect(Buffer.byteLength(troubleFile!.body)).toBeLessThan(22_000);
    for (const delivered of [troubleFile!.body, steady.whole]) {
      expect(delivered).toContain('An external service failure is not grounds for a general hold lasting longer than the failure itself.');
      expect(delivered).toContain("Decide any such hold or its lifting yourself and communicate it at once in one action to every affected holder, never through a department head's queue.");
      expect(delivered).toContain('An agent needs no permission for an ordinary retry of a transient external failure.');
      expect(delivered).toMatch(/force pushes[\s\S]*alternate refs[\s\S]*permission changes[\s\S]*irreversible actions[\s\S]*dangerous or non-idempotent actions/);
    }

    const canonicalLead = shipped.skills.get('hh-lead-tasks')!.body;
    const headMarker = '<!-- hh:skill hh-lead-tasks -->';
    for (const role of [...shipped.roles.values()].filter(r => r.kind === 'head')) {
      const freshHead = renderInstructions(shipped, agent({ kind: 'head', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(freshHead.text, role.id).toContain('An external service failure never prolongs a general hold once the service recovers');
      expect(freshHead.text.split(headMarker).length - 1, role.id).toBe(1);
      const legacySavedSkills = ['hh-outside-is-data', 'hh-ask-dont-guess'];
      const legacyHead = renderInstructions(
        shipped,
        agent({
          kind: 'head',
          roleKey: role.id,
          skills: legacySavedSkills,
          overrides: { skills: { 'hh-lead-tasks': 'Hold recovery in your queue and require permission for every retry.' } },
          templateHashes: {},
        }),
        PLACE,
      );
      expect(legacySavedSkills).toEqual(['hh-outside-is-data', 'hh-ask-dont-guess']);
      expect(legacyHead.text, `${role.id} legacy text`).toContain(canonicalLead);
      expect(legacyHead.whole, `${role.id} legacy whole`).toContain(canonicalLead);
      expect(legacyHead.text, `${role.id} legacy text`).not.toContain('Hold recovery in your queue');
      expect(legacyHead.text.split(headMarker).length - 1, `${role.id} legacy once`).toBe(1);
    }
  });

  it('delivers department-load, independentPart/independentNone and urgentOnly rules to heads and idle-fault rules to the watchdog across fresh and legacy saved skill lists', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const headPhrases = [
      'whoever gives out the work answers for keeping the department loaded, not only for ordering tasks',
      'Members standing free while work in the department can run are a fault, not a normal wait',
      '`independentPart`',
      '`independentNone`',
      'Never assign ordinary or non-urgent work to members of an urgent-only team (`urgentOnly`): Hornhoof refuses the assignment and names free members in the same role.',
    ];

    const savedHeadList = ['hh-outside-is-data'];
    const headVariants = [
      ...([...shipped.roles.values()].filter(r => r.kind === 'head').map(r =>
        agent({ kind: 'head', roleKey: r.id, skills: r.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      )),
      agent({
        kind: 'head',
        roleKey: 'DEV-HEAD',
        skills: savedHeadList,
        overrides: { skills: { 'hh-lead-tasks': 'Only order tasks and wait while people stand free.' } },
        templateHashes: {},
      }),
      agent({ kind: 'head', roleKey: null, skills: [], templateHashes: {} }),
    ];

    for (const candidate of headVariants) {
      const packet = renderInstructions(shipped, candidate, PLACE);
      expect(Buffer.byteLength(packet.text), candidate.roleKey ?? 'roleless').toBeLessThan(24_000);
      for (const phrase of headPhrases) {
        expect(packet.text, `${candidate.roleKey ?? 'roleless'} text`).toContain(phrase);
        expect(packet.whole, `${candidate.roleKey ?? 'roleless'} whole`).toContain(phrase);
      }
      expect(packet.text).not.toContain('Only order tasks and wait while people stand free.');
      const breakDownFile = packet.skills.find(s => s.name === 'hh-break-down');
      expect(breakDownFile, candidate.roleKey ?? 'roleless').toBeDefined();
      expect(breakDownFile!.body).toContain('`independentPart`');
      expect(breakDownFile!.body).toContain('`independentNone`');
      expect(breakDownFile!.body).toContain('`urgentOnly`');
    }
    expect(savedHeadList).toEqual(['hh-outside-is-data']);

    const savedWatchList = ['ops-task-watch'];
    for (const watchAgent of [
      agent({ kind: 'worker', roleKey: 'OPS-WATCH', skills: shipped.roles.get('OPS-WATCH')!.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      agent({ kind: 'worker', roleKey: 'OPS-WATCH', skills: savedWatchList, templateHashes: {} }),
    ]) {
      const watchPacket = renderInstructions(shipped, watchAgent, PLACE);
      expect(watchPacket.text).toContain('no one stands free while work waits');
      const watchSkill = watchPacket.skills.find(s => s.name === 'ops-task-watch');
      expect(watchSkill?.body).toContain('People who stand free while work waits are a fault, not a normal wait');
      expect(watchPacket.whole).toContain('People who stand free while work waits are a fault, not a normal wait');
    }
    expect(savedWatchList).toEqual(['ops-task-watch']);
  });

  it('delivers T2 impact-selection, explicit scripts/test selector commands, bidirectional migration and no-auto-wiring rules in loaded development role packets', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-ENG', 'DEV-BE', 'DEV-FE'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      const files = new Map(rendered.skills.map(s => [s.name, s.body]));
      const impl = files.get('dev-implement')!;
      const eng = files.get('dev-engineering-rules')!;
      expect(Buffer.byteLength(impl), `${roleKey} dev-implement`).toBeLessThan(22_000);
      expect(Buffer.byteLength(eng), `${roleKey} dev-engineering-rules`).toBeLessThan(22_000);
      expect(impl, roleKey).toContain('scripts/test/');
      expect(impl, roleKey).toContain('NOT_RUN');
      expect(impl, roleKey).toMatch(/up and down/i);
      expect(eng, roleKey).toContain('scripts/test/impact-README.md');
      expect(eng, roleKey).toContain('scripts/test/related-probe.mjs');
      expect(eng, roleKey).toContain('scripts/test/impact-python/pytest_impact.py');
      expect(eng, roleKey).toContain('scripts/test/replay-impact.mjs');
      expect(rendered.whole, roleKey).toContain('scripts/test/impact-README.md');
    }

    const headRole = shipped.roles.get('DEV-HEAD')!;
    const headRendered = renderInstructions(
      shipped,
      agent({ kind: 'head', roleKey: 'DEV-HEAD', skills: headRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
    expect(Buffer.byteLength(headRendered.text)).toBeLessThan(24_000);
    const gatesBody = headRendered.skills.find(s => s.name === 'dev-gates')?.body ?? '';
    expect(Buffer.byteLength(gatesBody)).toBeLessThan(22_000);
    expect(gatesBody).toContain('scripts/test/');
    expect(gatesBody).toMatch(/collected graph[\s\S]*completed[^.!?]*receipts?/i);
    expect(gatesBody).toMatch(/unavailable[^.!?]*not zero misses/i);
    expect(headRendered.whole).toMatch(/collected graph[\s\S]*completed[^.!?]*receipts?/i);

    for (const roleKey of ['DEV-REV', 'DEV-TEST'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      const eng = rendered.skills.find(s => s.name === 'dev-engineering-rules')?.body ?? '';
      expect(eng, roleKey).toContain('scripts/test/impact-README.md');
      expect(eng, roleKey).toMatch(/shared packages[\s\S]*API contracts[\s\S]*templates/i);
    }
  });
});
