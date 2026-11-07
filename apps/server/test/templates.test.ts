import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY_TEMPLATES, MAX_INSTRUCTIONS, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ORCHESTRATOR_SKILLS, orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { NOTEBOOK_MAX, NOTES_MAX } from '../src/modules/notebook/book.js';
import { IssueInput, mechanicalVerdict } from '../src/modules/tasks/review-findings.js';
import { CORE_SKILLS, HEAD_SKILLS, loadTemplates, MEMBER_SKILLS } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];

describe('templates', () => {
  it.each(roles.filter(role => role.kind === 'head'))('gives $id the marked small-task fast path', role => {
    expect(role.body).toMatch(/small: true/);
    expect(role.body).toMatch(/fast path/);
  });

  it('defines the small-task path once, for every head and the orchestrator, and its check for code in development alone', () => {
    const body = templates.skills.get('hh-lead-tasks')!.body;
    expect(body).toMatch(/small: true/);
    expect(body).toMatch(/single place[\s\S]*clear result[\s\S]*no dependencies[\s\S]*work turn/);
    expect(body).toMatch(/change and (its|the) check/);
    expect(body).toMatch(/without splitting or separate gates/);
    expect(body).toMatch(/Reports, matrices, complexity metrics and duplicate checks[\s\S]*shared turn review/);
    expect(body).toMatch(/grows[\s\S]*tells the head[\s\S]*normal path/);
    expect(body).not.toMatch(/failing test|affected tests|branch|commit|SHA/);
    expect(templates.skills.get('dev-lead')!.body).toMatch(/failing test[\s\S]*only affected tests[\s\S]*turn's branch[\s\S]*line[\s\S]*SHA/);
    for (const id of ['orch-plan-turn', 'orch-company']) expect(templates.skills.get(id)!.body, id).not.toMatch(/small: true/);
  });

  it('keeps small work with whoever holds its context, in the skill every head and the orchestrator lead by', () => {
    const body = templates.skills.get('hh-lead-tasks')!.body;
    expect(body).toMatch(/already working in that area[\s\S]*context/);
    expect(body).toMatch(/[Dd]o not search for a free member or start a new chain/);
    expect(body).toMatch(/final gate has not started[\s\S]*change fits/);
    expect(body).toMatch(/final gate is already running[\s\S]*reset it[\s\S]*next turn/);
    expect(body).toMatch(/between[\s\S]*steps[\s\S]*after the current piece/);
    expect(body).toMatch(/several tasks ahead[\s\S]*free member/);
    expect(templates.skills.get('dev-lead')!.body).toMatch(/separate small commit[\s\S]*back to its own work/);
  });

  it('delivers the sprint admission rule once to every head and the orchestrator', () => {
    const policy = templates.skills.get('hh-lead-tasks')!.body;
    expect(policy).toMatch(/A turn is a sprint/);
    expect(policy).toMatch(/days or hours[\s\S]*as fast as it can/);
    expect(policy).toMatch(/orchestrator[\s\S]*head immediately/);
    expect(policy).toMatch(/without CEO approval or an urgency flag/);
    expect(policy).toMatch(/simple visual change[\s\S]*head[\s\S]*shared turn check[\s\S]*without a separate test/);
    expect(policy).toContain('Keep explicit deadlines for real waits.');
    for (const role of roles.filter(r => r.kind === 'head')) {
      const rendered = renderInstructions(templates, { id: 'a', companyId: 'c', kind: 'head', name: 'Hana', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });
      expect(rendered.text.match(/A turn is a sprint/g), role.id).toHaveLength(1);
    }
    expect(orchestratorSteady(templates).text.match(/A turn is a sprint/g)).toHaveLength(1);
    for (const id of ['dev-lead', 'orch-plan-turn']) {
      expect(templates.skills.get(id)!.body, id).toContain('hh-lead-tasks');
      expect(templates.skills.get(id)!.body, id).not.toContain('A turn is a sprint');
    }
    expect(templates.skills.get('dev-lead')!.body).toMatch(/test choice from hh-lead-tasks[\s\S]*Otherwise[\s\S]*failing test/);
  });

  it('keeps named sub-unit orders outside planned turns under the department and release checks', () => {
    const body = templates.skills.get('orch-company')!.body;
    expect(body).toMatch(/named orders end to end outside planned turns/);
    expect(body).toMatch(/department's oversight[\s\S]*checks[\s\S]*security review[\s\S]*exact-commit release approval/);
    expect(body).toContain('A sub-unit that takes only urgent work (`urgentOnly`) gets only what the CEO called urgent.');
  });

  it('lets the executor follow the head-assigned check before the default separate-test cycle', () => {
    for (const id of ['dev-task-flow', 'dev-tdd', 'dev-testing-policy']) {
      const body = templates.skills.get(id)!.body;
      expect(body, id).toContain('Use the check assigned by the head');
      expect(body, id).toMatch(/when (?:that|it) requires a separate test/i);
      expect(body, id).not.toContain('simple visual change');
    }
  });

  it('keeps each connected block with one owner in the head skill, with one generalist developer for code, and in the developer role', () => {
    const lead = templates.skills.get('hh-lead-tasks')!.body;
    expect(lead).toMatch(/one member owns each connected block end to end/i);
    expect(lead).toMatch(/no chains or `after` between members when one can do it/i);
    const code = templates.skills.get('dev-lead')!.body;
    expect(code).toMatch(/connected block[\s\S]*one generalist developer end to end/i);
    expect(code).toMatch(/no chains or `after` between developers when one can do it/i);
    const developer = templates.roles.get('DEV-ENG')!.body;
    expect(developer).toMatch(/one generalist developer[\s\S]*connected block[\s\S]*end to end/i);
    expect(developer).toMatch(/no chains or `after` between developers when one can do it/i);
    expect(developer).toMatch(/only affected tests of your own code[\s\S]*hand it to a tester/i);
  });

  it.each([
    'hh-break-down', 'hh-brief-members', 'hh-report-to-head', 'hh-handle-reports', 'hh-task-flow',
    'dev-implement', 'dev-testing-policy', 'dev-work-pipeline', 'dev-review-verdict',
  ])('keeps %s from restoring per-task overhead for marked small work', id => {
    const body = templates.skills.get(id)!.body;
    expect(body).toMatch(/small: true/);
    expect(body).toMatch(/shared turn/);
  });

  it('teaches every department head not to repeat a task report in a separate message', () => {
    for (const role of roles.filter(r => r.kind === 'head')) {
      const instructions = renderInstructions(templates, { id: 'a', companyId: 'c', kind: 'head', name: 'Hana', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });
      expect(instructions.text, role.id).toContain('Do not send the orchestrator a separate message repeating a task report');
    }
  });
  it('teaches heads and members to end a turn with wait_for for external events, and the orchestrator to bind readiness messages to a task', () => {
    for (const id of ['hh-head', 'hh-task-flow']) {
      const body = templates.skills.get(id)!.body;
      expect(body, id).toContain('wait_for');
      expect(body, id).toMatch(/external event/);
      expect(body, id).toMatch(/two hours/);
      expect(body, id).toMatch(/end the turn/);
    }
    expect(orchestratorSteady(templates).text).toMatch(/message_employee[\s\S]*optional task[\s\S]*external wait/);
  });

  it('loads every role and skill', () => {
    expect(roles.length).toBeGreaterThanOrEqual(30);
    expect(skills.length).toBeGreaterThanOrEqual(40);
    for (const s of skills) expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const r of roles) expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gives every role the effort assigned to its work', () => {
    const xhigh = ['DEV-ENG', 'DEV-GEN', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-SEC', 'DEV-ARCH', 'DEV-RED', 'DEV-PERF'];
    const high = ['DEV-HEAD', 'DEV-TEST', 'DEV-QA', 'DEV-OPS', 'OPS-FIX', 'OPS-BUGS', 'OPS-INTEG', 'BIZ-ANALYST', 'FIN-AUDIT', 'FIN-FPA', 'DSN-SYS', 'DSN-UI', 'SUP-T2', 'HOM-NET', 'SAL-AE', 'MKT-WRITE'];
    for (const role of roles) expect(role.effort, role.id).toBe(xhigh.includes(role.id) ? 'xhigh' : high.includes(role.id) ? 'high' : 'medium');
  });

  it('tells every member and head that a turn keeps its level, which comes from why the turn starts', () => {
    expect(MEMBER_SKILLS).toContain('hh-task-flow');
    expect(HEAD_SKILLS).toContain('hh-brief-members');
    for (const id of ['hh-task-flow', 'hh-brief-members']) {
      const body = templates.skills.get(id)!.body;
      expect(body, id).toMatch(/second look[^.]*medium/);
      expect(body, id).toMatch(/level[^.]*card/);
      expect(body, id).toMatch(/inside (this|a running) (one|turn)/);
    }
    expect(templates.skills.get('dev-review-verdict')!.body).toMatch(/second round[\s\S]*medium/i);
    for (const id of ['DEV-REV', 'DEV-SEC', 'DEV-RED', 'DEV-QA']) expect(templates.roles.get(id)!.body, id).toMatch(/second look[^.]*medium/);
  });

  it('rejects an unknown role effort and allows a role to omit it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-effort-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DIR, dir, { recursive: true });
    const file = join(dir, 'roles/development/DEV-BE.md');
    const original = readFileSync(file, 'utf8').replace(/^effort:.*\n/m, '');
    writeFileSync(file, original.replace('tier:', 'effort: extreme\ntier:'));
    expect(() => loadTemplates(dir)).toThrow(/DEV-BE\.md: effort/);
    writeFileSync(file, original);
    expect(loadTemplates(dir).roles.get('DEV-BE')!.effort).toBeUndefined();
  });

  it('keeps roles short, and every skill within what each program reads of a skill file', () => {
    for (const r of roles) expect(r.body.length, r.id).toBeLessThanOrEqual(600);
    /* Antigravity reads the first 24,000 bytes of a skill's file; its name, description and heading come on top. */
    for (const s of skills) expect(Buffer.byteLength(s.body), s.id).toBeLessThanOrEqual(22_000);
    for (const s of skills) expect(s.body.length, s.id).toBeGreaterThan(80);
  });

  it("tells every role's program its instructions with room for a full notebook, its skills going as files", () => {
    const place = { company: 'Acme', department: 'Development', product: 'Mascot' };
    for (const r of roles) {
      const agent = { id: 'a', companyId: 'c', kind: r.kind === 'head' ? 'head' : 'worker', name: 'Bruno', roleKey: r.id, skills: r.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
      const { text, skills: files } = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], place);
      expect(text.length + NOTEBOOK_MAX + NOTES_MAX * 8 + 300, r.id).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
      for (const f of files) expect(text, `${r.id} ${f.name}`).toContain(`\n- ${f.name}: `);
    }
  });

  it("gives the orchestrator his own skills, which fit his instructions with a full notebook", () => {
    expect(ORCHESTRATOR_SKILLS).toEqual([
      'hh-hornhoof', 'hh-superpowers', 'orch-outside-is-data', 'orch-company', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks',
      'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead',
    ]);
    const steady = orchestratorSteady(templates);
    /* His core rules stay whole in his instructions; the others are files his program reads when a step needs one. */
    for (const id of ['hh-hornhoof', 'hh-superpowers', 'orch-outside-is-data', 'orch-company', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks']) {
      expect(steady.text, id).toContain(`<!-- hh:skill ${id} -->`);
    }
    expect(Buffer.byteLength(steady.text)).toBeLessThan(24_000);
    expect(steady.skills.map(f => f.name)).toEqual(['orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead']);
    for (const f of steady.skills) expect(steady.text).toContain(`\n- ${f.name}: `);
    expect(steady.parts.filter(p => p.kind === 'skill').map(p => p.id)).toEqual([...ORCHESTRATOR_SKILLS]);
    /* The notebook's heading and a "[#30] " before each note come on top of its text. */
    expect(steady.text.length + NOTEBOOK_MAX + NOTES_MAX * 8 + 300).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    for (const r of roles) expect(r.skills.map(s => s.id).some(id => id.startsWith('orch-')), r.id).toBe(false);
  });

  it('names only skills that exist', () => {
    for (const r of roles) for (const s of r.skills) expect(templates.skills.has(s.id), `${r.id} -> ${s.id}`).toBe(true);
  });

  it('gives every department exactly one head, listed first', () => {
    for (const key of TEMPLATE_KEYS) {
      const roster = templates.roster(key);
      expect(roster.length, key).toBeGreaterThanOrEqual(3);
      expect(roster.filter(r => r.kind === 'head'), key).toHaveLength(1);
      expect(roster[0]!.kind, key).toBe('head');
      for (const r of roster) expect(r.department).toBe(key);
    }
  });

  it('staffs every company template with roles that exist, one head per department', () => {
    for (const template of COMPANY_TEMPLATES) {
      for (const dept of template.departments) {
        const heads = dept.staff.filter(line => templates.roles.get(line.role)?.kind === 'head');
        expect(heads.length, `${template.key}: ${dept.template}`).toBe(1);
        for (const line of dept.staff) {
          const role = templates.roles.get(line.role);
          expect(role, `${template.key}: ${line.role}`).toBeDefined();
          expect(role!.department, `${template.key}: ${line.role} in ${dept.template}`).toBe(dept.template);
        }
      }
    }
  });

  it('names each role after its department code', () => {
    const codes: Record<string, string> = { operations: 'OPS', development: 'DEV', design: 'DSN', marketing: 'MKT', sales: 'SAL', business_development: 'BIZ', support: 'SUP', finance: 'FIN', home_devices: 'HOM', household: 'HHD' };
    for (const r of roles) expect(r.id.startsWith(`${codes[r.department]}-`), r.id).toBe(true);
  });

  it('locks the core skills on for everyone, the task flow for members and the lead set for heads', () => {
    expect(HEAD_SKILLS).toContain('hh-lead-tasks');
    expect(MEMBER_SKILLS).toEqual(['hh-report-to-head', 'hh-task-flow']);
    for (const r of roles) {
      for (const id of CORE_SKILLS) expect(r.skills.find(s => s.id === id), `${r.id} ${id}`).toEqual({ id, on: true, locked: true });
      for (const [set, kind] of [[HEAD_SKILLS, 'head'], [MEMBER_SKILLS, 'member']] as const) {
        for (const id of set) {
          const s = r.skills.find(x => x.id === id);
          if (r.kind === kind) expect(s, `${r.id} ${id}`).toEqual({ id, on: true, locked: true });
          else expect(s, `${r.id} ${id}`).toBeUndefined();
        }
      }
      expect(new Set(r.skills.map(s => s.id)).size, r.id).toBe(r.skills.length);
    }
  });

  it('orders the gates a change passes in development, design and finance', () => {
    const gates = (key: 'development' | 'design' | 'finance') =>
      templates
        .roster(key)
        .filter(r => r.gate !== null)
        .sort((a, b) => a.gate! - b.gate!)
        .map(r => r.id);
    expect(gates('development')).toEqual(['DEV-REV', 'DEV-SEC', 'DEV-RED']);
    expect(gates('design')).toEqual(['DSN-QA']);
    expect(gates('finance')).toEqual(['FIN-AUDIT']);
    expect(templates.roles.get('DEV-REV')!.gate).toBe(1);
    expect(templates.roles.get('DEV-SEC')!.gate).toBe(2);
    expect(templates.roles.get('DEV-TEST')!.gate).toBeNull();
    for (const r of roles) if (r.kind === 'head') expect(r.gate, r.id).toBeNull();
  });

  it('reads role positions on the department schema, with ordinary work as the default', () => {
    expect(templates.roles.get('DEV-ARCH')!.schema).toBe('before_work');
    expect(templates.roles.get('DEV-TEST')!.schema).toBe('final_check');
    expect(templates.roles.get('DEV-PERF')!.schema).toBe('observer');
    expect(templates.roles.get('DEV-ENG')!.schema).toBeNull();
  });

  it('teaches the task tools by their names', () => {
    /* What every member carries of working through tasks, and what every head carries of leading. */
    const flow = ['hh-tasks', 'hh-task-flow'].map(id => templates.skills.get(id)!.body).join('\n');
    for (const tool of ['task', 'tasks', 'submit', 'verdict', 'blocked', 'ask_person']) expect(flow, tool).toContain(`"${tool}"`);
    const lead = templates.skills.get('hh-lead-tasks')!.body;
    for (const tool of ['create_task', 'update_task', 'cancel_task', 'ask_person', 'message_employee', 'comment']) expect(lead, tool).toContain(`"${tool}"`);
    const head = templates.skills.get('hh-head')!.body;
    for (const tool of ['report', 'tell_orchestrator', 'wait_for', 'propose_improvement']) expect(head, tool).toContain(`"${tool}"`);
  });

  it('has English and Russian titles and descriptions', () => {
    for (const x of [...roles, ...skills]) {
      for (const lang of ['en', 'ru'] as const) {
        expect(x.title[lang].length, `${x.id} title ${lang}`).toBeGreaterThan(1);
        expect(x.description[lang].length, `${x.id} description ${lang}`).toBeGreaterThan(5);
      }
      expect(x.title.ru, x.id).toMatch(/[а-я]/i);
    }
  });

  it('names where every template comes from and under which licence', () => {
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.md') && f !== 'SOURCES.md');
    expect(files.length).toBe(roles.length + skills.length);
    for (const file of files) expect(sources, file).toContain(`| \`${file}\` |`);
    /* Every repository a skill learned from has its licence in the table of sources. */
    const repos = new Set([...sources.matchAll(/^\| ([\w.-]+\/[\w.-]+(?:, [\w.-]+\/[\w.-]+)*) \|/gm)].flatMap(m => m[1]!.split(', ')));
    for (const s of skills) for (const source of s.sources) expect(repos, `${s.id}: ${source}`).toContain(source.split(' ')[0]);
  });

  it('follows the copy rules: no em dashes and no \u0451', () => {
    for (const x of [...roles, ...skills]) {
      const text = [x.body, x.title.en, x.title.ru, x.description.en, x.description.ru].join('\n');
      expect(text, x.id).not.toMatch(/[\u2014\u0451\u0401]/);
    }
  });

  it('has a task watchdog and a failure collector in operations, each waking on its own timer with the tools to watch', () => {
    const ops = templates.roster('operations');
    expect(ops.filter(r => r.inDefault).map(r => r.id)).toEqual(['OPS-HEAD', 'OPS-INTEG', 'OPS-ACCT', 'OPS-FIX', 'OPS-WATCH', 'OPS-BUGS', 'OPS-PROGRAM']);
    const watch = templates.roles.get('OPS-WATCH')!;
    const bugs = templates.roles.get('OPS-BUGS')!;
    expect([watch.timer?.minutes, bugs.timer?.minutes]).toEqual([10, 180]);
    /* Neither goes on a round while nothing is open or failed. */
    expect([watch.timer?.forWork, bugs.timer?.forWork]).toEqual([true, true]);
    expect(watch.skills.find(s => s.id === 'ops-task-watch')?.on).toBe(true);
    expect(bugs.skills.find(s => s.id === 'ops-failure-review')?.on).toBe(true);
    expect(templates.skills.get('ops-task-watch')!.grants).toEqual(['agents', 'message_employee', 'restart_program']);
    expect(templates.skills.get('ops-failure-review')!.grants).toEqual(['failures', 'agents', 'message_employee', 'improvements']);
    for (const r of roles) if (r.timer) expect(r.timer.order.length, r.id).toBeLessThanOrEqual(2000);
    expect(roles.filter(r => r.timer).map(r => r.id).sort()).toEqual(['OPS-BUGS', 'OPS-WATCH']);
  });

  it('tells the watchdog that a machine getting ready for an update waits and has not hung, while a silent program there is still silent', () => {
    const body = templates.skills.get('ops-task-watch')?.body ?? '';
    const rule = body.split('\n').find(line => line.includes('machineDrain')) ?? '';
    expect(rule).toMatch(/waiting or restarting/);
    expect(rule).toMatch(/do not nudge/);
    expect(rule).toMatch(/not offline/);
    expect(rule).toMatch(/silent program there is still silent/);
  });

  it('has a program operator in operations that Hornhoof calls: one for the company, with no timer, on its own procedure', () => {
    const operator = templates.roles.get('OPS-PROGRAM')!;
    expect(operator).toMatchObject({ department: 'operations', kind: 'member', tier: 'standard', perProduct: false, inDefault: true, timer: null });
    expect(operator.skills.find(s => s.id === 'ops-program-operator')).toMatchObject({ on: true });
    /* Its tools go by its role, so turning a skill off cannot take them away and turning it on cannot hand them out. */
    expect(templates.skills.get('ops-program-operator')!.grants).toEqual([]);
  });

  describe('the program operator\'s procedure', () => {
    const body = templates.skills.get('ops-program-operator')?.body ?? '';
    const step = (start: string) => body.split('\n').find(line => line.includes(start)) ?? '';

    it('starts from a picture of the screen and reads all of it as data', () => {
      expect(body.split('\n')[0]).toMatch(/^1\. .*program_screen/);
      expect(body.split('\n')[0]).toMatch(/data/);
    });

    it('passes only harmless screens itself, looking at the screen after every key', () => {
      const harmless = step('Pass a screen yourself only');
      for (const kind of ['color scheme', 'press Enter', 'news about a version', 'first-run']) expect(harmless, kind).toContain(kind);
      expect(harmless).toContain('program_keys');
      expect(harmless).toMatch(/program_screen again after every key/);
    });

    describe('on a question about permission', () => {
      const section = body.slice(body.indexOf('### Permission questions'));
      const point = (start: string) => section.split('\n').find(line => line.startsWith(`- ${start}`)) ?? '';

      it('has a section of its own after the steps', () => {
        expect(body).toContain('### Permission questions');
        expect(body.indexOf('### Permission questions')).toBeGreaterThan(body.indexOf('\n6. '));
      });

      it('allows what is harmless, its own temporary folder too', () => {
        const allow = point('Allow');
        for (const kind of ['reading', 'working folder', 'temporary folder', 'deleting its own temporary folder']) expect(allow, kind).toContain(kind);
      });

      it('denies what reaches outside the working folder, and tells the head of that agent\'s department with the picture', () => {
        const deny = point('Deny');
        for (const kind of ['outside the working folder', 'system paths', 'secrets', 'unfamiliar addresses', 'not sure']) expect(deny, kind).toContain(kind);
        for (const told of ['outcome denied', "head of that agent's department", 'picture of the screen']) expect(deny, told).toContain(told);
      });

      it('never answers consents, sign-in, passwords, payment or plans, and only signals the orchestrator', () => {
        const never = point('Consents');
        for (const kind of ['sign-in', 'passwords', 'payment', 'plans', 'never']) expect(never, kind).toContain(kind);
        expect(never).toContain('orchestrator');
        expect(never).not.toContain('program_keys');
      });

      it('takes a fresh picture before every key and leaves its decision in the agent\'s journal', () => {
        const key = point('Take a fresh');
        expect(key).toContain('program_screen');
        expect(key).toContain('before every key');
        for (const part of ['what was asked', 'what you chose', 'why', "agent's journal"]) expect(key, part).toContain(part);
      });

      it('leaves a question about the work itself to a person', () => {
        const work = point('A question about the work');
        expect(work).toContain('ask_person');
        expect(work).toMatch(/Leave it alone/);
      });
    });

    it('presses nothing on terms, consents, sign-in, passwords, codes, payment or a plan, and only signals', () => {
      const never = step('Press nothing on');
      for (const kind of ['terms', 'any consent', 'sharing data', 'sign-in', 'passwords', 'codes', 'payment', 'plan']) expect(never, kind).toContain(kind);
      expect(never).toContain('tell_orchestrator');
      expect(never).toContain('needs_owner');
      expect(never).not.toContain('program_keys');
    });

    it('signals at once, saying which screen and why it stands, when it is unclear or nothing moves', () => {
      const stuck = step('You do not understand');
      expect(stuck).toContain('tell_orchestrator');
      expect(stuck).toContain('failed');
      expect(stuck).toMatch(/which screen it is and why it stands/);
    });

    it('is bound to 20 keys a case, and knows the tool takes no Escape and no text', () => {
      expect(body).toMatch(/at most 20 keys/);
      expect(body).toMatch(/takes no Escape and no text/);
    });
  });

  it('teaches the failure collector to file an improvement as a short case, part by part as the tool takes it', () => {
    const review = templates.skills.get('ops-failure-review')!.body;
    for (const part of ['title', 'problem', 'facts', 'source', 'guesses', 'why', 'change', 'gain']) expect(review, part).toContain(`${part}:`);
  });

  it('has the full development roster', () => {
    const dev = templates.roster('development');
    const ids = dev.filter(r => r.inDefault).map(r => r.id);
    expect(ids).toEqual(['DEV-HEAD', 'DEV-ENG', 'DEV-REV', 'DEV-SEC']);
    expect(dev.filter(r => !r.inDefault).map(r => r.id)).toEqual(['DEV-ARCH', 'DEV-GEN', 'DEV-BE', 'DEV-FE', 'DEV-TEST', 'DEV-OPS', 'DEV-RED', 'DEV-QA', 'DEV-DOCS', 'DEV-PERF']);
    expect(templates.roles.get('DEV-FE')!.title).toEqual({ en: 'Frontend', ru: 'Фронтенд' });
    expect(templates.roles.get('DEV-BE')!.title).toEqual({ en: 'Backend engineer', ru: 'Бэкенд-разработчик' });
    expect(templates.roles.get('DSN-UI')!.perProduct).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
    for (const id of ['DEV-HEAD', 'DEV-ARCH', 'DEV-SEC']) expect(templates.roles.get(id)!.tier, id).toBe('deep');
  });

  it('keeps ub-mode word for word, as the upstream file has it, with nothing of ours in it', () => {
    const rules = templates.skills.get('dev-engineering-rules')!;
    const upstream = readFileSync(fileURLToPath(new URL('./fixtures/ub-mode-SKILL.md', import.meta.url)), 'utf8');
    expect(rules.body).toBe(upstream.replace(/^---[\s\S]*?\n---\n/, '').replace(/^\s*# ub-mode\s*\n/, '').trim());
    expect(rules.sources).toEqual(['unclebob/ub-mode SKILL.md']);
    expect(rules.description.en).toMatch(/your company's rules, those rules win/);
  });

  it('puts the company ways with the engineering rules under the testing policy', () => {
    const policy = templates.skills.get('dev-testing-policy')!.body;
    expect(policy).toContain('Push your branch, not the main line');
    expect(policy).toMatch(/crapper and dryer[\s\S]*`run_tests`/);
    /* A submitted branch is committed, and --changed sees only what is not: the gates check what the branch changed. */
    const changed = 'git diff --name-only --diff-filter=d';
    for (const id of ['dev-testing-policy', 'dev-review-diff']) expect(templates.skills.get(id)!.body, id).toContain(changed);
    expect(templates.skills.get('dev-review-diff')!.body).toMatch(/crapper[\s\S]*dryer/);
    /* Shared final metrics keep their gates, but authors do not run them before submitting. */
    expect(policy).toMatch(/0\.8 or more is blocking, like a failing test/);
    expect(policy).toMatch(/CRAP 10 or more that is new/);
    expect(templates.skills.get('dev-review-diff')!.body).not.toMatch(/developer runs them before submitting/);
    expect(templates.skills.get('dev-review-diff')!.body).toMatch(/test engineer or QA[\s\S]*shared final check/);
    expect(templates.skills.get('dev-review-verdict')!.body).toMatch(/T11 says blocks counts as a failing test/);
    expect(templates.skills.get('dev-test-gaps')!.body).toContain('break the code on purpose');
    for (const s of skills.filter(x => x.id.startsWith('dev-'))) expect(s.body, s.id).not.toMatch(/(crapper|dryer|mutator) --changed/);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-TEST', 'DEV-SEC', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-language-rules')?.on, id).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV', 'DEV-TEST', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
  });

  it('gives a newly hired developer T1-T11 and the coding cycle with four task kinds', () => {
    const role = templates.roles.get('DEV-ENG')!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Bruno', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    const card = [rendered.text, ...rendered.skills.map(s => s.body)].join('\n');
    for (let n = 1; n <= 11; n++) expect(card, `T${n}`).toContain(`T${n}.`);
    for (const words of ['Bug', 'Known behaviour', 'Unknown path', 'Legacy code', 'acceptance', 'risk class', 'requirement -> test', 'one task in progress and one awaiting review', 'A red turn branch comes before any new task', 'no 80% coverage threshold']) {
      expect(card, words).toContain(words);
    }
  });

  it('keeps test selection, release mutation testing and evidence rules consistent', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    const policy = body('dev-testing-policy');
    for (const words of ['pure functions', 'direct fast tests', 'integration tests', 'real database', 'vitest related', 'jest --findRelatedTests', 'pytest --testmon', 'cargo test -p', 'new test file always runs', 'selection miss', 'once per turn on the final candidate', 'fast tests', 'CRAP and change size', 'money, access and security', '--root .', 'killed, survived, uncovered, compile_error and timeout', 'zero tests fails the run', 'Do not mass-rewrite old slow tests', 'low coverage alone is not a finding', 'median of its package', 'financial recomputation', 'false accepts and false rejects', 'versioned set of examples', 'F.I.R.S.T.', 'shuffled order', 'same commit', 'any result a success', 'already completed run', 'second coverage run']) {
      expect(policy, words).toContain(words);
    }
    const table = (text: string) => text.split('\n').filter(line => line.startsWith('|')).join('\n');
    /* The one table of checks: nothing else repeats it. */
    for (const x of [...roles, ...skills]) if (x.id !== 'dev-testing-policy') expect(x.body, x.id).not.toMatch(/^\| (?:In work|Final turn candidate)/m);
    for (const words of ['In work', 'After a batch merges', 'Final turn candidate', 'pinned commit', 'typecheck of tests', 'real database']) expect(table(policy), words).toContain(words);
    expect(policy).toMatch(/never on a task, a fix round or a batch/);
    expect(body('dev-review-verdict')).toMatch(/requirement -> test/);
    expect(body('dev-review-verdict')).toMatch(/low coverage alone is not a finding/);
  });

  it('removes per-branch mutation runs, fixed test times and model-based financial recomputation', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(body('dev-test-gaps')).not.toMatch(/Run `mutator` from the repository root on the files the branch changed/);
    expect(body('dev-review-diff')).not.toContain("Mutation testing is the developer's");
    for (const id of ['dev-testing-policy', 'dev-gates', 'dev-tdd', 'dev-test-gaps']) expect(body(id), id).not.toMatch(/\b\d+\s+minutes?\b/);
    const modelChecks = body('dev-testing-policy').split('Model checks')[1]?.split('\n- T9.')[0];
    expect(modelChecks).toBeDefined();
    expect(modelChecks).not.toMatch(/financial recomputation/);
  });

  it('gives general, backend and frontend developers TDD and worktree skills', () => {
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE']) {
      const role = templates.roles.get(id)!;
      for (const skill of ['dev-tdd', 'dev-worktrees']) expect(role.skills.find(s => s.id === skill)?.on, `${id} ${skill}`).toBe(true);
    }
  });

  it('pins legacy characterization, requirement evidence and tester-owned final mutation checks', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(body('dev-tdd')).toContain('A characterization test of legacy code passes immediately, and that is correct');
    for (const id of ['dev-implement', 'dev-tdd']) expect(body(id), id).toContain('four task kinds');
    for (const id of ['dev-implement', 'dev-review-verdict']) expect(body(id), id).toMatch(/verification before (saying )?done/);
    expect(templates.roles.get('DEV-HEAD')!.body).toMatch(/four task kinds/);
    expect(templates.roles.get('DEV-REV')!.body).toMatch(/test engineer or QA/);
    expect(templates.roles.get('DEV-REV')!.body).not.toMatch(/runs mutator/);
    expect(body('dev-testing-policy')).toMatch(/T4/);
    expect(body('dev-testing-policy')).toMatch(/repository root/);
    expect(body('dev-testing-policy')).toMatch(/selection and its reason/);
  });

  it('records the coding cycle and testing policy in project rules and sources', () => {
    const agents = readFileSync(join(DIR, '../AGENTS.md'), 'utf8');
    expect(agents).toMatch(/Write the failing test first/);
    expect(agents).toMatch(/four task kinds/);
    expect(agents).toContain('templates/skills/dev-tdd.md');
    expect(agents).toContain('templates/skills/dev-testing-policy.md');
    expect(agents).toContain('node scripts/check-release.mjs');
    const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
    expect(sources).toContain('T1-T11');
    expect(sources).toContain('four task kinds');
  });

  it("runs the reviewer's program's own review on a first look only, without forcing high effort on repeats", () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    for (const words of ['first look', 'code-review skill', 'codex review --base <main line>', 'review-agent', 'Kimi Code has none']) expect(body('dev-review-diff'), words).toContain(words);
    expect(body('dev-review-diff')).not.toContain('code-review skill at high effort');
    for (const words of ['first look', 'security-review skill', 'codex review --base <main line>', 'review-agent']) expect(body('dev-security-review'), words).toContain(words);
    expect(body('dev-gates')).toMatch(/program's own review/);
    expect(body('dev-review-verdict')).toMatch(/program's own review[\s\S]*against the code/);
  });

  it('writes development for any language and any kind of product', () => {
    const dev = [...roles.filter(r => r.department === 'development'), ...skills.filter(s => s.id.startsWith('dev-'))];
    for (const x of dev) expect(`${x.title.en} ${x.description.en} ${x.body}`, x.id).not.toMatch(/\b(Russian|English)\b/);
    const check = templates.skills.get('dev-browser-check')!.body;
    for (const surface of ['command-line tool', 'public API', 'library', 'Playwright']) expect(check).toContain(surface);
  });

  it('keeps the red team on broken logic and flows, and security on protecting what the company has', () => {
    const textOf = (roleId: string) => {
      const role = templates.roles.get(roleId)!;
      const own = role.skills.filter(k => k.id.startsWith('dev-')).map(k => templates.skills.get(k.id)!);
      return [role, ...own].map(x => `${x.title.en} ${x.title.ru} ${x.description.en} ${x.description.ru} ${x.body}`).join('\n');
    };
    expect(templates.roles.get('DEV-RED')!.skills.map(k => k.id)).not.toContain('dev-threat-model');
    expect(textOf('DEV-RED')).not.toMatch(/attack|hostile|exploit|steal|атак|враждеб|взлом/i);
    expect(textOf('DEV-SEC')).not.toMatch(/attack|hostile|exploit|steal|атак|враждеб|эксплуат|взлом/i);
  });

  it('runs the whole test suite once per turn, checks a task by what it changed, and keeps the head out of the work', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    const perTask = ['dev-implement', 'dev-worktrees', 'dev-tdd', 'dev-ci-release', 'hh-task-flow', 'hh-verify-before-done'].map(body).join('\n');
    expect(perTask).not.toMatch(/full test suite|whole test command|every change runs|the suite passes/i);
    expect(body('dev-gates')).toMatch(/once per turn/);
    expect(body('dev-gates')).toContain('final check');
    expect(body('hh-task-flow')).toContain('message_employee');
    expect(body('hh-report-to-head')).toContain('message_employee');
    expect(body('hh-lead-tasks')).toMatch(/no permissions/);
    expect(body('hh-break-down')).toMatch(/not a step of preparation/);
    expect(templates.roles.get('DEV-OPS')!.body).toContain('final check');
  });

  it('runs the whole test suite through run_tests on a free machine, in parts when its runner can split', () => {
    const texts = { 'dev-gates': templates.skills.get('dev-gates')!.body, 'hh-run-checks': templates.skills.get('hh-run-checks')!.body };
    for (const [id, text] of Object.entries(texts)) {
      expect(text, id).toContain('run_tests');
      expect(text, id).toMatch(/free (?:compatible )?machine/);
      expect(text, id).toMatch(/in parts/);
    }
  });

  it('lays each goal out whole and uses the shared admission rule for new asks', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(body('orch-plan-turn')).toMatch(/one task for the one department that owns it end to end/);
    expect(body('orch-plan-turn')).toContain('hh-lead-tasks');
    expect(body('orch-plan-turn')).not.toMatch(/only when the CEO says/);
    for (const id of ['orch-plan-turn', 'hh-break-down']) expect(body(id), id).toMatch(/plans, contracts or proofs/);
    expect(body('hh-break-down')).toMatch(/whole blocks as hh-lead-tasks says/);
    expect(body('hh-break-down')).not.toMatch(/two to four/);
    expect(body('hh-break-down')).not.toMatch(/a few hours of work/);
  });

  it('has heads give out big pieces at once, answer in comments and leave the work and the status to others', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(body('hh-lead-tasks')).toMatch(/Give independent blocks to different members at once/);
    for (const id of ['hh-lead-tasks', 'hh-brief-members']) expect(body(id), id).toMatch(/once/);
    /* A comment by whoever gave a blocked task out opens it again and wakes its executor, so a body is written once. */
    for (const id of ['hh-lead-tasks', 'hh-brief-members', 'hh-handle-reports']) expect(body(id), id).toMatch(/"comment"/);
    for (const id of ['hh-lead-tasks', 'hh-brief-members']) expect(body(id), id).toMatch(/only when the goal (itself )?changes/);
    expect(body('hh-lead-tasks')).not.toMatch(/rewrite the body as the current truth/);
    expect(body('hh-head')).toMatch(/switches off members with no work in the turn/);
    expect(body('hh-notebook')).toMatch(/notebook only when something it holds changes/);
    expect(body('hh-status-update')).toMatch(/one line/);
    for (const r of roles.filter(x => x.kind === 'head')) expect(r.body, r.id).not.toMatch(/status to the orchestrator|keep the orchestrator informed/);
    expect(templates.roles.get('DEV-HEAD')!.body).toMatch(/all at once/);
  });

  it('runs developers as a pool that each own a whole feature, with a short architect step before large work', () => {
    const role = (id: string) => templates.roles.get(id)!;
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(role('DEV-ENG').body).toMatch(/whole feature with all its parts \(plan, code, tests, docs\) on one branch/);
    /* A product may have no server or no screen: the role names no part as if every feature had it. */
    expect(role('DEV-ENG').body).not.toMatch(/server|interface/);
    expect(role('DEV-ENG').description.en).not.toMatch(/server|interface/);
    expect(role('DEV-ENG').description.ru).not.toMatch(/сервер|интерфейс/);
    expect(role('DEV-ENG').body).toMatch(/write each test before the code/);
    /* Debugging was taken off only to keep one prompt short; skills are files now. */
    for (const id of ['dev-implement', 'dev-migrations', 'dev-debugging', 'dev-frontend-ui', 'dev-browser-check']) expect(role('DEV-ENG').skills.find(k => k.id === id)?.on, id).toBe(true);
    expect(role('DEV-HEAD').body).toMatch(/different features to different developers all at once/);
    for (const text of [role('DEV-HEAD').body, body('hh-break-down')]) expect(text).toMatch(/touch the same files/);
    for (const text of [role('DEV-HEAD').body, role('DEV-ARCH').body, body('hh-break-down')]) expect(text).toMatch(/design note/);
    expect(role('DEV-ARCH').body).toMatch(/no gates/);
    expect(body('dev-plan-review')).toMatch(/where it goes, what changes, the interfaces and the risks/);
    expect(templates.skills.get('dev-plan-review')!.kind).not.toBe('gate');
    expect(body('hh-lead-tasks')).toMatch(/[Bb]uilders build and reviewers review/);
    for (const x of [...roles, ...skills]) expect(x.body, x.id).not.toMatch(/not by layer/);
  });

  it('reviews a turn once, with every reviewer at once, and sends its fixes in without a second review', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    const gates = body('dev-gates');
    expect(gates).toMatch(/Work goes out without gates/);
    expect(gates).toMatch(/checks everything the turn changed on its branch at the same time/);
    expect(gates).toMatch(/fix task without gates to the member whose change it is/);
    expect(gates).toMatch(/starts with a test that fails and then passes; there is no second review/);
    expect(templates.roles.get('DEV-HEAD')!.body).toMatch(/one review of the turn/);
    expect(templates.roles.get('DEV-REV')!.body).toMatch(/everything the turn changed/);
    expect(templates.roles.get('DEV-SEC')!.body).toMatch(/review of each turn/);
    expect(body('dev-review-verdict')).toMatch(/write to nobody while you review/);
    expect(body('hh-fix-loop')).toMatch(/After the review of a turn nobody checks again/);
  });

  it("splits a CEO's ask into turns by what must come first, never by size", () => {
    const plan = templates.skills.get('orch-plan-turn')!.body;
    expect(plan).toMatch(/Split by what must come first, never by size/);
    expect(plan).toMatch(/one turn, however large/);
    expect(plan).toMatch(/reviewed, tested and released first, or when the CEO has to see a result/);
  });

  it('gates work by its size and risk, and fails it only for what blocks', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    const gates = body('dev-gates');
    expect(gates).toMatch(/Research, reports, plans, docs and the architect's design note never get one/);
    expect(gates).toMatch(/[Oo]ne review/);
    expect(gates).toMatch(/access, sign-in, secrets or permissions/);
    expect(gates).toMatch(/one reviewer of each provider/);
    expect(gates).toMatch(/once per turn, on the turn's branch/);
    expect(gates).toMatch(/sensitive changed paths, risky added diff or explicit pre-release mode/);
    expect(gates).not.toContain('risky or public-facing');
    expect(templates.roles.get('DEV-QA')!.gate).toBeNull();
    expect(body('dev-review-diff')).toMatch(/[Oo]bvious security problems/);
    expect(body('hh-task-flow')).toMatch(/only if you sent it back/);
    expect(templates.roles.get('DEV-RED')!.body).toMatch(/declared risk, sensitive paths, risky diff or pre-release mode/);
    expect(templates.roles.get('DEV-RED')!.body).not.toContain('or public-facing');
    expect([...roles, ...skills].map(x => x.body).join('\n')).not.toMatch(/[Ee]very (employee|one) of a gate's role/);
    expect(gates).not.toMatch(/doubled/i);
    for (const id of ['dev-gates', 'dev-review-verdict']) expect(body(id), id).toMatch(/only the fixes/);
    const verdict = body('dev-review-verdict');
    expect(verdict).toMatch(/a failing test, an unmet requirement of the task, a security hole or data loss/);
    expect(verdict).toMatch(/every blocking finding/);
    expect(verdict).toMatch(/notes? under (a|the) pass/);
    expect(verdict).not.toMatch(/Important/);
    for (const id of ['DEV-REV', 'DEV-SEC', 'DEV-TEST', 'DEV-QA', 'DEV-RED']) expect(templates.roles.get(id)!.body, id).toMatch(/blocking/);
    expect(templates.roles.get('DEV-SEC')!.body).toMatch(/access, sign-in, secrets or permissions/);
  });

  it('runs the whole test suite once per turn, by the test engineer, never on a task', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    const all = [...roles, ...skills].map(x => x.body).join('\n');
    expect(all).not.toMatch(/Run the whole suite through run_tests/);
    expect(all).not.toMatch(/changed function at CRAP 10/);
    for (const id of ['DEV-ENG', 'DEV-REV']) expect(templates.roles.get(id)!.body, id).toMatch(/never run the project's whole test suite/);
    expect(body('hh-task-flow')).toMatch(/Completion of "run_tests" or "run_work"[\s\S]*ends that wait/);
    expect(body('hh-task-flow')).not.toMatch(/npm test|whole test suite/);
    const test = templates.roles.get('DEV-TEST')!;
    expect(test.gate).toBeNull();
    expect(test.body).toMatch(/never a gate on a task/);
    const gates = body('dev-gates');
    expect(gates).toMatch(/head assigns a test engineer or QA[\s\S]*once per turn[\s\S]*final pinned commit/);
    expect(gates).not.toMatch(/or runs run_tests itself when there is neither/);
    expect(gates).toMatch(/only what failed and the tests around it/);
    for (const id of ['dev-testing-policy', 'dev-review-verdict']) expect(body(id), id).toMatch(/old complexity/);
  });

  it('has Operations lead a problem: diagnosis split at once, the database only read by the head, one message back', () => {
    const head = templates.roles.get('OPS-HEAD')!.body;
    expect(head).toMatch(/"database"/);
    expect(head).toMatch(/one message/);
    expect(templates.skills.get('ops-intake')!.body).toMatch(/two or three members at once/);
    /* Its tool only reads, so a change in the database goes to the orchestrator. */
    for (const text of [head, templates.skills.get('ops-intake')!.body]) expect(text).toMatch(/only reads?[\s\S]*SQL and why/);
    for (const id of ['ops-intake', 'ops-incident-response']) expect(templates.skills.get(id)!.body, id).toMatch(/[Rr]ead-only diagnosis and small fixes need no gates/);
    expect(templates.skills.get('ops-incident-response')!.body).not.toMatch(/every hour/);
  });

  it('has the orchestrator look in the database before it asks anyone why work went wrong', () => {
    const trouble = templates.skills.get('orch-trouble')!.body;
    for (const words of ['"database"', 'agent_changes', 'jobs', 'task_events', 'agent_events', 'head of Operations']) expect(trouble, words).toContain(words);
    expect(trouble).toMatch(/never outranks the CEO's goals/);
  });

  it('passes files as task attachments, never pasted into comments', () => {
    for (const id of ['hh-task-flow', 'hh-brief-members']) expect(templates.skills.get(id)!.body, id).toContain('hh-attach --task N FILE');
    expect(templates.skills.get('hh-task-flow')!.body).toContain('hh-fetch N NAME');
    expect(skills.map(s => s.body).join('\n')).not.toMatch(/base64/i);
  });

  it('starts work that waits for another by itself, and has each executor merge into the turn branch', () => {
    for (const id of ['hh-lead-tasks', 'hh-break-down']) expect(templates.skills.get(id)!.body, id).toContain('`after`');
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/each work area has one owner until its task is done/);
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/work that depends on the same place stays one batch with that owner/);
    expect(templates.skills.get('dev-lead')!.body).toMatch(/keeps its owner until that task merges; same-file dependencies stay one batch with that owner/);
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/moves or stays with the one it waits on, including when handing work to new employees/);
    for (const id of ['dev-gates', 'dev-ci-release', 'dev-worktrees']) expect(templates.skills.get(id)!.body, id).toContain("the turn's branch");
    expect(templates.roles.get('DEV-OPS')!.body).toContain("the turn's branch");
    expect([...roles, ...skills].map(x => x.body).join('\n')).not.toMatch(/merge the turn's task branches/);
  });

  it('has the development head ask the holder of a quiet task before handing it on', () => {
    expect(templates.roles.get('DEV-HEAD')!.skills.map(k => k.id)).toContain('dev-worktrees');
    expect(templates.skills.get('dev-worktrees')!.body).toMatch(/long test run, not a stuck member[\s\S]*ask its holder and wait one more round/);
  });

  it('leaves releases to the merge into main, on machines without Docker', () => {
    const builders = [templates.roles.get('DEV-ENG')!.body, templates.skills.get('dev-ci-release')!.body];
    for (const text of [...builders, templates.skills.get('dev-worktrees')!.body]) {
      expect(text).toMatch(/[Nn]ever start a release or image publishing workflow from a branch/);
      expect(text).toMatch(/merge into main/);
    }
    for (const text of builders) expect(text).toMatch(/no Docker/);
  });

  it('adds missing quality checks to the project in one task instead of installing them in an agent home folder', () => {
    const all = [...roles, ...skills].map(x => x.body).join('\n');
    expect(all).not.toContain('install what is missing in your home folder');
    const text = templates.skills.get('dev-language-rules')!.body;
    expect(text).toMatch(/do not install .* locally or work around .* tell the head of Development/i);
    for (const example of ['@vitest/coverage-v8', 'same version as vitest', 'pytest-cov', 'cargo-llvm-cov', 'Go has coverage built in', 'typescript-eslint', 'ruff', 'clippy', 'golangci-lint']) {
      expect(text, example).toContain(example);
    }
    const lead = templates.skills.get('dev-lead')!.body;
    expect(lead).toMatch(/first turn on a new project and when a new repository arrives/);
    expect(lead).toMatch(/one task that adds everything missing to the project itself/);
  });

  it.each(['DEV-ENG', 'DEV-REV', 'DEV-SEC'])('tells %s that a run starts with its dependencies prepared, and what to do when it did not', roleId => {
    const role = templates.roles.get(roleId)!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Bruno', roleKey: roleId, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    const rules = rendered.skills.find(s => s.name === 'dev-language-rules')!.body;
    expect(rules).toMatch(/dependencies come prepared/);
    expect(rules).toMatch(/installs and builds nothing first, in any language/);
    expect(rules).toMatch(/started without the harness, install from the lockfile with the project's standard command/);
    expect(rules).toMatch(/never run dependency installers locally/i);
    for (const example of ['npm scripts', 'npx --no-install']) expect(rules, example).toContain(example);
    expect(rules).toMatch(/temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies/);
    expect(rules).toMatch(/imports resolve its `node_modules`/);
    expect(rules).toMatch(/ERR_MODULE_NOT_FOUND` when a run started without the harness is not an application defect/);
    /* The rule holds in any language, and what is about npm stands apart, for that kind of project. */
    const setup = rules.split('\n').find(line => line.startsWith('4.'))!;
    expect(setup).toContain('In an npm project:');
    expect(setup.split('In an npm project:')[0]).not.toMatch(/npm|npx|node_modules|JavaScript|ESLint|Vitest|Playwright/);
  });

  it('credits every source a skill names in SOURCES.md', () => {
    const credits = readFileSync(`${DIR}/SOURCES.md`, 'utf8');
    for (const s of skills) for (const src of s.sources) expect(credits, `${s.id} ${src}`).toContain(src.split(' ')[0]);
  });

  it('tells browser checks to verify the preinstalled browser opens instead of installing it by hand, without naming Hornhoof', () => {
    const check = templates.skills.get('dev-browser-check')!.body;
    expect(check).toMatch(/verify the browser opens/i);
    expect(check).toMatch(/instead of running `playwright install` by hand/);
    expect(check).not.toMatch(/hornhoof/i);
    for (const item of [...roles, ...skills]) expect(item.body, item.id).not.toMatch(/npx playwright install/);
  });

  describe('differential second looks, vertical slices, author evidence and verified finding provenance', () => {
    const current = (): ReviewSkills => ({
      diff: templates.skills.get('dev-review-diff')!.body,
      verdict: templates.skills.get('dev-review-verdict')!.body,
      security: templates.skills.get('dev-security-review')!.body,
    });

    it('satisfies every differential review, T6/T10 evidence, slice and provenance rule in the shipped skills', () => {
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, current())).toEqual([]);
      for (const id of ['dev-review-diff', 'dev-review-verdict']) expect(templates.skills.get(id)!.body, id).not.toMatch(/hornhoof/i);
    });

    it('rejects broken-meaning skills even when required substrings remain present', () => {
      const base = current();
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, base)).toEqual([]);
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nOn a second look, read the whole patch again alongside reviewedCommit..fixCommit.` })).toContain('no-repeat-full-read-or-high');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nOn a second look, rerun your program's own review after reading reviewedCommit..fixCommit.` })).toContain('no-repeat-full-read-or-high');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nIn Claude Code run its code-review skill at high effort on every round.` })).toEqual(
        expect.arrayContaining(['native-review-first-look-only', 'no-repeat-full-read-or-high']),
      );
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, security: `${base.security}\nOn a second round, run codex review --base <main line> again.` })).toEqual(
        expect.arrayContaining(['native-review-first-look-only', 'no-repeat-full-read-or-high']),
      );
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, diff: `${base.diff}\nThe general review of a turn has two rounds when fixes touch routes.` })).toContain('turn-review-one-round');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nVerify testEvidence run and commitSha, then rerun the author's test runs to confirm.` })).toContain('t10-verify-evidence-no-rerun');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nEven with harm to a person rules, low coverage alone is a blocking finding.` })).toContain('t6-named-harm-no-coverage-chasing');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nAbove 800 lines, split across two reviewers by folders after task.reviewPlan.` })).toContain('vertical-slices-above-800');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nA reviewer's own verdict marks its findingId confirmed for provider counts.` })).toContain('structured-findings-and-provenance');
      expect(failedRuleIds(REVIEW_CONTRACT_RULES, { ...base, verdict: `${base.verdict}\nAuthors of internal role or skill rules may take release approval on main when docs have no gates.` })).toContain(
        'no-self-or-role-rule-main-release-approval',
      );
    });
  });

  describe('mandatory UI panel wrapping, parallel non-visual work and dynamic language checks', () => {
    const uiBody = () => templates.skills.get('dev-frontend-ui')!.body;

    it('enables dev-frontend-ui by default on DEV-ENG and DEV-FE and satisfies every generic UI wrapping and language rule', () => {
      for (const roleId of ['DEV-ENG', 'DEV-FE'] as const) {
        expect(templates.roles.get(roleId)!.skills.find(s => s.id === 'dev-frontend-ui')?.on, roleId).toBe(true);
      }
      const browserCheck = templates.skills.get('dev-browser-check')!.body;
      /* How a view is built is in one skill, how it is checked in the other: together they hold every rule. */
      expect(failedRuleIds(FRONTEND_UI_RULES, `${uiBody()}\n${browserCheck}`)).toEqual([]);
      expect(uiBody()).toContain('dev-browser-check');
      expect(browserCheck).toMatch(/longest[\s\S]*shortest[\s\S]*shipped/i);
      expect(browserCheck).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
      const agentsDoc = readFileSync(join(DIR, '../AGENTS.md'), 'utf8');
      const contributingDoc = readFileSync(join(DIR, '../CONTRIBUTING.md'), 'utf8');
      for (const doc of [agentsDoc, contributingDoc]) {
        expect(doc).toContain('templates/skills/dev-frontend-ui.md');
        expect(doc).toContain('(docs/style-book.md)');
        expect(doc).toContain('apps/web/src/i18n/index.tsx');
        expect(doc).toMatch(/longest[\s\S]*shortest|shortest[\s\S]*longest/i);
        expect(doc).toMatch(/whole group|one group/i);
        expect(doc).toMatch(/explicit[\s\S]*browser default/i);
        expect(doc).toMatch(/scrollbar space/i);
        expect(doc).toMatch(/Chromium[\s\S]*Firefox[\s\S]*WebKit/);
        expect(doc).not.toMatch(/Add screenshots in English and Russian/);
      }
      expect(agentsDoc).toContain('CONTRIBUTING.md#interface-panels-and-language-checks');
      expect(contributingDoc).toContain('### Interface panels and language checks');
    });

    it('ships the approved repository style book with matching theme tokens, existing source paths and dated exceptions', () => {
      const root = join(DIR, '..');
      const styleBook = readFileSync(join(root, 'docs/style-book.md'), 'utf8');
      const themeCss = readFileSync(join(root, 'apps/web/src/theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(styleBook).toContain('Version 1.1, approved by the head of Design on 2026-11-06.');
      expect(styleBook).not.toMatch(/[\u2014\u0451\u0401]/);
      for (const heading of [
        '## 1. Colours',
        '## 2. Type',
        '## 3. Spacing and sizes',
        '## 4. Components',
        '### Materials of a question',
        '## 5. Languages',
        '## 6. Text wrap and action groups',
        '## 7. Site and marketing',
        '## 8. Using and changing this book',
        '## 9. Browsers',
      ]) {
        expect(styleBook).toContain(heading);
      }
      const materialsSection = styleBook.slice(styleBook.indexOf('### Materials of a question'), styleBook.indexOf('### Tables'));
      expect(materialsSection).toContain('A material and an answer are never nested and never look alike.');
      expect(materialsSection).toContain('Opening, zooming, paging, closing and downloading choose nothing and send nothing.');
      expect(materialsSection).toContain('a picture takes the whole width of the option');
      expect(materialsSection).toContain('The viewer covers the window, follows the theme and keeps its close button on screen. A document reads to its end');
      expect(materialsSection).toContain('A refused or failed material keeps its name and says why in words.');
      expect(materialsSection).toContain('A download mark appears only on what can be downloaded.');
      expect(materialsSection).toContain('a field not in the code yet is marked as proposed.');
      expect(styleBook).toContain('| 1.1 | 2026-11-06 | Rules for materials of a question | Head of Design |');
      expect(styleBook).toMatch(/ui\/Notebook\.tsx[\s\S]*Reviewed by 2027-02-05/);
      expect(styleBook).toMatch(/\.chip[\s\S]*Reviewed by 2027-02-05/);
      expect(styleBook).toMatch(/Close button of a panel[\s\S]*Reviewed by 2027-02-05/);
      const light = themeDeclarations(themeCss, ':root {');
      const dark = themeDeclarations(themeCss, ':root[data-theme="dark"]');
      const colourSection = styleBook.slice(styleBook.indexOf('## 1. Colours'), styleBook.indexOf('### Contrast of text'));
      const bookColours = Object.fromEntries(
        [...colourSection.matchAll(/^\| `(--[\w-]+)` \| `([^`]+)` \| `([^`]+)` \|/gm)].map(m => [m[1]!, [m[2]!, m[3]!]]),
      );
      expect(Object.keys(bookColours).length).toBeGreaterThanOrEqual(27);
      const actualColours = Object.fromEntries(Object.keys(bookColours).map(k => [k, [light[k], dark[k]]]));
      expect(actualColours).toEqual(bookColours);
      const typeSection = styleBook.slice(styleBook.indexOf('## 2. Type'), styleBook.indexOf('Fonts are imported'));
      const bookFonts = Object.fromEntries([...typeSection.matchAll(/^\| `(--[\w-]+)` \| `([^`]+)` \|/gm)].map(m => [m[1]!, m[2]!]));
      expect(Object.keys(bookFonts)).toEqual(['--f-display', '--f-body', '--f-mono']);
      expect(Object.fromEntries(Object.keys(bookFonts).map(k => [k, light[k]]))).toEqual(bookFonts);
      const sources = [...new Set(styleBookSources(styleBook))];
      expect(sources.length).toBeGreaterThanOrEqual(46);
      expect(sources.filter(rel => !existsSync(join(root, rel)))).toEqual([]);
    });

    it('rejects UI skill text that allows clipping, hiding button groups, blocking non-visual work or fixed/pseudo locales', () => {
      const base = `${uiBody()}\n${templates.skills.get('dev-browser-check')!.body}`;
      expect(failedRuleIds(FRONTEND_UI_RULES, base)).toEqual([]);
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhen a narrow panel overflows, truncate text with ellipsis to prevent horizontal scroll.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhen space runs short, hide secondary action buttons behind clipped overflow.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWrap action buttons one by one onto separate lines with custom per-row spacing.`)).toContain(
        'panel-wrap-and-whole-button-group',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWait on the design mockup before starting API, state logic or temporary skeleton work.`)).toContain(
        'parallel-nonvisual-visual-only-waits',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nWhile waiting on Design, invent custom spacing tokens for visual polish.`)).toContain(
        'parallel-nonvisual-visual-only-waits',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nCount a pseudo-locale or demo string as a shipped language during UI checks.`)).toContain(
        'multilang-and-dynamic-shipped-locales',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nAlways check a fixed two-language pair forever instead of measuring shipped translations.`)).toContain(
        'multilang-and-dynamic-shipped-locales',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nFollow Hornhoof's .notebook and theme.css rules in every company.`)).toContain(
        'project-reference-without-company-lockin',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nRely on browser default geometry and padding for icon buttons.`)).toContain(
        'explicit-component-geometry-and-scrollbar-space',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nAssume overlay scrollbars instead of reserving scrollbar space in scrollable panels.`)).toContain(
        'explicit-component-geometry-and-scrollbar-space',
      );
      expect(failedRuleIds(FRONTEND_UI_RULES, `${base}\nCount a single browser engine run as cross-engine verification.`)).toContain(
        'three-browser-engines-check',
      );
    });
  });

  describe('hh-questions shared skill and materials rule', () => {
    it('loads hh-questions as a core skill with an abstract English rule to attach materials via the question tool rather than prose paths', () => {
      const skill = templates.skills.get('hh-questions');
      expect(skill).toBeDefined();
      expect(skill!.kind).toBe('core');
      expect(skill!.grants).toEqual([]);
      expect(skill!.body).toContain('- **Materials**:');
      expect(skill!.body).toMatch(/attach[\s\S]*materials[\s\S]*question tool[\s\S]*rather than[\s\S]*(?:local )?file paths/i);
      expect(skill!.body).toMatch(/inspect[\s\S]*in full[\s\S]*before answering/i);
      const materialsLine = skill!.body.split('\n').find(line => line.startsWith('- **Materials**:')) ?? '';
      expect(materialsLine).not.toMatch(/hornhoof|david|ivan|#\d+|202\d-/i);
    });
  });

  describe('shared remote check route, reconciled skill sources and head operational hold rules', () => {
    const runChecksBody = () => templates.skills.get('hh-run-checks')!.body;
    const leadTasksBody = () => templates.skills.get('hh-lead-tasks')!.body;
    /* A head carries the rules of leading, which the orchestrator shares, and those of a department's head, which come first. */
    const headBodies = () => `${templates.skills.get('hh-head')!.body}\n${leadTasksBody()}`;
    const orchestratorOutage = (): OrchestratorOutageSkills => ({ lead: leadTasksBody(), trouble: templates.skills.get('orch-trouble')!.body });
    const checkSources = (): ReconciledCheckSkills => ({
      tdd: templates.skills.get('dev-tdd')!.body,
      policy: templates.skills.get('dev-testing-policy')!.body,
      language: templates.skills.get('dev-language-rules')!.body,
      implement: templates.skills.get('dev-implement')!.body,
      browser: templates.skills.get('dev-browser-check')!.body,
      e2e: templates.skills.get('dev-e2e-tests')!.body,
      ciRelease: templates.skills.get('dev-ci-release')!.body,
    });

    it('locks abstract hh-run-checks on for every role and the orchestrator with zero extra grants or incident facts', () => {
      expect(CORE_SKILLS).toContain('hh-run-checks');
      expect(ORCHESTRATOR_SKILLS).toContain('hh-run-checks');
      const skill = templates.skills.get('hh-run-checks');
      expect(skill).toBeDefined();
      expect(skill!.kind).toBe('core');
      expect(skill!.grants).toEqual([]);
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, runChecksBody())).toEqual([]);
      for (const r of roles) {
        expect(r.skills.find(s => s.id === 'hh-run-checks'), r.id).toEqual({ id: 'hh-run-checks', on: true, locked: true });
      }
      expect(orchestratorSteady(templates).text).toContain(runChecksBody());
    });

    it('rejects broken-meaning hh-run-checks text even when required keywords remain present', () => {
      const base = runChecksBody();
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, base)).toEqual([]);
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nRun two test files or a directory locally during RED.`)).toContain('single-regular-file-local-red-green');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nAllow npm install locally when adding a feature dependency.`)).toContain('deny-local-installers-keep-manifest-edits');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nCount a run_work dependency step as T2 check evidence.`)).toContain('noncheck-run-work-separate-from-mixed-checks');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nWhen run_tests is unavailable, fall back to running heavy checks locally.`)).toContain('unavailable-route-blocks-and-refusal-never-pass');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nTreat a command refusal as PASS once logged.`)).toContain('unavailable-route-blocks-and-refusal-never-pass');
      expect(failedRuleIds(RUN_CHECKS_CORE_RULES, `${base}\nPatch Hornhoof task #530 for David on 2026-11-06.`)).toContain('abstract-english-no-incident-facts');
    });

    it('reconciles the development skills that run checks with run_tests while preserving project commands and screenshot rules', () => {
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, checkSources())).toEqual([]);
    });

    it('rejects contradictory local bulk-check instructions reintroduced into reconciled skills', () => {
      const base = checkSources();
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, base)).toEqual([]);
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, ciRelease: `${base.ciRelease}\nReproduce it locally with the same command.` })).toContain(
        'no-contradictory-local-heavy-directions',
      );
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, policy: `${base.policy}\ncrapper and dryer are installed on your machine.` })).toContain(
        'no-contradictory-local-heavy-directions',
      );
      expect(failedRuleIds(RECONCILED_SKILL_SOURCE_RULES, { ...base, browser: `${base.browser}\nTreat every Chromium screenshot capture as a full browser test suite.` })).toContain(
        'browser-suite-remote-light-screenshot-distinct',
      );
    });

    it('teaches every department head abstract external-outage hold recovery and orchestrator-authority forwarding', () => {
      expect(HEAD_SKILLS).toEqual(expect.arrayContaining(['hh-head', 'hh-lead-tasks']));
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, headBodies())).toEqual([]);
      for (const role of roles.filter(r => r.kind === 'head')) {
        const rendered = renderInstructions(
          templates,
          { id: 'h', companyId: 'c', kind: 'head', name: 'Hana', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1],
          { company: 'Acme', department: 'Work', product: null },
        );
        expect(Buffer.byteLength(rendered.text), role.id).toBeLessThan(24_000);
        expect(rendered.text, role.id).toContain(leadTasksBody());
        expect(rendered.text, role.id).toContain(templates.skills.get('hh-head')!.body);
      }
    });

    it('rejects head instructions that prolong holds after recovery, freeze unrelated work or leak incident history', () => {
      const base = headBodies();
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, base)).toEqual([]);
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nKeep a general hold active after the external service recovers until each task asks again.`)).toContain(
        'outage-does-not-prolong-hold-and-lifts-at-once',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nFreeze all unrelated tasks across the department when one task hits a repeated local error.`)).toContain(
        'local-error-isolated-and-orchestrator-decisions-forwarded',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nHold orchestrator-level decisions in your own queue until the end of the turn.`)).toContain(
        'local-error-isolated-and-orchestrator-decisions-forwarded',
      );
      expect(failedRuleIds(HEAD_OUTAGE_AND_AUTHORITY_RULES, `${base}\nRemember the GitHub push outage from David on #551 on 2026-11-06.`)).toContain(
        'abstract-head-rule-preserves-gates-and-dependencies',
      );
    });

    it('teaches the orchestrator abstract external-outage hold, one-action unhold and ordinary-retry rules while preserving safety rules', () => {
      const trouble = templates.skills.get('orch-trouble')!;
      expect(trouble.kind).toBe('procedure');
      expect(trouble.description.en).toMatch(/external service failures/i);
      expect(ORCHESTRATOR_SKILLS).toEqual(expect.arrayContaining(['hh-lead-tasks', 'orch-trouble']));
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, orchestratorOutage())).toEqual([]);
      expect(leadTasksBody().split('External outages and holds:').length - 1).toBe(1);
      expect(templates.skills.get('ops-api-connector')!.body).toContain('Never retry a payment or a send without first checking it did not already happen.');
      expect(templates.skills.get('dev-worktrees')!.body).toContain('Never force-push a shared branch');
      expect(templates.skills.get('hh-stay-in-scope')!.body).toContain('change permissions');
      expect(templates.skills.get('hh-stay-in-scope')!.body).toContain('Anything irreversible or public waits for the approval');
      expect(templates.skills.get('dev-ci-release')!.body).toContain('never skip, mute or retry a check to get green');
      expect(templates.skills.get('dev-testing-policy')!.body).toContain('without retries or quarantine');
      expect(templates.skills.get('ops-task-watch')!.body).toContain('Never retry it unchanged.');
      for (const s of skills) {
        expect(s.body, s.id).not.toMatch(/\bexactly one attempt\b|\bno retries\b|\bdo not declare recovery\b/i);
      }
    });

    it('rejects orchestrator outage instructions that prolong holds, serialize recovery through a head queue, demand permission for ordinary retries, promise unshipped automation or leak incident history', () => {
      const base = orchestratorOutage();
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, base)).toEqual([]);
      const told = (line: string): OrchestratorOutageSkills => ({ ...base, trouble: `${base.trouble}\n${line}` });
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Keep a general hold active after the external service recovers.'))).toContain(
        'outage-not-grounds-for-longer-general-hold',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told("Send hold-lifting decisions one by one through a department head's queue."))).toContain(
        'orchestrator-decides-and-communicates-in-one-action',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Require permission before any ordinary retry, allow at most one attempt with no retries, and do not declare recovery.'))).toContain(
        'ordinary-retry-needs-no-permission-or-diagnosis-chain',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('Remember the GitHub outage from Ivan on #551 on 05.11.'))).toContain(
        'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
      );
      expect(failedRuleIds(ORCHESTRATOR_OUTAGE_RULES, told('The server automatically retries git push in the background and blocks task creation in SQL.'))).toContain(
        'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
      );
    });

    it('teaches department heads abstract department-load ownership, independent after-chain slices and urgent-only team boundaries while keeping watchdog idle-fault rules intact', () => {
      const leadSkill = templates.skills.get('hh-lead-tasks')!;
      const breakDownSkill = templates.skills.get('hh-break-down')!;
      expect(leadSkill.description.en).toMatch(/keeps the department loaded/i);
      expect(breakDownSkill.description.en).toMatch(/independent parts[\s\S]*loaded/i);
      expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, { lead: leadSkill.body, breakDown: breakDownSkill.body })).toEqual([]);
      expect(templates.roles.get('OPS-WATCH')!.body).toContain('no one stands free while work waits');
      expect(templates.skills.get('ops-task-watch')!.body).toContain('People who stand free while work waits are a fault, not a normal wait');
    });

    it('rejects head breakdown instructions that treat idle capacity as normal, omit independentPart/independentNone, assign ordinary work to urgent-only teams or leak incident names', () => {
      const base: HeadLoadSkills = {
        lead: leadTasksBody(),
        breakDown: templates.skills.get('hh-break-down')!.body,
      };
      expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, base)).toEqual([]);
      const cases: [keyof HeadLoadSkills, string, string][] = [
        ['lead', 'Members standing free while work waits is a normal wait, and the head only orders tasks.', 'free-members-with-runnable-work-is-fault-and-head-owns-load'],
        ['breakDown', 'Leave after tasks without independentPart or independentNone, and send independentNone tasks out early.', 'after-chains-require-independent-part-or-none-preserving-boundaries'],
        ['lead', 'Assign ordinary non-urgent work to an urgentOnly team whenever peers are busy.', 'urgent-only-team-refuses-non-urgent-and-names-free-peers'],
        ['lead', 'Never give Tiger Team or Simon ordinary work on #348 after 2026-11-06.', 'abstract-no-incident-names-or-unshipped-idle-wake'],
        ['breakDown', 'Hornhoof wakes you automatically whenever two members stand free.', 'abstract-no-incident-names-or-unshipped-idle-wake'],
      ];
      for (const [key, badLine, ruleId] of cases) {
        expect(failedRuleIds(HEAD_DEPARTMENT_LOAD_RULES, { ...base, [key]: `${base[key]}\n${badLine}` }), badLine).toContain(ruleId);
      }
    });
  });

  describe('mechanical finding category and strict behavior-unchanged boundary', () => {
    const pair = (): MechanicalSkills => ({
      diff: templates.skills.get('dev-review-diff')!.body,
      verdict: templates.skills.get('dev-review-verdict')!.body,
    });

    it('matches the IssueInput category enum and mechanicalVerdict server aggregate in both readable review skills', () => {
      const { diff, verdict } = pair();
      const expected = ['security', 'data', 'spec', 'other', 'mechanical'];
      expect(documentedCategories(verdict)).toEqual(expected);
      /* A category belongs to the verdict; the check itself knows nothing of it. */
      expect(diff).not.toMatch(/\bcategory\b|\bmechanical\b/i);
      for (const category of expected) {
        expect(IssueInput.safeParse({ category, blocking: true, path: 'src/index.ts', line: 1, harm: 'Wrong behaviour.' }).success, category).toBe(true);
      }
      for (const invented of ['style', 'lint', 'medium']) {
        expect(IssueInput.safeParse({ category: invented, blocking: true, path: 'src/index.ts', line: 1, harm: 'Wrong behaviour.' }).success, invented).toBe(false);
      }
      expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, { diff, verdict })).toEqual([]);
      expect(mechanicalVerdict({ issues: [sampleFinding('mechanical', true)] })).toBe(true);
      expect(mechanicalVerdict({ issues: [sampleFinding('mechanical', true), sampleFinding('other', false)] })).toBe(false);
      expect(mechanicalVerdict({ issues: [sampleFinding('mechanical', true), sampleFinding('spec', true)] })).toBe(false);
      expect(mechanicalVerdict({ issues: [sampleFinding('mechanical', false)] })).toBe(false);
      expect(mechanicalVerdict({ issues: [sampleFinding('mechanical', true)], unresolvedFindingIds: ['11111111-1111-4111-8111-111111111111'] })).toBe(false);
    });

    it('rejects review skill text that broadens mechanical to behavioral changes, mixed verdicts, mid-turn effort switches or incident facts', () => {
      const base = pair();
      expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, base)).toEqual([]);
      const violations: [keyof MechanicalSkills, string, string][] = [
        ['verdict', "Classify a public API rename as 'mechanical' when tests compile.", 'strict-behavior-unchanged-boundary'],
        ['diff', "Use 'mechanical' when a fix may change behaviour only slightly.", 'strict-behavior-unchanged-boundary'],
        ['verdict', "When in doubt, mark the finding 'mechanical' so the fix finishes faster.", 'doubt-keeps-regular-category-and-full-base-level'],
        ['diff', "Classify spec findings as 'mechanical' to run at medium.", 'doubt-keeps-regular-category-and-full-base-level'],
        ['verdict', 'Set Wake.mechanical on mixed verdicts whenever one issue is mechanical.', 'server-aggregate-wake-mechanical-and-no-second-review'],
        ['diff', 'Switch effort inside a running turn once a mechanical issue appears.', 'server-aggregate-wake-mechanical-and-no-second-review'],
        ['verdict', "Open a second review for 'mechanical' findings after submission.", 'server-aggregate-wake-mechanical-and-no-second-review'],
        ['diff', 'Added for Hornhoof task #311 by David on 2026-11-06.', 'abstract-english-no-incident-or-company-leaks'],
      ];
      for (const [target, extra, expectedRule] of violations) {
        expect(failedRuleIds(MECHANICAL_CATEGORY_RULES, { ...base, [target]: `${base[target]}\n${extra}` }), extra).toContain(expectedRule);
      }
    });
  });
});

type ReviewSkills = { diff: string; verdict: string; security: string };

const NATIVE_TOOL_RE = /code-review skill|security-review skill|codex review --base|review-agent/i;

const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\n+/).map(line => line.trim()).filter(Boolean);

const clausesOf = (text: string): string[] =>
  text.split(/[.!?;,\n]+|\b(?:then|but|however|yet)\b/i).map(clause => clause.trim()).filter(Boolean);

const negatesBefore = (clause: string, target: RegExp): boolean => {
  const hit = target.exec(clause);
  return !hit || /\b(never|not|don't|cannot|forbid\w*|skip\w*|without|instead of|no|neither|nor)\b/i.test(clause.slice(0, hit.index));
};

const forbids = (text: string, target: RegExp): boolean =>
  clausesOf(text).every(clause => negatesBefore(clause, target));

const scopesFirstLook = (sentence: string): boolean =>
  /\bfirst look\b/i.test(sentence) && !/\b(?:second (?:look|round)|every round)\b/i.test(sentence);

const allowsNativeMention = (sentence: string): boolean =>
  scopesFirstLook(sentence) || forbids(sentence, NATIVE_TOOL_RE);

const nativeReviewScoped = (text: string): boolean => {
  const mentions = sentencesOf(text).filter(s => NATIVE_TOOL_RE.test(s));
  return mentions.some(scopesFirstLook) && mentions.every(allowsNativeMention);
};

const secondLookSentences = (s: ReviewSkills): string =>
  sentencesOf(`${s.diff}\n${s.verdict}\n${s.security}`).filter(line => /\b(?:second (?:look|round)|fixReview)\b/i.test(line)).join('\n');

const REVIEW_CONTRACT_RULES: { id: string; holds: (s: ReviewSkills) => boolean }[] = [
  {
    id: 'native-review-first-look-only',
    holds: s => nativeReviewScoped(s.diff) && nativeReviewScoped(s.security),
  },
  {
    id: 'no-repeat-full-read-or-high',
    holds: s => {
      const all = `${s.diff}\n${s.verdict}\n${s.security}`;
      const repeats = secondLookSentences(s);
      return (
        /\bfirst look[\s\S]*(?:role's|card)\b/i.test(all) &&
        forbids(all, /\b(?:at|on|force|forcing|raise\s+effort\s+to)\s+high(?:\s+effort)?\b/i) &&
        forbids(repeats, /\b(?:read|reread|re-read|inspect|review)\b[^.!?;,]*\b(?:whole|entire|full)\s+(?:patch|change|branch|diff)\b/i) &&
        forbids(repeats, /\b(?:(?:re-?)?run\w*|use|invoke|repeat\w*)\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:program's own review|native review|code-review|security-review|codex review|review-agent)\b/i) &&
        /\b(?:do not|never|skip|without|no second)\b[^.!?]*\b(?:program's own review|native review|whole (?:patch|change|branch))\b/i.test(s.diff) &&
        /\b(?:do not|never|skip|without|no second)\b[^.!?]*\b(?:program's own review|native review|whole (?:patch|change|branch))\b/i.test(s.verdict)
      );
    },
  },
  {
    id: 'immutable-fix-range-and-own-blocking-findings',
    holds: s =>
      forEvery([s.verdict], text =>
        /\btask\.fixReview\b/.test(text) &&
        /\breviewedCommit\.\.fixCommit\b/.test(text) &&
        /\breviewed_commit\.\.fix_commit\b/.test(text) &&
        /\bsecurity\b[\s\S]*\bdata\b[\s\S]*\bspec\b/.test(text) &&
        /\bsame reviewer\b/i.test(text) &&
        /\bmedium\b/i.test(text) &&
        /\bfindingIds\b/.test(text) &&
        /\bunchanged code\b[^.!?]*\bno new\b/i.test(text),
      ),
  },
  {
    id: 'turn-review-one-round',
    holds: s =>
      forEvery([s.verdict], text =>
        /\breview of a turn\b[\s\S]*\bone round\b/i.test(text) &&
        /\bfailing test\b[\s\S]*\bfinal check\b[\s\S]*\bQA\b/i.test(text),
      ) && forbids(`${s.diff}\n${s.verdict}`, /\breview of a turn\b[^.!?;,]*\btwo rounds\b/i),
  },
  {
    id: 't6-named-harm-no-coverage-chasing',
    holds: s =>
      /\bharm to a person\b/i.test(s.diff) &&
      forEvery([s.verdict], text => /\bharm to a person\b/i.test(text) && /\bT6\b/.test(text) && /\bT1\b/.test(text) && /\blow coverage alone is not a finding\b/i.test(text)) &&
      forbids(`${s.diff}\n${s.verdict}`, /\blow coverage(?:\s+alone)?\s+(?:blocks|counts as a finding|is a (?:blocking )?finding)\b/i),
  },
  {
    id: 't10-verify-evidence-no-rerun',
    holds: s =>
      /\bT10\b/.test(s.diff) &&
      /\b(?:instead of rerunning|do not rerun|never rerun)\b/i.test(s.diff) &&
      forEvery([s.verdict], text =>
        /\btask\.review\b/.test(text) &&
        /\btestEvidence\b/.test(text) &&
        /\bgateCounts\b/.test(text) &&
        /\bproves\b/.test(text) &&
        /\bT10\b/.test(text) &&
        /\b(?:instead of rerunning|do not rerun|never rerun)\b/i.test(text),
      ) && forbids(`${s.diff}\n${s.verdict}\n${s.security}`, /\b(?:re-?run\w*|re-?execut\w*)\b[^.!?;,]*\b(?:author'?s?\s+|submitted\s+|its\s+)?test(?:\s+runs?|\s+suites?|s)\b/i),
  },
  {
    id: 'vertical-slices-above-800',
    holds: s =>
      /\btask\.reviewPlan\b/.test(s.verdict) &&
      /\b800\b/.test(s.verdict) &&
      /\bvertical task slices\b[\s\S]*\bnot by folders\b/i.test(s.verdict) &&
      /\bcommonContracts\b/.test(s.verdict) &&
      /\bpackages\/protocol\b[\s\S]*\bschema\.ts\b[\s\S]*\broute schemas\b/.test(s.verdict) &&
      /\bintegrationReviewerId\b/.test(s.verdict) &&
      /\bcross-slice\b/i.test(s.verdict) &&
      /\bauthorVendor\b/.test(s.verdict) &&
      /\bdegraded\b/.test(s.verdict) &&
      forbids(s.verdict, /\bsplit\b[^.!?;,]*\bby (?:top-level )?folders\b/i),
  },
  {
    id: 'structured-findings-and-provenance',
    holds: s =>
      /\breviewedCommit\b/.test(s.verdict) &&
      /\bissues\b/.test(s.verdict) &&
      /\bfindingId\b/.test(s.verdict) &&
      /\bconfirm_finding\b/.test(s.verdict) &&
      /\bfixCommit\b/.test(s.verdict) &&
      /\breviewerVendor\b/.test(s.verdict) &&
      /\blegacy\b/i.test(s.verdict) &&
      /\bdoes not\b[^.!?]*\b(?:fixed|APPROVE)\b/i.test(s.verdict) &&
      forbids(`${s.diff}\n${s.verdict}`, /\b(?:mark\w*|confirm\w*|count\w*)\b[^.!?;,]*\bfindingId\s+confirmed\b/i),
  },
  {
    id: 'no-self-or-role-rule-main-release-approval',
    holds: s =>
      /\binternal role or skill rules\b[^.!?]*\bnever\b[^.!?]*\b(?:main|release) approval\b/i.test(s.verdict) &&
      forbids(`${s.diff}\n${s.verdict}`, /\b(?:may|can)\s+(?:take|grant|claim)\b[^.!?;,]*\b(?:main|release)\s+approval\b/i),
  },
];

const FRONTEND_UI_RULES: { id: string; holds: (text: string) => boolean }[] = [
  {
    id: 'panel-wrap-and-whole-button-group',
    holds: text =>
      /\b(?:panels?|rows?|cards?)\b[\s\S]*\bfull text\b[\s\S]*\bactions\b/i.test(text) &&
      /\blong words\b[\s\S]*\bURLs?\b[\s\S]*\bwrap\b/i.test(text) &&
      /\b(?:whole group|together as one group)\b[\s\S]*\b(?:one|single) even row\b/i.test(text) &&
      /\b(?:same|shared|consistent) edge\b[\s\S]*\bspacing\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\b(?:hide|clip|truncate|ellipsis)\b/i.test(text) &&
      forbids(text, /\b(?:truncate|clip)\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:text|words|buttons|actions|overflow|ellipsis)\b/i) &&
      forbids(text, /\bhide\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:text|action|buttons?|controls?|group|overflow)\b/i) &&
      forbids(text, /\bwrap\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bbuttons?\s+one by one\b/i),
  },
  {
    id: 'parallel-nonvisual-visual-only-waits',
    holds: text =>
      /\bnon-visual\b[\s\S]*\bdata\b[\s\S]*\bAPI\b[\s\S]*\blogic\b[\s\S]*\bstates\b[\s\S]*\bskeleton\b[\s\S]*\bin parallel\b/i.test(text) &&
      /\bonly\b[^.!?]*\bvisual\b[^.!?]*\bwaits?\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\binvent\b[^.!?]*\b(?:tokens?|spacing)\b/i.test(text) &&
      forbids(text, /\bwait\w*\b(?:(?!\b(?:without|instead of|only)\b)[^.!?;,])*\bdesign mockup\b[^.!?;,]*\bbefore\b[^.!?;,]*\b(?:API|state|logic|skeleton)\b/i) &&
      forbids(text, /\binvent\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:tokens?|spacing)\b/i),
  },
  {
    id: 'multilang-and-dynamic-shipped-locales',
    holds: text =>
      /\b20\s*(?:to|-)\s*30\s+languages\b/i.test(text) &&
      /\b1\.5x?\b[\s\S]*\b2x?\b/i.test(text) &&
      /\bCJK\b[\s\S]*\bDevanagari\b[\s\S]*\bline-height\b/i.test(text) &&
      /\bRTL\b[\s\S]*\bmirror\w*\b/i.test(text) &&
      /\blongest\b[\s\S]*\bshortest\b[\s\S]*\b(?:actually )?(?:shipped|supported)\b[\s\S]*\breal\b/i.test(text) &&
      /\bRTL\b[^.!?]*\b(?:when|once)\b/i.test(text) &&
      /\b(?:never|do not)\b[^.!?]*\bpseudo-locale\b/i.test(text) &&
      forbids(text, /\bcount\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:pseudo-locale|demo string)\b[^.!?;,]*\bas a (?:real |shipped |supported )?language\b/i) &&
      forbids(text, /\b(?:always )?check\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bfixed two-language pair\b/i),
  },
  {
    id: 'project-reference-without-company-lockin',
    holds: text =>
      /\brepository\b[\s\S]*\b(?:style book|design reference|UI reference)\b/i.test(text) &&
      !/hornhoof|\.notebook|\.side-panel|theme\.css|\b(?:Russian|English)\b/i.test(text),
  },
  {
    id: 'explicit-component-geometry-and-scrollbar-space',
    holds: text =>
      /\breset\b[\s\S]*\bexplicit\b[\s\S]*\bbrowser default\b/i.test(text) &&
      /\bscrollbar space\b[\s\S]*\bscrollable panels?\b[\s\S]*\boverlay\b/i.test(text) &&
      /\b(?:never|do not|instead of)\b[^.!?]*\bbrowser default\b/i.test(text) &&
      forbids(text, /\brely\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bbrowser default\b/i) &&
      forbids(text, /\bassum\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\boverlay scrollbars?\b/i),
  },
  {
    id: 'three-browser-engines-check',
    holds: text =>
      /\bChromium\b[\s\S]*\bFirefox\b[\s\S]*\bWebKit\b/.test(text) &&
      /\b(?:never|do not|instead of)\b[^.!?]*\b(?:single|one) browser engine\b/i.test(text) &&
      forbids(text, /\b(?:claim|count)\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:single|one) browser engine\b[^.!?;,]*\bas\b[^.!?;,]*\bcross-engine\b/i),
  },
];

type ReconciledCheckSkills = {
  tdd: string;
  policy: string;
  language: string;
  implement: string;
  browser: string;
  e2e: string;
  ciRelease: string;
};

const INCIDENT_OR_BRAND_LEAK_RE = /\b(?:hornhoof|github|david|ivan|claude|codex|kimi|antigravity)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\bv?\d+\.\d+\.\d+\b/i;

const matchesAll = (text: string, patterns: RegExp[]): boolean => patterns.every(re => re.test(text));

const forbidsAll = (text: string, patterns: RegExp[]): boolean => patterns.every(re => forbids(text, re));

const RUN_CHECKS_CORE_RULES: { id: string; holds: (text: string) => boolean }[] = [
  {
    id: 'single-regular-file-local-red-green',
    holds: text =>
      matchesAll(text, [/\bat most one\b[\s\S]*\bregular test file\b/i, /\btracked\b[\s\S]*\buntracked\b/i, /\bRED\b[\s\S]*\bGREEN\b/]) &&
      forbids(text, /\brun\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:two test files|a directory)\s+locally\b/i),
  },
  {
    id: 'heavy-stages-through-run-tests',
    holds: text =>
      matchesAll(text, [
        /"run_tests"/,
        /\bfree compatible machine\b/i,
        /\bbuilds?\b[\s\S]*\btype checks?\b[\s\S]*\blinters?\b/i,
        /\bbrowser suites?\b[\s\S]*\bcoverage\b[\s\S]*\bcrapper\b[\s\S]*\bdryer\b[\s\S]*\bmutation\b/i,
      ]),
  },
  {
    id: 'deny-local-installers-keep-manifest-edits',
    holds: text =>
      matchesAll(text, [
        /\b(?:never|do not)\b[^.!?]*\b(?:dependency install|install, add)\b[^.!?]*\blocally\b/i,
        /\bfeature dependency\b/i,
        /\bmanifest\b[\s\S]*\blockfile\b[\s\S]*\bordinary work\b/i,
      ]) && forbids(text, /\ballow\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bnpm install\s+locally\b/i),
  },
  {
    id: 'noncheck-run-work-separate-from-mixed-checks',
    holds: text =>
      matchesAll(text, [/"run_work"/, /\bnever counts as\b[^.!?]*"run_tests"[^.!?]*\bT2\b/i, /\bmix\w*\b[^.!?]*\bthrough "run_tests"/i]) &&
      forbids(text, /\bcount\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\brun_work\b[^.!?;,]*\bas\s+T2\b/i),
  },
  {
    id: 'unavailable-route-blocks-and-refusal-never-pass',
    holds: text =>
      matchesAll(text, [/"blocked"/, /\b(?:never|do not)\s+fall back\b[^.!?]*\blocally\b/i, /\brefus\w*\b[^.!?]*\bnever\b[^.!?]*\bPASS\b/]) &&
      forbidsAll(text, [/\bfall\s+back\s+to\s+running\s+heavy\s+checks\s+locally\b/i, /\btreat\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\brefusal\s+as\s+PASS\b/i]),
  },
  {
    id: 'final-stage-full-suite-and-light-screenshot',
    holds: text =>
      matchesAll(text, [/\bwhole test suite\b[^.!?]*\bfinal stage\b/i, /\blightweight\b[^.!?]*\bscreenshot\b/i, /\bbrowser executable name alone\b/i]),
  },
  {
    id: 'abstract-english-no-incident-facts',
    holds: text => text.length > 200 && !INCIDENT_OR_BRAND_LEAK_RE.test(text),
  },
];

const RECONCILED_SKILL_SOURCE_RULES: { id: string; holds: (s: ReconciledCheckSkills) => boolean }[] = [
  {
    id: 'every-skill-that-runs-checks-references-remote-route',
    holds: s =>
      forEvery([s.tdd, s.language, s.implement, s.browser, s.e2e, s.ciRelease], text => matchesAll(text, [/\brun_tests\b/, /\bhh-run-checks\b/])) && /\brun_tests\b/.test(s.policy),
  },
  {
    id: 'no-contradictory-local-heavy-directions',
    holds: s => {
      const joined = Object.values(s).join('\n');
      return (
        !/Reproduce it locally with the same command|\bcrapper and dryer are installed on your machine/i.test(joined) &&
        /\bsame pinned commit and command through `run_tests`/i.test(s.ciRelease)
      );
    },
  },
  {
    id: 'browser-suite-remote-light-screenshot-distinct',
    holds: s =>
      matchesAll(s.browser, [/\blightweight screenshot capture\b/i, /\bbrowser binary name alone\b/i]) &&
      forbids(s.browser, /\btreat\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bscreenshot capture as a full browser test suite\b/i),
  },
];

const HEAD_OUTAGE_AND_AUTHORITY_RULES: { id: string; holds: (text: string) => boolean }[] = [
  {
    id: 'outage-does-not-prolong-hold-and-lifts-at-once',
    holds: text =>
      matchesAll(text, [
        /\bexternal service failure\b[^.!?]*\bnever prolongs a general hold once the service recovers\b/i,
        /\bhold is lifted\b[^.!?]*\bat once in one pass to every affected holder\b/i,
      ]) && forbids(text, /\bkeep\w*\s+a\s+general\s+hold\s+active\s+after\s+the\s+external\s+service\s+recovers\b/i),
  },
  {
    id: 'local-error-isolated-and-orchestrator-decisions-forwarded',
    holds: text =>
      matchesAll(text, [
        /\brepeated local error\b[^.!?]*\bnever freezes unrelated work\b/i,
        /\borchestrator's authority promptly\b[^.!?]*"tell_orchestrator"[^.!?]*\binstead of holding them in your own queue\b/i,
      ]) && forbidsAll(text, [/\bfreeze\w*\s+all\s+unrelated\s+tasks\b/i, /\bhold\w*\s+orchestrator-level\s+decisions\s+in\s+your\s+own\s+queue\b/i]),
  },
  {
    id: 'abstract-head-rule-preserves-gates-and-dependencies',
    holds: text => {
      const section = text.slice(text.indexOf('External outages and holds:'));
      return (
        matchesAll(section, [/^External outages and holds:/, /\bdependencies\b[\s\S]*\bprotected actions\b[\s\S]*\baccess boundaries\b[\s\S]*\brelease gates\b/i]) &&
        !INCIDENT_OR_BRAND_LEAK_RE.test(section)
      );
    },
  },
];

const UNSHIPPED_EXTERNAL_AUTOMATION_RE = /\b(?:automatically retries|intercepts git push|blocks task creation|waits for GitHub)\b/i;

type HeadLoadSkills = { lead: string; breakDown: string };

const HEAD_LOAD_LEAK_RE = /\b(?:tiger team|simon|david|ivan|github|claude|codex|kimi|antigravity)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\b/i;
const UNSHIPPED_IDLE_WAKE_RE = /\bhornhoof\s+(?:automatically\s+)?wakes\s+you[^.!?]*\b(?:free|idle)\b/i;

const HEAD_DEPARTMENT_LOAD_RULES: { id: string; holds: (s: HeadLoadSkills) => boolean }[] = [
  {
    id: 'free-members-with-runnable-work-is-fault-and-head-owns-load',
    holds: s =>
      /\bas hh-lead-tasks says\b/.test(s.breakDown) &&
      forEvery([s.lead], text =>
        matchesAll(text, [
          /\bwhoever gives out the work answers for keeping the department loaded,\s*not only for ordering tasks\b/i,
          /\bmembers standing free while\b[^.!?]*\bare a fault,\s*not a normal wait\b/i,
        ]),
      ) &&
      forbidsAll(`${s.lead}\n${s.breakDown}`, [
        /\bstanding free\b[^.!?;,]*\bis a normal wait\b/i,
        /\bonly orders tasks\b/i,
      ]),
  },
  {
    id: 'after-chains-require-independent-part-or-none-preserving-boundaries',
    holds: s =>
      forEvery([s.lead], text =>
        matchesAll(text, [
          /`independentPart`/,
          /`independentNone`/,
          /\bsingle file ownership\b[\s\S]*\bgenuine dependenc(?:y|ies)\b[\s\S]*\brelease boundar(?:y|ies)\b/i,
          /\bpass neither when `after` is empty\b/i,
        ]),
      ) &&
      matchesAll(s.lead, [
        /\bwaits on `after` as before\b/i,
        /\bMembers standing free while department tasks wait on `after`:[\s\S]*"update_task"[\s\S]*`independentPart`[\s\S]*"create_task"/,
      ]) &&
      forbidsAll(`${s.lead}\n${s.breakDown}`, [
        /\bleave\w*\s+after\s+tasks\s+without\s+independentPart\s+or\s+independentNone\b/i,
        /\bsend\w*\s+independentNone\s+tasks\s+out\s+early\b/i,
      ]),
  },
  {
    id: 'urgent-only-team-refuses-non-urgent-and-names-free-peers',
    holds: s =>
      matchesAll(s.lead, [
        /\bNever assign ordinary or non-urgent work to members of an urgent-only team\s*\(`urgentOnly`\)/,
        /\brefuses the assignment and names free members in the same role\b/i,
      ]) &&
      forbids(`${s.lead}\n${s.breakDown}`, /\bassign\w*\s+(?:ordinary\s+(?:or\s+)?)?non-urgent\s+work\s+to\s+(?:members\s+of\s+)?an\s+urgent(?:-only|Only)\s+team\b/i),
  },
  {
    id: 'abstract-no-incident-names-or-unshipped-idle-wake',
    holds: s => {
      const joined = `${s.lead}\n${s.breakDown}`;
      return !HEAD_LOAD_LEAK_RE.test(joined) && !UNSHIPPED_IDLE_WAKE_RE.test(joined) && s.lead.split('External outages and holds:').length - 1 === 1;
    },
  },
];

/* The orchestrator leads by the skill every head leads by, which holds the one rule for holds, and his own skill for trouble
   adds what only he decides. */
type OrchestratorOutageSkills = { lead: string; trouble: string };

const ORCHESTRATOR_OUTAGE_RULES: { id: string; holds: (s: OrchestratorOutageSkills) => boolean }[] = [
  {
    id: 'outage-not-grounds-for-longer-general-hold',
    holds: ({ lead, trouble }) =>
      matchesAll(lead, [/\bexternal service failure\b[^.!?]*\bnever prolongs a general hold once the service recovers\b/i]) &&
      matchesAll(trouble, [/\brule for holds is in hh-lead-tasks\b/i]) &&
      forbids(`${lead}\n${trouble}`, /\bkeep\w*\s+a\s+general\s+hold\s+active\s+after\s+the\s+external\s+service\s+recovers\b/i),
  },
  {
    id: 'orchestrator-decides-and-communicates-in-one-action',
    holds: ({ trouble: text }) =>
      matchesAll(text, [
        /\bdecide\b[^.!?]*\byourself\b[^.!?]*\bcommunicate\b[^.!?]*\bat once in one action to every affected holder\b/i,
        /\bnever\b[^.!?]*\bdepartment head's queue\b/i,
      ]) && forbids(text, /\bsend\w*[^.!?;,]*\bthrough a department head's queue\b/i),
  },
  {
    id: 'ordinary-retry-needs-no-permission-or-diagnosis-chain',
    holds: ({ trouble: text }) =>
      matchesAll(text, [
        /\bsame internal fix fails a second time\b/i,
        /\btransient external service failure\b[^.!?]*\bneeds no diagnosis task\b/i,
        /\bagent needs no permission for an ordinary retry of a transient external failure\b/i,
      ]) &&
      forbidsAll(text, [
        /\brequire\w*\s+permission\s+before\s+any\s+ordinary\s+retry\b/i,
        /\bone attempt\b/i,
        /\bno retries\b/i,
        /\bdeclare recovery\b/i,
      ]),
  },
  {
    id: 'abstract-orchestrator-rule-preserves-safety-without-unshipped-promises',
    holds: ({ trouble: text }) => {
      const idx = text.indexOf('External outages and holds:');
      if (idx === -1) return false;
      const section = text.slice(idx);
      return (
        matchesAll(section, [
          /^External outages and holds:/,
          /\bforce pushes\b[\s\S]*\balternate refs\b[\s\S]*\bpermission changes\b[\s\S]*\birreversible actions\b[\s\S]*\bdangerous or non-idempotent actions\b/i,
        ]) &&
        !INCIDENT_OR_BRAND_LEAK_RE.test(section) &&
        !/\b\d{1,2}\.\d{1,2}\b/.test(section) &&
        !UNSHIPPED_EXTERNAL_AUTOMATION_RE.test(text)
      );
    },
  },
];

const forEvery = <Item>(items: Item[], predicate: (item: Item) => boolean): boolean => items.every(predicate);

const failedRuleIds = <Input>(rules: { id: string; holds: (input: Input) => boolean }[], input: Input): string[] =>
  rules.filter(rule => !rule.holds(input)).map(rule => rule.id);

type MechanicalSkills = { diff: string; verdict: string };

const documentedCategories = (text: string): string[] => {
  const clause = /category(?:\s*:\s*[^,)]+|\s*\([^)]+\))/.exec(text)![0];
  return [...clause.matchAll(/['`]([a-z_]+)['`]/g)].map(m => m[1]!);
};

const sampleFinding = (category: 'security' | 'data' | 'spec' | 'other' | 'mechanical', blocking: boolean) => ({
  taskId: '11111111-1111-4111-8111-111111111111',
  findingId: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  reviewedCommit: 'a'.repeat(40),
  authorId: '44444444-4444-4444-8444-444444444444',
  reviewerId: '55555555-5555-4555-8555-555555555555',
  reviewerVendor: 'anthropic',
  category,
  blocking,
  path: 'src/index.ts',
  line: 10,
  harm: 'Wrong behaviour.',
});

const MECHANICAL_CATEGORY_RULES: { id: string; holds: (s: MechanicalSkills) => boolean }[] = [
  {
    id: 'strict-behavior-unchanged-boundary',
    holds: s =>
      forEvery([s.verdict], text =>
        matchesAll(text, [
          /\bprovably cannot change\b[^.!?]*\bbehaviour\b/i,
          /\bformatting\b[\s\S]*\blint\b[\s\S]*\bsafe local rename\b[\s\S]*\bmissing translation key\b/i,
          /\bpublic API\b[\s\S]*\bsemantics\b/i,
        ]),
      ) &&
      forbidsAll(`${s.diff}\n${s.verdict}`, [
        /\bclassify\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:public API rename|semantic change)\b[^.!?;,]*\bas\s+['`]?mechanical['`]?/i,
        /\buse\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b['`]?mechanical['`]?\b[^.!?;,]*\bwhen\s+a\s+fix\s+may\s+change\s+behaviour\b/i,
      ]),
  },
  {
    id: 'doubt-keeps-regular-category-and-full-base-level',
    holds: s =>
      forEvery([s.verdict], text =>
        matchesAll(text, [
          /\bwhen in doubt\b[^.!?]*\bregular category\b[\s\S]*\bfull base level\b/i,
          /\b(?:never|do not)\s+classify\b[^.!?]*\bsecurity\b[\s\S]*\bdata\b[\s\S]*\bspec\b[\s\S]*\bmechanical\b[^.!?]*\bmedium\b/i,
        ]),
      ) &&
      sentencesOf(`${s.diff}\n${s.verdict}`).every(sentence =>
        negatesBefore(sentence, /\bwhen in doubt,\s*(?:mark|classify|use)\w*\b[^.!?]*\b['`]?mechanical['`]?/i),
      ) &&
      forbidsAll(`${s.diff}\n${s.verdict}`, [
        /\bclassify\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\b(?:security|data|spec)\b[^.!?;,]*\bas\s+['`]?mechanical['`]?\s+to\s+run\s+at\s+medium\b/i,
      ]),
  },
  {
    id: 'server-aggregate-wake-mechanical-and-no-second-review',
    holds: s =>
      forEvery([s.verdict], text =>
        matchesAll(text, [
          /\bWake\.mechanical\b/,
          /\bevery\b[^.!?]*\bissue\b[\s\S]*\bfailing verdicts?\b[\s\S]*\bmechanical\b/i,
          /\bmixed\b[^.!?]*\bunmarked\b/i,
          /\b(?:never|does not)\s+set\w*\s+effort\b[\s\S]*\b(?:never|does not)\s+change\w*\s+effort\s+inside\s+a\s+running\s+turn\b[\s\S]*\b(?:never|does not)\s+open\w*\s+a\s+second\s+review\b/i,
        ]),
      ) &&
      sentencesOf(`${s.diff}\n${s.verdict}`).every(sentence =>
        negatesBefore(sentence, /\bset\w*\s+['`]?Wake\.mechanical['`]?\s+on\s+mixed\s+verdicts?\b/i),
      ) &&
      forbidsAll(`${s.diff}\n${s.verdict}`, [
        /\bswitch\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\beffort\s+inside\s+a\s+running\s+turn\b/i,
        /\bopen\w*\b(?:(?!\b(?:without|instead of)\b)[^.!?;,])*\bsecond\s+review\s+for\s+['`]?mechanical['`]?\s+findings\b/i,
      ]),
  },
  {
    id: 'abstract-english-no-incident-or-company-leaks',
    holds: s => !/\b(?:hornhoof|github|david|ivan|Russian|English)\b|#\d{2,}|\b202\d-\d{2}-\d{2}\b|\bv?\d+\.\d+\.\d+\b|[\u2014\u0451\u0401]/i.test(`${s.diff}\n${s.verdict}`),
  },
];

const themeDeclarations = (css: string, selector: string): Record<string, string> => {
  const start = css.indexOf('{', css.indexOf(selector)) + 1;
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim().replace(/\s+/g, ' ')]));
};

const styleBookSources = (book: string): string[] => [
  ...[...book.matchAll(/`((?:ui|screens)\/[\w./-]+\.tsx?)`/g)].map(m => `apps/web/src/${m[1]!}`),
  ...[...book.matchAll(/`((?:apps|templates|guide|\.github)\/[\w./-]+\.\w+)`/g)].map(m => m[1]!),
  ...[...book.matchAll(/`([A-Z_]+\.md)`/g)].map(m => m[1]!),
];

describe('outbound and support gateway templates', () => {
  it('routes sales, marketing and support skills through the server-checked outbound gateway and department owner', () => {
    const sal = templates.skills.get('sal-outbound-approval')?.body ?? '';
    const mkt = templates.skills.get('mkt-publish-approval')?.body ?? '';
    const sup = templates.skills.get('sup-support-policy')?.body ?? '';

    for (const [id, body] of [
      ['sal-outbound-approval', sal],
      ['mkt-publish-approval', mkt],
      ['sup-support-policy', sup],
    ] as const) {
      expect(body, id).not.toMatch(INCIDENT_OR_BRAND_LEAK_RE);
      expect(body, id).not.toMatch(/[\u0451\u0401\u2014]/);
      expect(body, id).toMatch(/\bserver\b[\s\S]*\bcatalog\b/i);
      expect(body, id).toMatch(/\bdepartment owner\b[\s\S]*\bCEO\b/i);
      expect(body, id).toMatch(/\b(?:credentials?|keys?|passwords?)\b[^.!?]*\b(?:stay|remain|kept)\b[^.!?]*\bserver\b/i);
    }

    expect(sal).toMatch(/"outbound_submit"/);
    expect(sal).toMatch(/"outbound_status"/);
    expect(sal).toMatch(/\bunknown\b[^.!?]*\b(?:receiver|receiving|resend)\b/i);
    expect(mkt).toMatch(/"outbound_submit"/);
    expect(mkt).toMatch(/\bpublic\b[^.!?]*\b(?:every|each|per-item)\b[^.!?]*\bapproval\b/i);
    expect(sup).toMatch(/"support_classify"/);
    expect(sup).toMatch(/"support_submit"/);
    expect(sup).toMatch(/\buntrusted data\b/i);
    expect(sup).toMatch(/\b(?:never|do not)\b[^.!?]*\b(?:refund|price|legal|contract|delivery[- ]date)\b/i);
  });

  it('aligns all four support role templates with separate classification, catalog replies, and owner escalation', () => {
    expect(templates.roles.get('SUP-T2')?.effort).toBe('high');
    for (const id of ['SUP-HEAD', 'SUP-KB', 'SUP-T1', 'SUP-T2'] as const) {
      const role = templates.roles.get(id)!;
      expect(role, id).toBeDefined();
      expect(role.body.length, id).toBeLessThanOrEqual(600);
      expect(role.body, id).not.toMatch(INCIDENT_OR_BRAND_LEAK_RE);
      expect(role.body, id).not.toMatch(/[\u0451\u0401\u2014]/);
    }

    expect(templates.roles.get('SUP-T1')!.body).toMatch(/"support_classify"/);
    expect(templates.roles.get('SUP-T1')!.body).toMatch(/"support_submit"/);
    expect(templates.roles.get('SUP-T2')!.body).toMatch(/"support_classify"/);
    expect(templates.roles.get('SUP-T2')!.body).toMatch(/\bdepartment owner\b/i);
    expect(templates.roles.get('SUP-KB')!.body).toMatch(/\bcatalog\b/i);
    expect(templates.roles.get('SUP-HEAD')!.body).toMatch(/\bdepartment owner\b/i);
  });
});

type ImpactSelectionSkills = { implement: string; policy: string; agents: string };

const IMPACT_SELECTION_RULES: { id: string; holds: (s: ImpactSelectionSkills) => boolean }[] = [
  {
    id: 'author-dependent-tests-via-run-tests-and-new-tests-always',
    holds: s =>
      forEvery([s.implement, s.policy], text => matchesAll(text, [/\brun_tests\b/, /\b(?:dependent|selected|affected)\s+tests?\b/i])) &&
      matchesAll(s.implement, [/\bT2\b[^.!?]*\bdev-testing-policy\b/]) &&
      matchesAll(s.policy, [
        /\bnew(?:ly\s+added)?\s+test\b[\s\S]*\balways\b|\balways\b[\s\S]*\bnew(?:ly\s+added)?\s+test\b/i,
        /\bselector input\b[\s\S]*\bselected inventory\b[\s\S]*\bfallback reasons?\b/i,
        /\brun\b[\s\S]*\bpart\b[\s\S]*\bcommit\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\bskip\w*\s+new(?:ly\s+added)?\s+tests?\s+when\s+no\s+graph\s+edge\s+reaches\s+them\b/i,
      ]),
  },
  {
    id: 'outside-graph-uncertain-whole-package-and-migrations-up-down',
    holds: s =>
      matchesAll(s.policy, [
        /\bmigrations\b[\s\S]*\bschema\b[\s\S]*\bconfiguration\b[\s\S]*\benvironment\b[\s\S]*\broutes\b[\s\S]*\bfixtures\b[\s\S]*\bstring tables\b[\s\S]*\bscripts\b[\s\S]*\binstallation\b[\s\S]*\bupdates\b[\s\S]*\bshared packages\b[\s\S]*\bAPI contracts\b[\s\S]*\btemplates\b/i,
        /\boutside\s+import\s+graphs?\b/i,
        /\bcomplete\s+affected\s+packages?\b/i,
        /\bup and down\b/i,
        /\bunsupported\b[^.!?]*\breport\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\btreat\w*\s+an\s+unavailable\s+adapter\s+as\s+an\s+empty\s+selection\b/i,
        /\brun\w*\s+migrations?\s+up\s+only\s+without\s+reporting\b/i,
      ]),
  },
  {
    id: 'explicit-selector-commands-no-auto-promise-and-execution-distinct',
    holds: s =>
      matchesAll(s.agents, [
        /scripts\/test\/impact-README\.md/,
        /scripts\/test\/related-probe\.mjs/,
        /scripts\/test\/impact-python\/pytest_impact\.py/,
        /scripts\/test\/replay-impact\.mjs/,
        /\bNOT_RUN\b/,
      ]) &&
      matchesAll(s.policy, [
        /\bNOT_RUN\b/,
        /\bcollected graph\b[\s\S]*\bcompleted\b[^.!?]*\breceipts?\b/i,
        /\bunavailable\b[^.!?]*\bnot\s+zero\s+misses\b/i,
        /\btest engineer\b/i,
        /\bnever assume `run_tests` selects by itself\b/i,
      ]) &&
      forbidsAll(`${s.implement}\n${s.policy}`, [
        /\brun_tests\s+automatically\s+selects\s+impact\s+tests\s+from\s+the\s+test\s+environment\b/i,
        /\btreat\w*\s+a\s+collected\s+graph\s+as\s+completed\s+test\s+execution\b/i,
        /\btreat\w*\s+missing\s+comparator\s+evidence\s+as\s+zero\s+misses\b/i,
      ]),
  },
  {
    id: 'abstract-english-no-dates-names-or-numbers',
    holds: s => {
      const t2 = s.policy.split('\n').find(line => line.startsWith('- T2.')) ?? '';
      return !/\b(?:david|ivan|simon|Russian|English)\b|\bturn\s+7\b|#\d+|\b202\d-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\b|\bv?\d+\.\d+\.\d+\b|scripts\/test|[—ёЁ]/i.test(`${s.implement}\n${t2}`);
    },
  },
];

describe('T2 impact-selection rules across dev-implement, dev-testing-policy and the project rules', () => {
  const impactSkills = (): ImpactSelectionSkills => ({
    implement: templates.skills.get('dev-implement')!.body,
    policy: templates.skills.get('dev-testing-policy')!.body,
    agents: readFileSync(join(DIR, '../AGENTS.md'), 'utf8'),
  });

  it('teaches explicit impact selection, whole-package fallbacks, bidirectional migrations, execution vs collection evidence, and explicit scripts/test commands without promising unshipped runner wiring', () => {
    expect(failedRuleIds(IMPACT_SELECTION_RULES, impactSkills())).toEqual([]);
  });

  it('rejects skill text that promises unshipped automatic runner selection, conflates graph collection with execution, skips new tests, or leaks dates, names or task numbers', () => {
    const base = impactSkills();
    expect(failedRuleIds(IMPACT_SELECTION_RULES, base)).toEqual([]);
    const cases: [keyof ImpactSelectionSkills, string, string][] = [
      ['implement', 'Skip newly added tests when no graph edge reaches them.', 'author-dependent-tests-via-run-tests-and-new-tests-always'],
      ['policy', 'Treat an unavailable adapter as an empty selection and run migrations up only without reporting.', 'outside-graph-uncertain-whole-package-and-migrations-up-down'],
      ['policy', 'Today run_tests automatically selects impact tests from the test environment.', 'explicit-selector-commands-no-auto-promise-and-execution-distinct'],
      ['policy', 'Treat a collected graph as completed test execution and treat missing comparator evidence as zero misses.', 'explicit-selector-commands-no-auto-promise-and-execution-distinct'],
      ['implement', 'Added by David on 2026-11-06 for #309 against turn 7.', 'abstract-english-no-dates-names-or-numbers'],
    ];
    for (const [target, extra, expectedRule] of cases) {
      expect(failedRuleIds(IMPACT_SELECTION_RULES, { ...base, [target]: `${base[target]}\n${extra}` }), extra).toContain(expectedRule);
    }
  });
});

describe('skills are independent cubes: any can be on for any role and together they do not disagree', () => {
  const REVIEW_CHECKS = ['dev-review-diff', 'dev-security-review'];
  const text = (x: { title: { en: string }; description: { en: string }; body: string }) => `${x.title.en}\n${x.description.en}\n${x.body}`;
  const skill = (id: string) => templates.skills.get(id)!;

  it.each(REVIEW_CHECKS)('words %s for your own change and for someone else alike', id => {
    const check = skill(id);
    expect(check.body).toMatch(/same for your own change and for someone else's/);
    expect(check.description.en).toMatch(/your own or someone else's/);
    expect(check.body).toMatch(/On your own change, read the diff cold/);
    expect(check.body).toMatch(/On your own change, fix what blocks[\s\S]*your own review replaces no gate/);
    expect(check.body).toMatch(/On someone else's change at a gate, give the verdict with dev-review-verdict/);
    /* A generalist turns this on for its own code: no sentence may say the reader did not write what it reads. */
    expect(text(check)).not.toMatch(/you did not write|did not author|never approve|never (?:change|fix|edit) the code|code of (?:others|another)|another (?:author|developer)'s|the author's (?:code|change|work)/i);
  });

  it.each(REVIEW_CHECKS)('keeps the verdict and everything a gate adds out of the %s check', id => {
    const checkOnly = skill(id).body.split('**What comes next.**')[0]!;
    expect(checkOnly.length).toBeGreaterThan(500);
    expect(checkOnly).not.toMatch(/\bverdict\b|\bAPPROVE\b|CHANGES_REQUESTED|task\.reviewPlan|task\.fixReview|\bfindingIds?\b|reviewedCommit|Wake\.mechanical|\bcategory\b/);
  });

  it('keeps what a gate adds in its own skill, which says when it applies', () => {
    const verdict = skill('dev-review-verdict');
    expect(verdict.kind).toBe('gate');
    expect(verdict.body).toMatch(/applies only when you judge someone else's change/);
    expect(verdict.body).toMatch(/you never approve your own work/);
    for (const id of ['DEV-REV', 'DEV-SEC']) expect(templates.roles.get(id)!.skills.find(k => k.id === 'dev-review-verdict')?.on, id).toBe(true);
  });

  it('describes mutator in one place', () => {
    const named = [...roles, ...skills].filter(x => /\bmutator\b|\bsurvivors?\b/i.test(text(x))).map(x => x.id).sort();
    /* ub-mode is copied word for word; how a company runs it is T4 alone. */
    expect(named).toEqual(['dev-engineering-rules', 'dev-testing-policy']);
    const lines = skill('dev-testing-policy').body.split('\n');
    expect(lines.filter(line => /\bmutator\b/.test(line)).map(line => line.slice(0, 4))).toEqual(['- T4']);
    expect(lines.filter(line => /\b[Ss]urvivors?\b/.test(line)).map(line => line.slice(0, 4))).toEqual(['- T4']);
  });

  it('keeps each testing rule in the policy, with other skills pointing to it', () => {
    const repeats = /\bCRAP (?:above|under|of|at) ?\d|\b0\.8 or more\b|\bcompile_error\b|\bzero tests fails\b/;
    for (const x of [...roles, ...skills]) {
      if (x.id !== 'dev-testing-policy') expect(x.body, x.id).not.toMatch(repeats);
    }
    expect(skill('dev-testing-policy').body).toMatch(/one place that says who runs which check and when/);
  });

  it('gives the generalist developer role both titles and every skill it needs, loaded on its card', () => {
    const role = templates.roles.get('DEV-GEN')!;
    expect(role.title).toEqual({ en: 'Generalist developer', ru: 'Разработчик-универсал' });
    expect(role.kind).toBe('member');
    expect(role.department).toBe('development');
    expect(templates.roster('development').find(r => r.id === 'DEV-GEN')?.inDefault).toBe(false);
    const on = role.skills.filter(k => k.on).map(k => k.id);
    const needed = ['dev-engineering-rules', 'dev-testing-policy', 'dev-gates', 'dev-language-rules', 'dev-write-plan', 'dev-implement', 'dev-tdd', 'dev-worktrees', 'dev-migrations', 'dev-debugging', 'dev-frontend-ui', 'dev-browser-check', 'dev-test-gaps', 'dev-review-diff', 'dev-security-review', 'dev-cleanup', 'hh-work-fast'];
    for (const id of needed) expect(on, id).toContain(id);
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Gene', roleKey: role.id, skills: on, overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    expect(Buffer.byteLength(rendered.text)).toBeLessThan(24_000);
    expect(rendered.text).toContain(role.body);
    const files = new Map(rendered.skills.map(s => [s.name, s.body]));
    for (const id of on) {
      if (skill(id).kind === 'core') expect(rendered.text, id).toContain(skill(id).body);
      else expect(files.get(id), id).toContain(skill(id).body);
    }
    for (const step of ['plan', 'code', 'tests', 'own review', 'security', 'browser', 'cleanup', 'report']) expect(role.body, step).toContain(step);
    /* Urgency is not part of this role. */
    expect(`${text(role)}\n${role.description.ru}`).not.toMatch(/urgent|hotfix|срочн/i);
    expect(role.skills.find(k => k.id === 'dev-review-verdict')?.on).toBe(false);
  });

  it('asks for a browser only for a web page, on the generalist, in the check itself and at the final check', () => {
    const role = templates.roles.get('DEV-GEN')!;
    /* A skill on a card is read before the step it covers, so the role must not make that step part of every task. */
    expect(role.body).toMatch(/When the change has something a user meets[^.]*dev-browser-check[^.]*a browser only for a web page/);
    expect(role.body).not.toMatch(/a check in the browser/);
    expect(role.description.en).toMatch(/a browser only for a web page/);
    expect(role.description.ru).toMatch(/браузер только для веб-страницы/);
    const check = skill('dev-browser-check');
    expect(check.description.en).toMatch(/a browser only for a web page/);
    expect(check.body).toMatch(/A change nothing reaches that way has no run to do here: its tests are the check/);
    expect(check.body).toMatch(/^4\. On a screen, check every theme/m);
    expect(skill('dev-testing-policy').body).toMatch(/browser engines where the product has a web interface/);
    for (const id of ['DEV-TEST', 'DEV-QA']) expect(templates.roles.get(id)!.body, id).toMatch(/what the product has of browser engines/);
  });

  it('binds the generalist to no language, stack or kind of product', () => {
    const role = templates.roles.get('DEV-GEN')!;
    const stack = /\b(?:npm|npx|node_modules|JavaScript|TypeScript|Python|pytest|Rust|cargo|Java|Clojure|Golang|React|Vite|Vitest|ESLint|Postgres\w*|SQL|Docker|Linux|macOS|Windows|[Ff]rontend|[Bb]ackend|English|Russian)\b/;
    expect(text(role)).not.toMatch(stack);
    /* These two name tools only as examples across languages, or for one kind of project they name first. */
    const examples = new Set(['dev-language-rules', 'dev-testing-policy']);
    for (const k of role.skills.filter(s => s.on && !examples.has(s.id))) expect(text(skill(k.id)), k.id).not.toMatch(stack);
    const setup = skill('dev-language-rules').body.split('\n').find(line => line.startsWith('4.'))!;
    expect(setup.split('In an npm project:')[0]).not.toMatch(/npm|npx|node_modules|JavaScript|ESLint|Vitest|Playwright/);
    expect(setup).toContain('In an npm project:');
    expect(skill('dev-language-rules').body).toMatch(/For a language without a folder, say so in your report/);
    const selection = skill('dev-testing-policy').body.split('\n').find(line => line.startsWith('- T2.'))!;
    for (const runner of ['vitest related', 'pytest --testmon', 'go test', 'cargo test -p']) expect(selection, runner).toContain(runner);
    expect(skill('dev-testing-policy').body).toMatch(/A language they do not support stays `NOT_RUN`/);
    expect(skill('dev-testing-policy').body).toMatch(/real database and live program checks where the product has them/);
    expect(skill('dev-frontend-ui').body).toMatch(/On the web, reset browser default/);
    expect(skill('dev-frontend-ui').body).toMatch(/on the web, logical CSS properties/);
    expect(skill('dev-security-review').body).toMatch(/check what the change touches of this list/);
  });

  it('names no language of people outside the cubes made for one market, and those stay off by default', () => {
    const market = new Set(['mkt-russian-copy', 'mkt-telegram-vk', 'mkt-yandex-seo']);
    for (const x of [...roles, ...skills]) if (!market.has(x.id)) expect(text(x), x.id).not.toMatch(/\b(?:English|Russian)\b|\bboth languages\b/);
    for (const role of roles) for (const id of market) expect(role.skills.find(k => k.id === id)?.on ?? false, `${role.id} ${id}`).toBe(false);
  });

  it('closes references: a skill or role on a card names only what that card can read', () => {
    const named = /\b(?:dev|dsn|fin|sup|ops|sal|mkt|biz|home|hh|orch)-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
    const dangling: string[] = [];
    for (const role of roles) {
      const known = new Set(role.skills.map(k => k.id));
      const look = (from: string, body: string) => {
        for (const ref of new Set(body.match(named) ?? [])) if (templates.skills.has(ref) && !known.has(ref)) dangling.push(`${role.id}: ${from} names ${ref}`);
      };
      look('its body', role.body);
      /* A department's map names its members' skills, which its head does not carry. */
      for (const k of role.skills) if (k.on && !k.id.endsWith('-work-pipeline')) look(k.id, skill(k.id).body);
    }
    expect(dangling).toEqual([]);
  });

  it('tells a reader what to do when a named skill is not on its list', () => {
    const role = templates.roles.get('DEV-TEST')!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Tess', roleKey: role.id, skills: role.skills.filter(k => k.on).map(k => k.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    expect(rendered.text).toContain('when that one is not on your list, go on without it.');
  });

  it('gives every role the speed skill, which covers all six savings and never trades away a check', () => {
    const fast = skill('hh-work-fast');
    for (const role of roles) expect(role.skills.find(k => k.id === 'hh-work-fast')?.on, role.id).toBe(true);
    for (const saving of ['A small step, not a big plan', 'Read only what the step needs', 'Do not prove it twice', 'A short report', 'Do not wait without a reason', 'Effort by size']) expect(fast.body, saving).toContain(saving);
    expect(fast.body).toMatch(/the check and the approval win/);
    expect(fast.body).toMatch(/passed on this exact commit or version stands/);
    /* Reading less must not argue with reading a skill or a check's output whole. */
    expect(fast.body).toMatch(/A skill you follow and the output of a check are read whole/);
    expect(text(fast)).not.toMatch(/\bdev-|\bhead of\b|\bdeveloper\b|\breviewer\b|\b\d+\s*(?:%|minutes?|hours?|days?)\b/i);
    expect(fast.kind).not.toBe('core');
  });

  it('names no person, task, turn, date or version in any role or skill', () => {
    const leak = /\b(?:david|ivan|simon|morpheus|trinity|lisa|liza)\b|(?:^|\s)#\d{2,}\b|\b202\d-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.20\d\d\b|\bturn\s+\d+\b|\bv\d+\.\d+\.\d+\b/i;
    for (const x of [...roles, ...skills]) expect(text(x), x.id).not.toMatch(leak);
  });

  it('keeps ordinary units of time out of the rules of the turn', () => {
    const body = (id: string) => skill(id).body;
    for (const id of ['dev-gates', 'dev-testing-policy', 'dev-work-pipeline', 'hh-lead-tasks']) {
      const withoutToolLimit = body(id).replace(/an ISO deadline within two hours/g, '');
      expect(withoutToolLimit, id).not.toMatch(/\b\d+\s+(?:minutes?|hours?|days?|weeks?)\b|\b(?:two|three|four) (?:hours|days|weeks)\b|\bper week\b|\bevery day\b/i);
    }
    expect(body('dev-gates')).toMatch(/never units of time/);
    /* How often a role wakes belongs to its timer, which a company can change. */
    for (const role of roles) expect(`${text(role)}\n${role.description.ru}`, role.id).not.toMatch(/every few hours|несколько часов/i);
  });

  it('keeps the four gates of a turn in order, with review and testing once per turn', () => {
    const gates = skill('dev-gates').body;
    const order = ['## Development', '## Review', '## Testing', '## Release'].map(title => gates.indexOf(title));
    expect(order.every(at => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(gates).toMatch(/One review per turn/);
    expect(gates).toMatch(/Once per turn, with the turn's branch frozen/);
    expect(gates).toMatch(/machines one at a time/);
    expect(gates).toMatch(/Architects of different models each propose a solution on their own and write no code/);
    expect(gates).toMatch(/the head, as arbiter, picks one or merges them/);
    expect(gates).toMatch(/run in the background and hold nobody/);
  });

  it('lets a tester fix a flaky or outdated test and an obvious trifle while logic goes to its author', () => {
    const policy = skill('dev-testing-policy').body;
    expect(policy).toMatch(/flaw in logic goes back to its author as a task/);
    expect(policy).toMatch(/fixes a flaky or outdated test or an obvious trifle itself, in a separate commit/);
    for (const id of ['DEV-TEST', 'DEV-QA']) expect(templates.roles.get(id)!.body, id).toMatch(/fix a flaky or outdated test or an obvious trifle yourself in a separate commit/);
  });
});

describe('a role is a short line and bricks: what every head and the orchestrator share is one skill, and what a department knows is its own', () => {
  const body = (id: string) => templates.skills.get(id)!.body;
  const PLACE = { company: 'Acme', department: 'Work', product: null };
  const rendered = (role: (typeof roles)[number], skills = role.skills.filter(s => s.on).map(s => s.id)) =>
    renderInstructions(templates, { id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: 'Bruno', roleKey: role.id, skills, overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], PLACE);
  const heads = roles.filter(r => r.kind === 'head');
  const marker = (id: string) => `<!-- hh:skill ${id} -->`;
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  /* The rules every head and the orchestrator lead by, each said once. */
  const LEADING = [
    'whoever gives out the work answers for keeping the department loaded',
    'Members standing free while work in the department can run are a fault',
    'one member owns each connected block end to end',
    'Give small work to the member already working in that area',
    'To reach someone, write to them with "message_employee"',
    'A report that claims success without evidence is treated as not done',
    'only what only they can decide, as one clear question',
    'An external service failure never prolongs a general hold once the service recovers',
  ];
  /* What only development knows: code, its branches and commits, its tests and its developers. */
  const CODE = /\b(?:code|branch(?:es)?|commits?|SHA|merge[sd]?|repositor(?:y|ies)|failing tests?|affected tests|developers?|architects?|security review)\b/i;

  it('gives every head and the orchestrator the one skill of leading, whole and once, whatever its card holds', () => {
    expect(HEAD_SKILLS).toContain('hh-lead-tasks');
    expect(ORCHESTRATOR_SKILLS).toContain('hh-lead-tasks');
    expect(templates.skills.get('hh-lead-tasks')!.kind).toBe('core');
    for (const role of heads) {
      for (const skills of [role.skills.filter(s => s.on).map(s => s.id), []]) {
        const { text } = rendered(role, skills);
        expect(count(text, marker('hh-lead-tasks')), role.id).toBe(1);
        expect(text, role.id).toContain(body('hh-lead-tasks'));
      }
    }
    const steady = orchestratorSteady(templates);
    expect(count(steady.text, marker('hh-lead-tasks'))).toBe(1);
    expect(steady.text).toContain(body('hh-lead-tasks'));
  });

  it('says each rule of leading in that skill alone, and no other skill or role says it again', () => {
    for (const rule of LEADING) {
      expect(body('hh-lead-tasks'), rule).toContain(rule);
      for (const x of [...roles, ...skills].filter(x => x.id !== 'hh-lead-tasks')) expect(x.body, `${x.id}: ${rule}`).not.toContain(rule);
      expect(ORCHESTRATOR_INSTRUCTIONS, rule).not.toContain(rule);
    }
  });

  it('keeps development out of the skills every head, member and the orchestrator shares, and in the bricks development connects', () => {
    const shared = ['hh-hornhoof', 'hh-tasks', 'hh-lead-tasks', 'hh-head', 'hh-notebook', 'hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop', 'hh-task-flow', 'hh-report-to-head'];
    /* Claude Code is a program the agent may run in, not code it works on. */
    for (const id of shared) expect(body(id).replaceAll('Claude Code', ''), id).not.toMatch(CODE);
    expect(body('dev-lead')).toMatch(/one generalist developer/);
    expect(body('dev-lead')).toMatch(/access, root, secrets or permissions[^.]*security review of its own before it merges/);
    expect(body('dev-lead')).toMatch(/exact 40-character commit/);
    expect(body('dev-task-flow')).toMatch(/branch named after the task[\s\S]*Never commit to the main branch/);
    for (const role of roles) {
      const on = (id: string) => role.skills.find(k => k.id === id)?.on ?? false;
      expect(on('dev-lead'), role.id).toBe(role.id === 'DEV-HEAD');
      if (role.department === 'development' && role.kind === 'member') expect(on('dev-task-flow'), role.id).toBe(true);
      if (!['development', 'operations'].includes(role.department)) expect(on('dev-task-flow'), role.id).toBe(false);
    }
    expect(ORCHESTRATOR_SKILLS).toContain('dev-lead');
    expect(orchestratorSteady(templates).skills.map(f => f.name)).toContain('dev-lead');
  });

  it('gives a head of any department the shared bricks and its own department, so a department changes by its bricks alone', () => {
    const departmentOf = (id: string) => /^([a-z]+)-/.exec(id)![1]!;
    const prefixes: Record<string, string> = { operations: 'ops', development: 'dev', design: 'dsn', marketing: 'mkt', sales: 'sal', business_development: 'biz', support: 'sup', finance: 'fin', home_devices: 'home', household: 'home' };
    for (const role of heads) {
      const ids = role.skills.filter(s => s.on).map(s => s.id);
      for (const id of [...CORE_SKILLS, ...HEAD_SKILLS]) expect(ids, `${role.id} ${id}`).toContain(id);
      /* Beyond what every head shares, a head holds its own department's bricks, and Operations a check environment. */
      const own = ids.filter(id => !id.startsWith('hh-'));
      for (const id of own) expect([prefixes[role.department], ...(role.id === 'OPS-HEAD' ? ['dev'] : [])], `${role.id} ${id}`).toContain(departmentOf(id));
    }
  });

  it('starts every role with one line that says who it is, and every rule it follows comes from a brick', () => {
    for (const role of roles) {
      const { parts } = rendered(role);
      expect(parts[0]!.kind, role.id).toBe('header');
      expect(parts[0]!.text, role.id).toBe(`You are Bruno, the ${role.title.en} of the Work department at Acme.`);
      expect(parts.slice(2).every(p => p.kind === 'skill'), role.id).toBe(true);
      for (const id of ['hh-hornhoof', 'hh-tasks', 'hh-superpowers']) expect(parts.some(p => p.id === id), `${role.id} ${id}`).toBe(true);
      if (role.kind === 'head') for (const id of ['hh-head', 'hh-notebook']) expect(parts.some(p => p.id === id), `${role.id} ${id}`).toBe(true);
    }
  });

  it('keeps the standing role of the orchestrator to who he is, much shorter than the prompt it replaces, with how he works in his skills', () => {
    /* The standing role it replaces was 9,973 characters of numbered steps. */
    expect(ORCHESTRATOR_INSTRUCTIONS.length).toBeLessThan(9_973);
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/^\d+\. /m);
    expect(ORCHESTRATOR_INSTRUCTIONS).toMatch(/^You are the Orchestrator of a company that runs in Hornhoof/);
    const steady = orchestratorSteady(templates);
    expect(steady.parts.map(p => p.kind)).toEqual(['base', ...ORCHESTRATOR_SKILLS.map(() => 'skill')]);
    for (const id of ['orch-company', 'hh-notebook', 'hh-hornhoof']) expect(steady.text, id).toContain(body(id));
  });
});
