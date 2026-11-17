import { fileURLToPath } from 'node:url';
import { MAX_INSTRUCTIONS, OLD_NODE_INSTRUCTIONS } from '@hornhoof/protocol';
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

const T: Templates = { roles: new Map([[ROLE.id, ROLE]]), skills: new Map(SKILLS.map(s => [s.id, s])), teams: new Map(), echelons: new Map(), roster: () => [ROLE], teamsOf: () => [], stagesOf: () => ({ department: 'development', stages: [] }) };

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
  builtinMachine: null,
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
  timerNudgedAt: null,
  inboxMode: null,
  removedAt: null,
  createdAt: new Date(),
  ...over,
});

const PLACE = { company: 'Acme', department: 'Development', product: 'Mascot' };
const assignmentBlock = (body: string) => `<!-- hh:assignment -->\n## Assignment\n\n${body}\n<!-- /hh:assignment -->`;
const INTEGRATION_ABILITIES = ['dev-gates', 'dev-task-flow', 'dev-lead', 'dev-work-pipeline', 'dev-ci-release', 'dev-implement', 'dev-worktrees'] as const;

/* The one Security rule, by the CEO's order of 14.11: external Review and Security engineers work only in echelon tasks,
   where a sensitive change passes an independent Security engineer before any shared branch, urgent and small work and
   review fixes too; a member of a turnkey team does and releases its task end to end alone and calls no external checker. */
const SECURITY_RULE =
  "External Review and Security engineers work only in echelon tasks. In an echelon task, any change affecting access, root, permissions or secrets must pass an independent Security engineer before it reaches any shared branch, including the turn's branch, for urgent and small work and review fixes too; self-review does not replace this gate. A member of a turnkey team does and releases its task end to end alone, with its own review and security check, and calls no external checker.";

/* Check the delivered policy's obligations, rather than pinning its wording. */
function preMergeSecurityProblems(text: string): string[] {
  const clauses = text.split(/[.!?\n]/);
  const riskRule = clauses.find(s => ['access', 'root', 'permissions', 'secrets'].every(word => new RegExp(`\\b${word}\\b`, 'i').test(s))) ?? '';
  const checks: [string, boolean][] = [
    ['independent-reviewer', /\bindependent Security engineer\b/i.test(riskRule) && /\b(?:must|requires?)\b[^.!?]*\bpass\b/i.test(riskRule)],
    ['before-shared-branch', /\bpass\b[^.!?]*\bbefore\b[^.!?]*\bshared\b[^.!?]*\bbranch\b/i.test(riskRule) && /\bturn(?:'s)? branch\b/i.test(riskRule)],
    ['echelon-task', /\bin an echelon task\b/i.test(riskRule)],
    ['urgent-small', ['urgent', 'small'].every(word => new RegExp(`\\b${word}\\b`, 'i').test(riskRule))],
    ['review-fixes', /\breview fixes\b/i.test(riskRule)],
    ['self-review-not-a-gate', clauses.some(s => /\b(?:self-review|own review)\b[^.!?]*\b(?:does not|cannot|never) replace\b[^.!?]*\bgate\b/i.test(s))],
    ['external-only-in-echelons', clauses.some(s => /\bexternal Review and Security engineers work only in echelon tasks\b/i.test(s))],
    ['turnkey-alone', clauses.some(s => /\bmember of a turnkey team\b[^.!?]*\bend to end alone\b[^.!?]*\bno external checker\b/i.test(s))],
    ['no-merge-first-bypass', !/\b(?:urgent|small|named)\b[^.!?\n]*\b(?:merge first|skip Security)\b/i.test(text)],
    ['no-old-scope', !/\bapplies to urgent work, small tasks, direct named orders\b/i.test(text)],
  ];
  return checks.filter(([, holds]) => !holds).map(([id]) => id);
}

describe('independent Security before integration', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const delivered = (roleKey: string) => {
    const role = shipped.roles.get(roleKey)!;
    return renderInstructions(shipped, agent({ roleKey, kind: role.kind === 'head' ? 'head' : 'worker', skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
  };

  it('writes the Security rule once: external checkers only in echelon tasks, a member of a turnkey team alone, and the old scope nowhere', () => {
    for (const skill of shipped.skills.values()) expect(skill.body, skill.id).not.toMatch(/This applies to urgent work, small tasks, direct named orders/);
    for (const role of shipped.roles.values()) expect(role.body, role.id).not.toMatch(/This applies to urgent work, small tasks, direct named orders/);
    for (const id of INTEGRATION_ABILITIES) expect(shipped.skills.get(id)!.body, id).toContain(SECURITY_RULE);
  });

  it.each(['DEV-ENG', 'DEV-HEAD'])('gives %s the independent pre-merge gate of echelon tasks with no urgent or small bypass', roleKey => {
    const packet = delivered(roleKey);
    const gate = packet.skills.find(s => s.name === 'dev-gates');
    expect(gate, roleKey).toBeDefined();
    expect(preMergeSecurityProblems(gate!.body), roleKey).toEqual([]);
    expect(preMergeSecurityProblems(packet.whole), `${roleKey} whole`).toEqual([]);
    expect(packet.text).toContain('dev-gates');
    const entry = roleKey === 'DEV-ENG' ? packet.parts.find(p => p.id === 'dev-task-flow')!.text : packet.skills.find(s => s.name === 'dev-lead')!.body;
    expect(preMergeSecurityProblems(entry), `${roleKey} standalone entry`).toEqual([]);
    expect(packet.parts.find(p => p.kind === 'base')?.text).toBe(shipped.roles.get(roleKey)!.body);
  });

  it.each(INTEGRATION_ABILITIES)('delivers the complete protected Security condition when only %s is selected', id => {
    const savedSkills = [id];
    const packet = renderInstructions(shipped, agent({ roleKey: 'DEV-ENG', skills: savedSkills, templateHashes: {} }), PLACE);
    const selected = packet.parts.find(p => p.id === id);
    expect(selected, id).toBeDefined();
    expect(preMergeSecurityProblems(selected!.text), id).toEqual([]);
    expect(preMergeSecurityProblems(packet.whole), `${id} whole`).toEqual([]);
    expect(savedSkills).toEqual([id]);
    if (shipped.skills.get(id)!.kind === 'core') expect(packet.text).toContain(selected!.text);
    else expect(packet.skills.find(s => s.name === id)?.body).toContain(shipped.skills.get(id)!.body);
  });

  it.each(INTEGRATION_ABILITIES)('rejects late review, self-approval and fast-path mutations of %s without no-op mutations', id => {
    const rule = shipped.skills.get(id)!.body;
    expect(preMergeSecurityProblems(rule)).toEqual([]);
    const mutations: [string, string][] = [
      [rule.replace(/before (it reaches|entering)/i, 'after $1'), 'before-shared-branch'],
      [rule.replace(/independent Security engineer/gi, 'author'), 'independent-reviewer'],
      [rule.replace(/\burgent\b/gi, 'ordinary'), 'urgent-small'],
      [rule.replace(/\bsmall\b/gi, 'large'), 'urgent-small'],
      [rule.replace(/In an echelon task/g, 'In any task'), 'echelon-task'],
      [rule.replace(/only in echelon tasks/g, 'in every task'), 'external-only-in-echelons'],
      [rule.replace(/end to end alone/g, 'with a checker'), 'turnkey-alone'],
      [rule.replace(/review fixes/gi, 'ordinary fixes'), 'review-fixes'],
      [rule.replace(/does not replace/gi, 'replaces'), 'self-review-not-a-gate'],
      [`${rule}\nUrgent tasks may merge first and get Security afterward.`, 'no-merge-first-bypass'],
      [`${rule}\nSmall tasks may skip Security.`, 'no-merge-first-bypass'],
      [`${rule}\nThis applies to urgent work, small tasks, direct named orders and review fixes.`, 'no-old-scope'],
    ];
    for (const [changed, failure] of mutations) {
      expect(changed, `${id} ${failure} mutation must change the rule`).not.toBe(rule);
      expect(preMergeSecurityProblems(changed), `${id} ${failure}`).toContain(failure);
    }
  });
});

describe('what a node from before skill files takes', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const always = (role: Role) => renderInstructions(shipped, agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: [] }), PLACE);

  /* A role is built of as many bricks as it needs: how much such a node takes bounds none of them, and a turn too long for
     it ends saying the node needs an update. */
  it('gets every brick of a role and of the orchestrator whole', () => {
    for (const role of shipped.roles.values()) {
      const { parts, whole } = always(role);
      for (const p of parts) expect(whole, `${role.id} ${p.id}`).toContain(p.text);
    }
    const steady = orchestratorSteady(shipped);
    for (const p of steady.parts) expect(steady.whole, p.id ?? 'base').toContain(p.text);
  });
});

describe('renderInstructions', () => {
  it('keeps role identity separate from an existing personal assignment', () => {
    const assignment = '  Close assigned incident orders end to end.\nСохранить эту строку.\nLiteral \\n stays literal.  ';
    const saved = agent({ overrides: { base: assignment } });
    const packet = renderInstructions(T, saved, PLACE);
    expect(packet.parts.find(p => p.kind === 'base')?.text).toBe(ROLE.body);
    expect(packet.parts.find(p => p.kind === 'base')?.overridden).toBe(false);
    expect(packet.parts[2]).toEqual({ kind: 'assignment', id: null, title: { en: 'Assignment', ru: 'Назначение' }, text: assignmentBlock(assignment), overridden: true, templateChanged: false });
    expect(packet.parts.slice(0, 3).map(p => p.kind)).toEqual(['header', 'base', 'assignment']);
    expect(packet.text).toContain(ROLE.body);
    expect(packet.text).toContain(assignment);
    expect(packet.whole).toContain(assignment);
    expect(packet.raw).toContain(assignmentBlock(assignment));
    expect(packet.skills.map(s => s.name)).not.toContain('assignment');
    expect(saved.overrides).toEqual({ base: assignment });
  });

  it.each([{ overrides: {}, overridden: false }, { overrides: { base: '' }, overridden: true }])('always includes an empty assignment part with overridden=$overridden', ({ overrides, overridden }) => {
    const packet = renderInstructions(T, agent({ overrides }), PLACE);
    expect(packet.parts[2]).toEqual({ kind: 'assignment', id: null, title: { en: 'Assignment', ru: 'Назначение' }, text: assignmentBlock(''), overridden, templateChanged: false });
    for (const text of [packet.text, packet.raw, packet.whole]) expect(text).toContain(assignmentBlock(''));
  });

  it.each([null, 'RETIRED-ROLE'])('retains a saved assignment without a current role template: %s', roleKey => {
    const assignment = '  Keep the roleless employee assignment.\n';
    const packet = renderInstructions(T, agent({ roleKey, overrides: { base: assignment } }), PLACE);
    expect(packet.parts.some(p => p.kind === 'base')).toBe(false);
    expect(packet.parts[1]).toMatchObject({ kind: 'assignment', id: null, text: assignmentBlock(assignment), overridden: true, templateChanged: false });
    for (const text of [packet.text, packet.raw, packet.whole]) expect(text).toContain(assignmentBlock(assignment));
  });

  it('changes the instruction hash when an assignment changes while retaining the canonical role identity', () => {
    const before = renderInstructions(T, agent({ overrides: { base: 'Own the API.' } }), PLACE);
    const after = renderInstructions(T, agent({ overrides: { base: 'Own the checkout API.' } }), PLACE);
    expect(after.hash).not.toBe(before.hash);
    expect(after.parts.find(p => p.kind === 'base')).toEqual(before.parts.find(p => p.kind === 'base'));
  });

  it('describes independent abilities without a missing-skill escape', () => {
    const packet = renderInstructions(T, agent(), PLACE);
    expect(packet.text).not.toContain('A skill may name another skill');
    expect(packet.text).toMatch(/self-contained abilit/i);
  });

  it('shows the header, the role and each enabled skill between markers on the card', () => {
    const { parts, raw } = renderInstructions(T, agent(), PLACE);
    expect(parts.map(p => [p.kind, p.id])).toEqual([
      ['header', null],
      ['base', 'DEV-BE'],
      ['assignment', null],
      ['skill', 'hh-report-to-head'],
      ['skill', 'dev-tdd'],
    ]);
    /* Who it is is the one line that is no skill: working in Hornhoof and with tasks comes in skills, as all else does. */
    expect(parts[0]!.text).toBe('You are Bruno, the Backend engineer of the Development department at Acme, working on Mascot.');
    expect(parts[1]!.text).toBe('You own the server side.');
    expect(parts[2]!.text).toBe(assignmentBlock(''));
    expect(parts[4]!.text).toBe('<!-- hh:skill dev-tdd -->\n## Test first\n\nWrite the test first.\n<!-- /hh:skill -->');
    expect(raw).toBe(parts.map(p => p.text).join('\n\n'));
    expect(raw).not.toContain('Never edit a shipped migration.');
    expect(parts.every(p => !p.overridden && !p.templateChanged)).toBe(true);
  });

  it('tells the program its role and core rules whole and its other skills as a list, which go to the node as files', () => {
    const { parts, text, hash, skills } = renderInstructions(T, agent(), PLACE);
    expect(text.startsWith(`${parts.slice(0, 4).map(p => p.text).join('\n\n')}\n\n## Skills`)).toBe(true);
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

  /* No node gives an agent obra/superpowers any more, so nothing an employee or the orchestrator reads speaks of it. */
  it('names superpowers in no instructions and no skill an employee of any role or the orchestrator reads', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const read = (told: { text: string; whole: string; skills: { name: string; description: string; body: string }[] }) => [told.text, told.whole, ...told.skills.flatMap(f => [f.name, f.description, f.body])];
    for (const role of shipped.roles.values()) {
      const every = role.skills.map(s => s.id);
      const told = renderInstructions(shipped, agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: every }), PLACE);
      for (const text of read(told)) expect(text, role.id).not.toMatch(/superpowers/i);
    }
    for (const text of read(orchestratorSteady(shipped))) expect(text).not.toMatch(/superpowers/i);
    for (const skill of shipped.skills.values()) {
      for (const text of [skill.id, skill.title.en, skill.title.ru, skill.description.en, skill.description.ru, skill.body]) expect(text, skill.id).not.toMatch(/superpowers/i);
    }
  });

  it('tells employees and the orchestrator to reach people through company tools and to keep the effort and model of the job', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text];
    for (const text of told) {
      expect(text).toContain('Reach people through company tools, never by waiting for terminal input nobody watches.');
      expect(text).toContain('Keep the effort and model assigned to the current job. A later job can use a different authorized setting; do not raise it inside a running turn.');
    }
  });

  it("tells employees and the orchestrator that Claude Code's SendMessage and an answer in the window reach no agent", () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text];
    for (const text of told) {
      expect(text).toContain('When you run in Claude Code, never answer with its SendMessage tool: what it sends reaches no one in Hornhoof.');
      expect(text).toContain("Answer people in your reply and agents with Hornhoof's tools.");
      expect(text).toContain('The orchestrator and other employees write into this conversation too, but your reply here never reaches them, only people.');
    }
  });

  /* Claude Code refuses such a removal by itself after two minutes, and the step is lost (#1246). */
  /* An assistant's own agent runs shell commands too, hh-attach among them, and hh-assistant is the only skill it gets. */
  it('tells employees, the orchestrator and an assistant\'s own agent to write a path from a variable as "${VAR:?}" or literally in a command that deletes or overwrites', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text, shipped.skills.get('hh-assistant')?.body ?? ''];
    for (const text of told) {
      expect(text).toContain('In rm, mv, cp and any other command that deletes or overwrites, write a path from a variable as "${VAR:?}/..." or as a literal path, never $VAR/* unchecked: Claude Code refuses such a command, and only a person can allow it.');
    }
  });

  it('keeps every skill whole in the text for a node that writes no skill files, as before', () => {
    const { parts, whole } = renderInstructions(T, agent(), PLACE);
    expect(whole.startsWith('You are Bruno')).toBe(true);
    expect(whole).toContain('\n\nYou own the server side.\n\n');
    expect(whole.endsWith(parts.filter(p => p.kind === 'skill').map(p => p.text).join('\n\n'))).toBe(true);
    /* Such a node has no files to list. */
    expect(whole).not.toContain('## Skills');
  });

  it('keeps that text whole however long it is, and a turn too long for the node does not go out', () => {
    const long = 'Test first. '.repeat(2000);
    const { whole } = renderInstructions(T, agent({ overrides: { skills: { 'dev-tdd': long } } }), PLACE);
    expect(whole.length).toBeGreaterThan(OLD_NODE_INSTRUCTIONS);
    expect(whole).toContain(`${long}\n<!-- /hh:skill -->`);
  });

  it('marks assignment and skill overrides without replacing or marking the role identity', () => {
    const { parts } = renderInstructions(T, agent({ overrides: { base: 'You own the API.', skills: { 'dev-tdd': 'Tests come first, always.' } } }), PLACE);
    expect(parts.find(p => p.kind === 'base')).toMatchObject({ text: ROLE.body, overridden: false });
    expect(parts.find(p => p.kind === 'assignment')).toMatchObject({ text: assignmentBlock('You own the API.'), overridden: true });
    expect(parts.find(p => p.id === 'dev-tdd')).toMatchObject({ overridden: true });
    expect(parts.find(p => p.id === 'dev-tdd')!.text).toContain('Tests come first, always.');
    expect(parts.find(p => p.id === 'hh-report-to-head')!.overridden).toBe(false);
  });

  it('marks a part whose template moved on since the employee was hired', () => {
    const { parts } = renderInstructions(T, agent({ templateHashes: { 'DEV-BE': 'old000000000', 'hh-report-to-head': SKILLS[0]!.hash, 'dev-tdd': 'old111111111' } }), { ...PLACE, product: null });
    expect(parts.map(p => p.templateChanged)).toEqual([false, true, false, false, true]);
    expect(parts[0]!.text).toContain('the Backend engineer of the Development department at Acme.');
  });

  it('delivers differential second-look, author evidence and provenance rules in DEV-REV and DEV-SEC skill files', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-REV', 'DEV-SEC'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      const delivered = rendered.skills.map(s => s.body).join('\n\n');
      expect(delivered, roleKey).toContain('first look');
      expect(delivered, roleKey).toContain('reviewedCommit');
      expect(delivered, roleKey).toContain('fixCommit');
      expect(delivered, roleKey).not.toContain('at high effort');
      expect(rendered.whole, roleKey).toContain('fixCommit');
    }
    const revRole = shipped.roles.get('DEV-REV')!;
    const revRendered = renderInstructions(shipped, agent({ roleKey: 'DEV-REV', skills: revRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
    const revFiles = new Map(revRendered.skills.map(s => [s.name, s.body]));
    expect(revFiles.get('dev-review-verdict')).toMatch(/After your repair, inspect only the fixes/);
    expect(revFiles.get('dev-review-verdict')).toContain('confirm_finding');
    expect(revFiles.get('dev-review-verdict')).toMatch(/internal role or skill rules[^.!?]*never[^.!?]*(?:main|release) approval/i);
  });

  it('delivers the mandatory UI panel-wrapping and dynamic language rule to DEV-ENG and DEV-FE through self-contained skill files and whole instructions', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-ENG', 'DEV-FE'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
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

  it('renders hh-questions with its Materials guidance cleanly', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    expect(shipped.skills.has('hh-questions')).toBe(true);
    for (const roleKey of ['DEV-ENG', 'DEV-HEAD', 'DSN-UI'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const skillIds = [...new Set([...role.skills.filter(s => s.on).map(s => s.id), 'hh-questions'])];
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: skillIds, templateHashes: {} }), PLACE);
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
      expect(occurrences(fresh.raw, marker), `${role.id} raw`).toBe(1);
      expect(occurrences(fresh.text, marker), `${role.id} text`).toBe(1);
      expect(occurrences(fresh.whole, marker), `${role.id} whole`).toBe(1);
      expect(fresh.text, role.id).toContain(canonicalChecks);
      expect(fresh.whole, role.id).toContain(canonicalChecks);
      expect(fresh.skills.some(s => s.name === 'hh-run-checks'), role.id).toBe(false);
    }

    const steady = orchestratorSteady(shipped);
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
    expect(workerPacket.skills.map(s => s.name)).toEqual(['hh-one-shot-calls', 'dev-tdd']);

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
    expect(canonicalLead).toMatch(/external outages and holds:/i);

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
    expect(headPacket.text).toContain(canonicalLead);
    expect(headPacket.whole).toContain(canonicalLead);
    expect(headPacket.raw).toContain(canonicalLead);
    expect(headPacket.text).toContain(canonicalChecks);
    expect(headPacket.text).not.toContain('Keep holds in your own queue.');
    expect(headPacket.text).not.toContain('Run full suites locally.');
    expect(headPacket.parts.find(p => p.id === 'hh-lead-tasks')!.overridden).toBe(false);
    expect(headPacket.parts.find(p => p.id === 'hh-run-checks')!.overridden).toBe(false);

    const rolelessHead = renderInstructions(shipped, agent({ kind: 'head', roleKey: null, skills: [], templateHashes: {} }), PLACE);
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

  it('delivers the strict mechanical finding category and its boundary in loaded DEV-REV skill files and whole instructions', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const revRole = shipped.roles.get('DEV-REV')!;
    const rendered = renderInstructions(shipped, agent({ roleKey: 'DEV-REV', skills: revRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
    expect(rendered.text).toContain('\n- dev-review-diff: Reviewing a change.');
    expect(rendered.text).toContain('\n- dev-review-verdict: Review verdict.');
    const files = new Map(rendered.skills.map(s => [s.name, s.body]));
    const verdict = files.get('dev-review-verdict')!;
    expect(Buffer.byteLength(verdict)).toBeLessThan(22_000);
    expect(verdict).toContain('mechanical');
    expect(verdict).toMatch(/provably cannot change[^.!?]*behaviour/i);
    expect(verdict).toMatch(/when in doubt[^.!?]*regular category[\s\S]*full base level/i);
    expect(rendered.whole).toMatch(/provably cannot change[^.!?]*behaviour/i);
  });

  it('delivers the external-outage hold, one-action unhold and ordinary-retry rules to the orchestrator and department heads, including legacy saved skill lists', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const steady = orchestratorSteady(shipped);
    expect(steady.text).toMatch(/\n- orch-trouble: When work goes wrong\.[^\n]*external service failures/i);
    /* Heads keep their standing rule; a selected trouble ability must carry its own complete method too. */
    expect(steady.text).toMatch(/external service failure never prolongs a general hold once the service recovers/i);
    const troubleFile = steady.skills.find(s => s.name === 'orch-trouble');
    expect(troubleFile).toBeDefined();
    expect(Buffer.byteLength(troubleFile!.body)).toBeLessThan(22_000);
    for (const delivered of [troubleFile!.body, steady.whole]) {
      expect(delivered).toMatch(/external service failure (?:never prolongs|does not keep) a general hold[^.!?]*(?:recovers|recovery)/i);
      expect(delivered).toMatch(/communicate (?:a lifted hold|[^.!?]*lifting)[^.!?]*at once in one action[^.!?]*every affected holder/i);
      expect(delivered).toMatch(/authorized company coordinator[\s\S]*decide any general hold[\s\S]*lifting yourself/i);
      expect(delivered).toMatch(/(?:not through a head's serial queue|never through a department head's queue)/i);
      expect(delivered).toMatch(/ordinary (?:safe )?retry[^.!?]*transient external failure[^.!?]*needs no (?:extra )?permission|needs no permission[^.!?]*ordinary retry[^.!?]*transient external failure/i);
      expect(delivered).toMatch(/force pushes[\s\S]*alternate refs[\s\S]*permission changes[\s\S]*irreversible actions[\s\S]*dangerous or non-idempotent (?:actions|retries)/i);
      expect(delivered).not.toContain('The rule for holds is in hh-lead-tasks.');
    }

    const canonicalLead = shipped.skills.get('hh-lead-tasks')!.body;
    const headMarker = '<!-- hh:skill hh-lead-tasks -->';
    for (const role of [...shipped.roles.values()].filter(r => r.kind === 'head')) {
      const freshHead = renderInstructions(shipped, agent({ kind: 'head', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      expect(freshHead.text, role.id).toMatch(/external service failure never prolongs a general hold once the service recovers/i);
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
    const headRules = [
      /whoever gives out the work answers for keeping the department loaded, not only for ordering tasks/i,
      /members standing free while work in the department can run are a fault, not a normal wait/i,
      /`independentPart`/,
      /`independentNone`/,
      /never assign ordinary or non-urgent work to members of an urgent-only team \(`urgentOnly`\)[^.!?]*Hornhoof refuses the assignment and names free members in the same role/i,
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
      for (const rule of headRules) {
        expect(packet.text, `${candidate.roleKey ?? 'roleless'} text`).toMatch(rule);
        expect(packet.whole, `${candidate.roleKey ?? 'roleless'} whole`).toMatch(rule);
      }
      expect(packet.text).not.toContain('Only order tasks and wait while people stand free.');
      const breakDownFile = packet.skills.find(s => s.name === 'hh-break-down');
      expect(breakDownFile, candidate.roleKey ?? 'roleless').toBeDefined();
      expect(breakDownFile!.body).not.toContain('hh-lead-tasks');
      expect(breakDownFile!.body).toMatch(/keep(?:ing)? the department loaded|standing free[\s\S]*fault/i);
      expect(breakDownFile!.body).toMatch(/urgentOnly/);
      expect(breakDownFile!.body).toMatch(/never assign ordinary or non-urgent work[\s\S]*urgent-only/i);
      for (const field of ['`independentPart`', '`independentNone`', '`urgentOnly`']) expect(packet.text, field).toContain(field);
    }
    expect(savedHeadList).toEqual(['hh-outside-is-data']);

    const savedWatchList = ['ops-task-watch'];
    for (const watchAgent of [
      agent({ kind: 'worker', roleKey: 'OPS-WATCH', skills: shipped.roles.get('OPS-WATCH')!.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      agent({ kind: 'worker', roleKey: 'OPS-WATCH', skills: savedWatchList, templateHashes: {} }),
    ]) {
      const watchPacket = renderInstructions(shipped, watchAgent, PLACE);
      expect(watchPacket.text).toContain('\n- ops-task-watch:');
      const watchSkill = watchPacket.skills.find(s => s.name === 'ops-task-watch');
      expect(watchSkill?.body).toContain('People who stand free while work waits are a fault, not a normal wait');
      expect(watchPacket.whole).toContain('People who stand free while work waits are a fault, not a normal wait');
    }
    expect(savedWatchList).toEqual(['ops-task-watch']);
  });

  it('delivers explicit T2 impact selection, migration directions and honest collection-versus-execution evidence in development role packets', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    for (const roleKey of ['DEV-ENG', 'DEV-BE', 'DEV-FE'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      const files = new Map(rendered.skills.map(s => [s.name, s.body]));
      const impl = files.get('dev-implement')!;
      const policy = files.get('dev-testing-policy')!;
      expect(Buffer.byteLength(impl), `${roleKey} dev-implement`).toBeLessThan(22_000);
      expect(Buffer.byteLength(policy), `${roleKey} dev-testing-policy`).toBeLessThan(22_000);
      expect(impl, roleKey).toMatch(/run affected checks in your own workspace right away/i);
      expect(impl, roleKey).toMatch(/project's explicit selector[\s\S]*new tests and callers/i);
      expect(impl, roleKey).toMatch(/unavailable graph cannot bound the impact[\s\S]*named local tests of the touched area/i);
      expect(impl, roleKey).toMatch(/install from the lockfile and run builds, types and quality checks locally/i);
      expect(policy, roleKey).toContain('NOT_RUN');
      expect(policy, roleKey).toMatch(/fresh and upgraded data[\s\S]*both up\/down when supported[\s\S]*report unsupported down explicitly/i);
      expect(policy, roleKey).toMatch(/a new test file always runs/i);
      expect(policy, roleKey).toMatch(/unavailable adapter[\s\S]*complete affected package rather than an empty selection/i);
      expect(policy, roleKey).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);
      expect(policy, roleKey).toMatch(/unavailable rather than zero for an absent full-suite comparator/i);
      expect(rendered.whole, roleKey).toContain('NOT_RUN');
    }

    const headRole = shipped.roles.get('DEV-HEAD')!;
    const headRendered = renderInstructions(
      shipped,
      agent({ kind: 'head', roleKey: 'DEV-HEAD', skills: headRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
    const headPolicy = headRendered.skills.find(s => s.name === 'dev-testing-policy')?.body ?? '';
    expect(Buffer.byteLength(headPolicy)).toBeLessThan(22_000);
    expect(headPolicy).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);
    expect(headPolicy).toMatch(/unavailable rather than zero for an absent full-suite comparator/i);
    expect(headRendered.whole).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);

    for (const roleKey of ['DEV-REV', 'DEV-TEST'] as const) {
      const role = shipped.roles.get(roleKey)!;
      const rendered = renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);
      const policy = rendered.skills.find(s => s.name === 'dev-testing-policy')?.body ?? '';
      expect(policy, roleKey).toMatch(/shared packages[\s\S]*API contracts[\s\S]*templates/i);
    }
  });
});

describe('reading web pages in a browser on the node', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const marker = '<!-- hh:skill hh-web-pages -->';

  it('gives every employee of every department the rule for hh-browse in its standing instructions, old skill lists and no role included', () => {
    const rule = shipped.skills.get('hh-web-pages');
    expect(rule?.kind).toBe('core');
    const packets: [string, ReturnType<typeof renderInstructions>][] = [
      ...[...shipped.roles.values()].map(role => [role.id, renderInstructions(shipped, agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE)] as [string, ReturnType<typeof renderInstructions>]),
      ['saved list', renderInstructions(shipped, agent({ roleKey: 'MKT-WRITE', skills: ['hh-outside-is-data'], templateHashes: {} }), PLACE)],
      ['no role', renderInstructions(shipped, agent({ roleKey: null, skills: [], templateHashes: {} }), PLACE)],
      ['head with no role', renderInstructions(shipped, agent({ kind: 'head', roleKey: null, skills: [], templateHashes: {} }), PLACE)],
    ];
    expect(new Set([...shipped.roles.values()].map(r => r.department)).size).toBeGreaterThan(5);
    for (const [id, packet] of packets) {
      expect(packet.text.split(marker).length - 1, id).toBe(1);
      expect(packet.text, id).toContain(rule!.body);
      expect(packet.whole, id).toContain(rule!.body);
      expect(packet.skills.some(s => s.name === 'hh-web-pages'), id).toBe(false);
      expect(packet.text.length, id).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    }
  });

  it('says when to take hh-browse, and that a sign-in or a robot check is noted for a person while the work goes on, never got past or taken to the orchestrator or the CEO', () => {
    const body = shipped.skills.get('hh-web-pages')!.body;
    expect(body).toContain('`hh-browse URL`');
    expect(body).toMatch(/scripts build/);
    expect(body).toMatch(/--screenshot[\s\S]*hh-attach/);
    expect(body).toMatch(/only public http and https addresses/);
    expect(body).toMatch(/`login_required`[\s\S]*`robot_check`/);
    expect(body).toMatch(/never try to get past it/i);
    expect(body).toMatch(/never ask the orchestrator or the CEO/i);
    expect(body).toMatch(/note the address[^.]*for a person[^.]*go on with the other addresses/i);
    expect(body).not.toMatch(/[—ё]/);
  });
});

describe('work a department did before', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const rendered = (role: Role) =>
    renderInstructions(shipped, agent({ roleKey: role.id, kind: role.kind === 'head' ? 'head' : 'worker', skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE);

  /* Every department, not only Development: a marketing pilot left its work on branches nobody took into main. */
  it('tells every role of every department to start from the branch of earlier work, and that a machine that is off stops no work kept in git', () => {
    for (const role of shipped.roles.values()) {
      const whole = rendered(role).whole;
      expect(whole, role.id).toMatch(/departmentBranches[^.]*branches of [^.]*accepted and handed-in tasks not in main/);
      expect(whole, role.id).toMatch(/starts from that branch/);
      expect(whole, role.id).toMatch(/machine that is off stops no work kept in the repository[^.]*plan of your department is online[^.]*never tell a person the work stands because a machine is off/);
    }
  });
});

describe('one run of every test per release', () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
  const renderRole = (roleId: string) => {
    const role = shipped.roles.get(roleId)!;
    return renderInstructions(
      shipped,
      agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
  };

  it('keeps MAX_INSTRUCTIONS at 200000', () => {
    expect(MAX_INSTRUCTIONS).toBe(200_000);
  });

  it('starts employee hh-* skills with You can', () => {
    for (const skill of shipped.skills.values()) {
      if (skill.id.startsWith('hh-') && skill.id !== 'hh-assistant') {
        expect(skill.body.startsWith('You can '), skill.id).toBe(true);
      }
    }
  });

  it('tells every development role that every test runs together once per release', () => {
    for (const roleId of ['DEV-HEAD', 'DEV-ENG', 'DEV-REV', 'DEV-TEST'] as const) {
      const whole = renderRole(roleId).whole;
      expect(whole, roleId).not.toMatch(/from code and checks to merge and release|code, checks, your own review and security check, tests, merge and release/i);
      expect(whole, roleId).not.toMatch(/use\s+`?"?run_tests`?"?\s+(?:for\s+one\s+)?(?:only\s+)?when\s+your\s+(?:own\s+)?workspace\s+cannot\s+run\s+it|\bstrictly once\b/i);
      expect(whole, roleId).toMatch(/Check what you touched with local tests of the files it reaches; every test runs together once per release, on the turn's branch or a release branch before main, or on main\./);
    }
  });
});
