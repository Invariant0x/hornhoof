import { describe, expect, it } from 'vitest';
import type { agents } from '../src/db/schema.js';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { textHash, type Role, type Skill, type Templates } from '../src/modules/templates/load.js';

const skill = (id: string, title: string, body: string): Skill => ({
  id,
  title: { en: title, ru: title },
  description: { en: '', ru: '' },
  kind: 'procedure',
  body,
  hash: textHash(body),
  sources: [],
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

const SKILLS = [skill('hh-report-to-head', 'Report to your head', 'Report in five lines.'), skill('dev-tdd', 'Test first', 'Write the test first.'), skill('dev-migrations', 'Migrations', 'Never edit a shipped migration.')];

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
  it('renders the header, the role and each enabled skill between markers', () => {
    const { parts, text, hash } = renderInstructions(T, agent(), PLACE);
    expect(parts.map(p => [p.kind, p.id])).toEqual([
      ['header', null],
      ['base', 'DEV-BE'],
      ['skill', 'hh-report-to-head'],
      ['skill', 'dev-tdd'],
    ]);
    expect(parts[0]!.text).toContain('You are Bruno, the Backend engineer of the Development department at Acme, working on Mascot.');
    expect(parts[0]!.text).toContain('Hornhoof');
    expect(parts[1]!.text).toBe('You own the server side.');
    expect(parts[3]!.text).toBe('<!-- hh:skill dev-tdd -->\n## Test first\n\nWrite the test first.\n<!-- /hh:skill -->');
    expect(text).toBe(parts.map(p => p.text).join('\n\n'));
    expect(text).not.toContain('Never edit a shipped migration.');
    expect(hash).toBe(textHash(text));
    expect(parts.every(p => !p.overridden && !p.templateChanged)).toBe(true);
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
