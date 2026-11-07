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

describe('what a node from before skill files takes', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const always = (role: Role) => renderInstructions(shipped, agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: [] }), PLACE);

  /* A role is built of as many bricks as it needs: how much such a node takes bounds none of them, and a turn too long for
     it ends saying the node needs an update. It still gets every brick but superpowers, which come with skill files. */
  it('gets every brick of a role and of the orchestrator whole, but superpowers', () => {
    for (const role of shipped.roles.values()) {
      const { parts, whole, text } = always(role);
      for (const p of parts.filter(p => p.id !== 'hh-superpowers')) expect(whole, `${role.id} ${p.id}`).toContain(p.text);
      expect(text, role.id).toContain('<!-- hh:skill hh-superpowers -->');
      expect(whole, role.id).not.toContain('superpowers');
    }
    const steady = orchestratorSteady(shipped);
    for (const p of steady.parts.filter(p => p.id !== 'hh-superpowers')) expect(steady.whole, p.id ?? 'base').toContain(p.text);
    expect(steady.text).toContain('<!-- hh:skill hh-superpowers -->');
    expect(steady.whole).not.toContain('superpowers');
  });
});

describe('renderInstructions', () => {
  it('shows the header, the role and each enabled skill between markers on the card', () => {
    const { parts, raw } = renderInstructions(T, agent(), PLACE);
    expect(parts.map(p => [p.kind, p.id])).toEqual([
      ['header', null],
      ['base', 'DEV-BE'],
      ['skill', 'hh-report-to-head'],
      ['skill', 'dev-tdd'],
    ]);
    /* Who it is is the one line that is no skill: working in Hornhoof and with tasks comes in skills, as all else does. */
    expect(parts[0]!.text).toBe('You are Bruno, the Backend engineer of the Development department at Acme, working on Mascot.');
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

  it('names the human partner the superpowers skills speak of, for a member, a head and the orchestrator, in one brick', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const partnerOf = (parts: { id: string | null; text: string }[]) => parts.find(p => p.id === 'hh-superpowers')!.text;
    const member = partnerOf(renderInstructions(shipped, agent(), PLACE).parts);
    const head = partnerOf(renderInstructions(shipped, agent({ kind: 'head', roleKey: 'DSN-HEAD' }), PLACE).parts);
    const orchestrator = partnerOf(orchestratorSteady(shipped).parts);
    expect(head).toBe(member);
    expect(orchestrator).toBe(member);
    expect(member).toContain('superpowers');
    expect(member).toContain('is whoever gave you the task, or the person who wrote to you');
    expect(member).toContain("the orchestrator's is the CEO in its window");
    expect(member).toContain('A task given to you is already approved');
    expect(member).toContain('What the orchestrator gives the departments is approved when it gives it');
    expect(member).toContain('never by waiting for an answer in your terminal');
    expect(member).toContain('the orchestrator brainstorms with the CEO when a goal is still unclear, one question at a time');
    expect(member).toContain('Anyone else uses it only when a task asks for a design');
    expect(member).toContain('A small task needs no written plan: do it, check it, submit. writing-plans and executing-plans are for new or large work only.');
    /* A head of any department reads it, so it names no role of one department. */
    expect(member).not.toMatch(/architect|developer/i);
  });

  it("tells employees and the orchestrator that Claude Code's SendMessage reaches no one in Hornhoof", () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text];
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
    expect(revFiles.get('dev-review-verdict')).toContain('task.reviewPlan');
    expect(revFiles.get('dev-review-verdict')).toContain('task.fixReview');
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
      const browserSkill = rendered.skills.find(s => s.name === 'dev-browser-check');
      expect(browserSkill, roleKey).toBeDefined();
      for (const delivered of [uiSkill!.body, rendered.whole]) {
        expect(delivered, roleKey).toMatch(/whole group|together as one group/i);
        expect(delivered, roleKey).toMatch(/non-visual[\s\S]*in parallel/i);
        expect(delivered, roleKey).toMatch(/explicit[\s\S]*browser default[\s\S]*scrollbar space/i);
      }
      for (const delivered of [browserSkill!.body, rendered.whole]) {
        expect(delivered, roleKey).toMatch(/longest[\s\S]*shortest[\s\S]*(?:shipped|supported)/i);
        expect(delivered, roleKey).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
      }
    }
  });

  it('renders hh-questions with its Materials guidance cleanly inside the 24 KB inline instruction budget', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    expect(shipped.skills.has('hh-questions')).toBe(true);
    for (const roleKey of ['DEV-ENG', 'DEV-HEAD', 'DSN-UI'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const skillIds = [...new Set([...role.skills.filter(s => s.on).map(s => s.id), 'hh-questions'])];
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: skillIds, templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      expect(rendered.text, roleKey).toContain('<!-- hh:skill hh-questions -->');
      expect(rendered.text, roleKey).toContain('- **Materials**:');
      expect(rendered.whole, roleKey).toMatch(/attach[\s\S]*materials[\s\S]*question tool/i);
    }
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
    const verdict = files.get('dev-review-verdict')!;
    expect(Buffer.byteLength(verdict)).toBeLessThan(22_000);
    expect(verdict).toContain('mechanical');
    expect(verdict).toContain('Wake.mechanical');
    expect(verdict).toMatch(/provably cannot change[^.!?]*behaviour/i);
    expect(verdict).toMatch(/when in doubt[^.!?]*regular category[\s\S]*full base level/i);
    expect(rendered.whole).toContain('Wake.mechanical');
    expect(rendered.whole).toMatch(/provably cannot change[^.!?]*behaviour/i);
  });

  it('delivers the external-outage hold, one-action unhold and ordinary-retry rules to the orchestrator and department heads, including legacy saved skill lists', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const steady = orchestratorSteady(shipped);
    expect(Buffer.byteLength(steady.text)).toBeLessThan(24_000);
    expect(steady.text).toMatch(/\n- orch-trouble: When work goes wrong\.[^\n]*external service failures/i);
    /* The rule for holds is the one every head leads by, in his instructions whole. */
    expect(steady.text).toContain('An external service failure never prolongs a general hold once the service recovers');
    const troubleFile = steady.skills.find(s => s.name === 'orch-trouble');
    expect(troubleFile).toBeDefined();
    expect(Buffer.byteLength(troubleFile!.body)).toBeLessThan(22_000);
    for (const delivered of [troubleFile!.body, steady.whole]) {
      expect(delivered).toContain('The rule for holds is in hh-lead-tasks.');
      expect(delivered).toContain("Decide any hold over an external failure, and its lifting, yourself and communicate it at once in one action to every affected holder, never through a department head's queue.");
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
      /* The rule is one, in the head's own skill, and breaking down points to it. */
      expect(breakDownFile!.body).toContain('hh-lead-tasks');
      for (const field of ['`independentPart`', '`independentNone`', '`urgentOnly`']) expect(packet.text, field).toContain(field);
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
      const policy = files.get('dev-testing-policy')!;
      expect(Buffer.byteLength(impl), `${roleKey} dev-implement`).toBeLessThan(22_000);
      expect(Buffer.byteLength(policy), `${roleKey} dev-testing-policy`).toBeLessThan(22_000);
      expect(impl, roleKey).toMatch(/T2 in dev-testing-policy/);
      expect(policy, roleKey).toContain('NOT_RUN');
      expect(policy, roleKey).toMatch(/up and down/i);
      expect(policy, roleKey).toMatch(/never assume `run_tests` selects by itself/);
      expect(rendered.whole, roleKey).toContain('NOT_RUN');
    }

    const headRole = shipped.roles.get('DEV-HEAD')!;
    const headRendered = renderInstructions(
      shipped,
      agent({ kind: 'head', roleKey: 'DEV-HEAD', skills: headRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
    expect(Buffer.byteLength(headRendered.text)).toBeLessThan(24_000);
    const headPolicy = headRendered.skills.find(s => s.name === 'dev-testing-policy')?.body ?? '';
    expect(Buffer.byteLength(headPolicy)).toBeLessThan(22_000);
    expect(headPolicy).toMatch(/collected graph[\s\S]*completed[^.!?]*receipts?/i);
    expect(headPolicy).toMatch(/unavailable[^.!?]*not zero misses/i);
    expect(headRendered.whole).toMatch(/collected graph[\s\S]*completed[^.!?]*receipts?/i);

    for (const roleKey of ['DEV-REV', 'DEV-TEST'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(Buffer.byteLength(rendered.text), roleKey).toBeLessThan(24_000);
      const policy = rendered.skills.find(s => s.name === 'dev-testing-policy')?.body ?? '';
      expect(policy, roleKey).toMatch(/shared packages[\s\S]*API contracts[\s\S]*templates/i);
    }
  });
});
