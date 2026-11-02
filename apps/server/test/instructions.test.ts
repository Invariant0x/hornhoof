import { OLD_NODE_INSTRUCTIONS } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import type { agents } from '../src/db/schema.js';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { textHash, type Role, type Skill, type SkillKind, type Templates } from '../src/modules/templates/load.js';

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
  roleKey: 'DEV-BE',
  skills: ['hh-report-to-head', 'dev-tdd'],
  overrides: {},
  templateHashes: { 'DEV-BE': ROLE.hash, 'hh-report-to-head': SKILLS[0]!.hash, 'dev-tdd': SKILLS[1]!.hash },
  productId: null,
  createdBy: null,
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
});
