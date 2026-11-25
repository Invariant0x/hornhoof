import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { agents } from '../src/db/schema.js';
import { orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates, textHash, type Role, type Skill, type SkillKind, type Templates } from '../src/modules/templates/load.js';

/* Every part of an agent's instructions whole, skills too, as its card's text has them: a rule an agent gets is here, whether
   the program reads it in its instructions or from a skill file. */
const wholeOf = (told: { parts: { text: string }[] }) => told.parts.map(p => p.text).join('\n\n');

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

const T: Templates = { roles: new Map([[ROLE.id, ROLE]]), skills: new Map(SKILLS.map(s => [s.id, s])), teams: new Map(), echelons: new Map(), catalogs: new Map(), roster: () => [ROLE], teamsOf: () => [], stagesOf: () => ({ department: 'development', stages: [] }) };

type AgentRow = typeof agents.$inferSelect;

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000002',
  kind: 'worker',
  name: 'Bruno',
  originalName: null,
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

/* The one Security rule, as the CEO approved it on 24.11 for the batch pipeline: Security reads the whole turn branch once, after
   Review and before Tests, and fixes what it finds there; nothing reaches main without that pass; the hotfix lane's fix has its
   own read before its patch release when it touches access, secrets or root processes (Ivan, 24.11 20:05). The older rule (a pass for every task before any shared branch, and a turnkey member alone)
   is nowhere. */
const SECURITY_RULE =
  "Security reads the whole turn branch once, after Review and before Tests, and fixes what it finds there; nothing goes to main without that pass; the hotfix lane's fix gets its own Security read before its patch release when it touches access, secrets or root processes, and any other hotfix rests on the batch stages of the release.";

/* Check the delivered policy's obligations, rather than pinning its wording. */
function preMergeSecurityProblems(text: string): string[] {
  const clauses = text.split(/[.!?\n]/);
  const rule = clauses.find(s => /\bSecurity reads\b/i.test(s)) ?? '';
  const checks: [string, boolean][] = [
    ['whole-turn-branch-once', /\bSecurity reads the whole turn branch once\b/i.test(rule)],
    ['after-review-before-tests', /\bafter Review and before Tests\b/i.test(rule)],
    ['fixes-what-it-finds', /\bfixes what it finds there\b/i.test(rule)],
    ['nothing-to-main-without-the-pass', clauses.some(s => /\bnothing goes to main without that pass\b/i.test(s)) || /\bnothing goes to main without that pass\b/i.test(text)],
    ['hotfix-own-read', /\bhotfix lane's fix gets its own Security read before its patch release\b/i.test(text)],
    ['no-merge-first-bypass', !/\b(?:urgent|small|named)\b[^.!?\n]*\b(?:merge first|skip Security)\b/i.test(text)],
    ['no-old-gate', !/\bbefore it reaches any shared branch\b/i.test(text)],
    ['no-turnkey-alone', !/\bmember of a turnkey team does and releases its task end to end alone\b/i.test(text)],
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

  /* That the old scope is nowhere is a rule of the product policy, templates-policy.test.ts. */
  it('writes the Security rule whole in every integration ability: one read of the whole turn branch, after Review and before Tests', () => {
    for (const id of INTEGRATION_ABILITIES) expect(shipped.skills.get(id)!.body, id).toContain(SECURITY_RULE);
  });

  it.each(['DEV-ENG', 'DEV-HEAD'])('gives %s the one Security read of the turn branch with no urgent or small bypass', roleKey => {
    const packet = delivered(roleKey);
    const gate = packet.skills.find(s => s.name === 'dev-gates');
    expect(gate, roleKey).toBeDefined();
    expect(preMergeSecurityProblems(gate!.body), roleKey).toEqual([]);
    expect(preMergeSecurityProblems(wholeOf(packet)), `${roleKey} whole`).toEqual([]);
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
    expect(preMergeSecurityProblems(wholeOf(packet)), `${id} whole`).toEqual([]);
    expect(savedSkills).toEqual([id]);
    if (shipped.skills.get(id)!.kind === 'core') expect(packet.text).toContain(selected!.text);
    else expect(packet.skills.find(s => s.name === id)?.body).toContain(shipped.skills.get(id)!.body);
  });

  it.each(INTEGRATION_ABILITIES)('rejects late review, self-approval and fast-path mutations of %s without no-op mutations', id => {
    const rule = shipped.skills.get(id)!.body;
    expect(preMergeSecurityProblems(rule)).toEqual([]);
    const mutations: [string, string][] = [
      [rule.replace('Security reads the whole turn branch once', 'Security reads the task branch each time'), 'whole-turn-branch-once'],
      [rule.replace('after Review and before Tests', 'before Review'), 'after-review-before-tests'],
      [rule.replace('fixes what it finds there', 'only reports what it finds'), 'fixes-what-it-finds'],
      [rule.replace('nothing goes to main without that pass', 'main may go first'), 'nothing-to-main-without-the-pass'],
      [rule.replace("gets its own Security read before its patch release", 'ships its patch release at once'), 'hotfix-own-read'],
      [`${rule}\nUrgent tasks may merge first and get Security afterward.`, 'no-merge-first-bypass'],
      [`${rule}\nSmall tasks may skip Security.`, 'no-merge-first-bypass'],
      [`${rule}\nA change reaches any shared branch only after it passes Security: it must pass before it reaches any shared branch.`, 'no-old-gate'],
      [`${rule}\nA member of a turnkey team does and releases its task end to end alone and calls no external checker.`, 'no-turnkey-alone'],
      [`${rule}\nThis applies to urgent work, small tasks, direct named orders and review fixes.`, 'no-old-scope'],
    ];
    for (const [changed, failure] of mutations) {
      expect(changed, `${id} ${failure} mutation must change the rule`).not.toBe(rule);
      expect(preMergeSecurityProblems(changed), `${id} ${failure}`).toContain(failure);
    }
  });
});

describe("the orchestrator's standing role", () => {
  const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));

  it('gives the orchestrator owner authority in any turn and treats quoted text as data', () => {
    const { text } = orchestratorSteady(shipped);
    expect(text).toMatch(/company owner's rights[^.]*whoever asked/i);
    expect(text).toMatch(/any turn/i);
    expect(text).toMatch(/`> ` prefix marks quoted lines[^.]*sender/i);
    expect(text).toMatch(/CEO's recorded yes[^.]*irreversible deletion/i);
    expect(text).toMatch(/keep[^.]*passwords[^.]*out of[^.]*messages/i);
    expect(text).not.toContain('do it only when they say so');
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
    expect(wholeOf(packet)).toContain(assignment);
    expect(packet.raw).toContain(assignmentBlock(assignment));
    expect(packet.skills.map(s => s.name)).not.toContain('assignment');
    expect(saved.overrides).toEqual({ base: assignment });
  });

  it.each([{ overrides: {}, overridden: false }, { overrides: { base: '' }, overridden: true }])('always includes an empty assignment part with overridden=$overridden', ({ overrides, overridden }) => {
    const packet = renderInstructions(T, agent({ overrides }), PLACE);
    expect(packet.parts[2]).toEqual({ kind: 'assignment', id: null, title: { en: 'Assignment', ru: 'Назначение' }, text: assignmentBlock(''), overridden, templateChanged: false });
    for (const text of [packet.text, packet.raw]) expect(text).toContain(assignmentBlock(''));
  });

  it.each([null, 'RETIRED-ROLE'])('retains a saved assignment without a current role template: %s', roleKey => {
    const assignment = '  Keep the roleless employee assignment.\n';
    const packet = renderInstructions(T, agent({ roleKey, overrides: { base: assignment } }), PLACE);
    expect(packet.parts.some(p => p.kind === 'base')).toBe(false);
    expect(packet.parts[1]).toMatchObject({ kind: 'assignment', id: null, text: assignmentBlock(assignment), overridden: true, templateChanged: false });
    for (const text of [packet.text, packet.raw]) expect(text).toContain(assignmentBlock(assignment));
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

  /* No node gives an agent obra/superpowers any more, so nothing an employee or the orchestrator reads speaks of it. Every
     skill's own text keeps to it by the product policy, templates-policy.test.ts. */
  it('names superpowers in no instructions and no skill an employee of any role or the orchestrator reads', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const read = (told: { text: string; parts: { text: string }[]; skills: { name: string; description: string; body: string }[] }) => [told.text, wholeOf(told), ...told.skills.flatMap(f => [f.name, f.description, f.body])];
    for (const role of shipped.roles.values()) {
      const every = role.skills.map(s => s.id);
      const told = renderInstructions(shipped, agent({ kind: role.kind === 'head' ? 'head' : 'worker', roleKey: role.id, skills: every }), PLACE);
      for (const text of read(told)) expect(text, role.id).not.toMatch(/superpowers/i);
    }
    for (const text of read(orchestratorSteady(shipped))) expect(text).not.toMatch(/superpowers/i);
  });

  it('tells employees and the orchestrator to reach people through company tools and to keep the effort and model of the job', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text];
    for (const text of told) {
      expect(text).toContain('Reach people through company tools, never by waiting for terminal input nobody watches.');
      expect(text).toContain('Keep the effort and model assigned to the current job. A later job can use a different authorized setting; do not raise it inside a running turn.');
    }
  });

  it('tells employees and the orchestrator how to deliver replies to people and to agents', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text];
    for (const text of told) {
      expect(text).toContain('The orchestrator and other employees write into this conversation too, but your reply here never reaches them, only people.');
      expect(text).toMatch(/Answer people in your reply[^.]*company delivery tool[^.]*agents/i);
      expect(text).toMatch(/provider's own messaging tool[^.]*cannot deliver[^.]*company employees/i);
    }
  });

  /* An assistant's own agent runs shell commands too, hh-attach among them, and hh-assistant is the only skill it gets. */
  it('requires checked shell paths before an overwrite or deletion and the CEO only for irreversible deletion', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const told = [renderInstructions(shipped, agent(), PLACE).text, renderInstructions(shipped, agent({ kind: 'head', roleKey: 'SAL-HEAD' }), PLACE).text, orchestratorSteady(shipped).text, shipped.skills.get('hh-assistant')?.body ?? ''];
    for (const text of told) {
      expect(text).toMatch(/verify[^.]*exact target[^.]*recoverability/i);
      expect(text).toMatch(/overwrite or delet(?:e|ion)[^.]*literal path[^.]*"\$\{VAR:\?\}\/\.\.\."/i);
      expect(text).toMatch(/CEO's recorded yes before irreversible deletion/i);
      expect(text).not.toMatch(/only a person can allow it/i);
    }
  });

  /* Ivan's word: instructions and skills have no size limit, so no test holds them to one (#1262). */
  it('tells developers and reviewers never to hold instructions or skills to a size in a test, and a reviewer to report such a test', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const rule = 'Never add a byte, character or line budget for instructions or skills to tests, and never shorten an instruction or skill text to fit such a budget.';
    const fileOf = (roleKey: string, name: string) => {
      const role = shipped.roles.get(roleKey)!;
      return renderInstructions(shipped, agent({ roleKey, skills: role.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }), PLACE).skills.find(s => s.name === name)?.body ?? '';
    };
    for (const roleKey of ['DEV-BE', 'DEV-FE', 'DEV-ENG', 'DEV-TEST']) expect(fileOf(roleKey, 'dev-tdd'), roleKey).toContain(rule);
    expect(fileOf('DEV-REV', 'dev-review-diff')).toContain(`${rule} Such an assertion in a test is a finding.`);
  });

  it("keeps a long override of a skill whole in the skill's file", () => {
    const long = 'Test first. '.repeat(2000);
    const { skills } = renderInstructions(T, agent({ overrides: { skills: { 'dev-tdd': long } } }), PLACE);
    expect(skills.find(f => f.name === 'dev-tdd')?.body).toBe(`# Test first\n\n${long}`);
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
      expect(wholeOf(rendered), roleKey).toContain('fixCommit');
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
      const browserSkill = rendered.skills.find(s => s.name === 'dev-browser-check');
      expect(browserSkill, roleKey).toBeDefined();
      for (const delivered of [uiSkill!.body, wholeOf(rendered)]) {
        expect(delivered, roleKey).toMatch(/whole group|together as one group/i);
        expect(delivered, roleKey).toMatch(/non-visual[\s\S]*in parallel/i);
        expect(delivered, roleKey).toMatch(/explicit[\s\S]*browser default[\s\S]*scrollbar space/i);
      }
      for (const delivered of [browserSkill!.body, wholeOf(rendered)]) {
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
      expect(wholeOf(rendered), roleKey).toMatch(/attach[\s\S]*materials[\s\S]*question tool/i);
      expect(wholeOf(rendered), roleKey).toMatch(/shared and per-option materials/i);
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
      expect(occurrences(wholeOf(fresh), marker), `${role.id} whole`).toBe(1);
      expect(fresh.text, role.id).toContain(canonicalChecks);
      expect(wholeOf(fresh), role.id).toContain(canonicalChecks);
      expect(fresh.skills.some(s => s.name === 'hh-run-checks'), role.id).toBe(false);
    }

    const steady = orchestratorSteady(shipped);
    expect(occurrences(steady.text, marker)).toBe(1);
    expect(occurrences(wholeOf(steady), marker)).toBe(1);
    expect(steady.text).toContain(canonicalChecks);
    expect(wholeOf(steady)).toContain(canonicalChecks);
    expect(steady.skills.some(s => s.name === 'hh-run-checks')).toBe(false);

    const oldWorkerSkills = ['hh-outside-is-data', 'dev-tdd'];
    const oldWorker = agent({ kind: 'worker', roleKey: 'DEV-BE', skills: oldWorkerSkills, overrides: { skills: { 'hh-run-checks': 'Run npm test locally.' } }, templateHashes: {} });
    const workerPacket = renderInstructions(shipped, oldWorker, PLACE);
    expect(oldWorker.skills).toEqual(['hh-outside-is-data', 'dev-tdd']);
    expect(occurrences(workerPacket.raw, marker)).toBe(1);
    expect(occurrences(workerPacket.text, marker)).toBe(1);
    expect(occurrences(wholeOf(workerPacket), marker)).toBe(1);
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
    expect(wholeOf(rolelessWorker)).toContain(canonicalChecks);
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
    expect(wholeOf(headPacket)).toContain(canonicalLead);
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
    expect(verdict).toContain('mechanical');
    expect(verdict).toMatch(/provably cannot change[^.!?]*behaviour/i);
    expect(verdict).toMatch(/when in doubt[^.!?]*regular category[\s\S]*full base level/i);
    expect(wholeOf(rendered)).toMatch(/provably cannot change[^.!?]*behaviour/i);
  });

  it('delivers the external-outage hold, one-action unhold and ordinary-retry rules to the orchestrator and department heads, including legacy saved skill lists', () => {
    const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    const steady = orchestratorSteady(shipped);
    expect(steady.text).toMatch(/\n- orch-trouble: When work goes wrong\.[^\n]*external service failures/i);
    /* Heads keep their standing rule; a selected trouble ability must carry its own complete method too. */
    expect(steady.text).toMatch(/external service failure never prolongs a general hold once the service recovers/i);
    const troubleFile = steady.skills.find(s => s.name === 'orch-trouble');
    expect(troubleFile).toBeDefined();
    for (const delivered of [troubleFile!.body, wholeOf(steady)]) {
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
      expect(wholeOf(legacyHead), `${role.id} legacy whole`).toContain(canonicalLead);
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
        expect(wholeOf(packet), `${candidate.roleKey ?? 'roleless'} whole`).toMatch(rule);
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
      const idleFault = /runnable work has an eligible free owner[^.]*fault[^.]*tell the department head/i;
      expect(watchSkill?.body).toMatch(idleFault);
      expect(wholeOf(watchPacket)).toMatch(idleFault);
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
      expect(impl, roleKey).toMatch(/run affected checks in your own workspace/i);
      expect(impl, roleKey).toMatch(/project's explicit selector[\s\S]*new tests and callers/i);
      expect(impl, roleKey).toMatch(/declared fallback[^.]*affected package when impact cannot be bounded/i);
      expect(impl, roleKey).toMatch(/record the fallback reason/i);
      expect(impl, roleKey).toMatch(/install from the lockfile and run builds, types and quality checks locally/i);
      expect(policy, roleKey).toContain('NOT_RUN');
      expect(policy, roleKey).toMatch(/fresh and upgraded data[\s\S]*both up\/down when supported[\s\S]*report unsupported down explicitly/i);
      expect(policy, roleKey).toMatch(/a new test file always runs/i);
      expect(policy, roleKey).toMatch(/unavailable adapter[\s\S]*complete affected package rather than an empty selection/i);
      expect(policy, roleKey).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);
      expect(policy, roleKey).toMatch(/unavailable rather than zero for an absent full-suite comparator/i);
      expect(wholeOf(rendered), roleKey).toContain('NOT_RUN');
    }

    const headRole = shipped.roles.get('DEV-HEAD')!;
    const headRendered = renderInstructions(
      shipped,
      agent({ kind: 'head', roleKey: 'DEV-HEAD', skills: headRole.skills.filter(s => s.on).map(s => s.id), templateHashes: {} }),
      PLACE,
    );
    const headPolicy = headRendered.skills.find(s => s.name === 'dev-testing-policy')?.body ?? '';
    expect(headPolicy).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);
    expect(headPolicy).toMatch(/unavailable rather than zero for an absent full-suite comparator/i);
    expect(wholeOf(headRendered)).toMatch(/collection is not execution[\s\S]*completed exact-version receipts for executed tests/i);

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
      expect(wholeOf(packet), id).toContain(rule!.body);
      expect(packet.skills.some(s => s.name === 'hh-web-pages'), id).toBe(false);
    }
  });

  it('says when to take hh-browse, that the agent signs in itself from the vault, and that a robot check is noted for a person while the work goes on, never got past or taken to the orchestrator or the CEO', () => {
    const body = shipped.skills.get('hh-web-pages')!.body;
    expect(body).toContain('`hh-browse URL`');
    expect(body).toMatch(/scripts build/);
    expect(body).toMatch(/--screenshot[\s\S]*hh-attach/);
    expect(body).toMatch(/only public http and https addresses/);
    expect(body).toMatch(/`login_required`[\s\S]*`robot_check`/);
    expect(body).toMatch(/At `login_required`, sign in yourself[^.]*vault_entry/);
    expect(body).toMatch(/At `robot_check`, stop at the challenge/);
    expect(body).toMatch(/never bypass it or ask[^.]*for a way around it/i);
    expect(body).toMatch(/record the address[^.]*account holder[^.]*\. Go on with the other addresses/i);
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
      const whole = wholeOf(rendered(role));
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

  it('starts employee hh-* skills with You can', () => {
    for (const skill of shipped.skills.values()) {
      if (skill.id.startsWith('hh-') && skill.id !== 'hh-assistant') {
        expect(skill.body.startsWith('You can '), skill.id).toBe(true);
      }
    }
  });

  it("tells every development role that a release relies on the repository's CI and uses no run_tests", () => {
    for (const roleId of ['DEV-HEAD', 'DEV-ENG', 'DEV-REV', 'DEV-TEST'] as const) {
      const whole = wholeOf(renderRole(roleId));
      expect(whole, roleId).not.toMatch(/from code and checks to merge and release|code, checks, your own review and security check, tests, merge and release/i);
      expect(whole, roleId).not.toMatch(/use\s+`?"?run_tests`?"?\s+(?:for\s+one\s+)?(?:only\s+)?when\s+your\s+(?:own\s+)?workspace\s+cannot\s+run\s+it|\bstrictly once\b/i);
      expect(whole, roleId).toMatch(/Check what you touched with local tests of the files it reaches\. A task's own run holds only its files and their tests, its browser files in Chromium only\. A release does not use run_tests: it relies on the repository's own CI for its exact commit/);
      expect(whole, roleId).not.toMatch(/once per release|whole run of the release|record run/i);
    }
  });
});
