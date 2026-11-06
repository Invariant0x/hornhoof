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
});
