import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY_TEMPLATES, MAX_INSTRUCTIONS, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ORCHESTRATOR_SKILLS, orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { NOTEBOOK_MAX, NOTES_MAX } from '../src/modules/notebook/book.js';
import { CORE_SKILLS, HEAD_SKILLS, loadTemplates, MEMBER_SKILLS } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];

describe('templates', () => {
  it('teaches every department head not to repeat a task report in a separate message', () => {
    for (const role of roles.filter(r => r.kind === 'head')) {
      const instructions = renderInstructions(templates, { id: 'a', companyId: 'c', kind: 'head', name: 'Hana', roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });
      expect(instructions.text, role.id).toContain('Do not send the orchestrator a separate message repeating a task report');
    }
  });
  it('teaches heads and members to end a turn with wait_for for external events, and the orchestrator to bind readiness messages to a task', () => {
    for (const id of ['hh-lead-tasks', 'hh-task-flow']) {
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
    const xhigh = ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-SEC', 'DEV-ARCH', 'DEV-RED', 'DEV-PERF'];
    const high = ['DEV-HEAD', 'DEV-TEST', 'DEV-QA', 'DEV-OPS', 'OPS-FIX', 'OPS-BUGS', 'OPS-INTEG', 'BIZ-ANALYST', 'FIN-AUDIT', 'FIN-FPA', 'DSN-SYS', 'DSN-UI', 'SUP-T2', 'HOM-NET', 'SAL-AE', 'MKT-WRITE'];
    for (const role of roles) expect(role.effort, role.id).toBe(xhigh.includes(role.id) ? 'xhigh' : high.includes(role.id) ? 'high' : 'medium');
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
    expect(ORCHESTRATOR_SKILLS).toEqual(['orch-outside-is-data', 'orch-interview', 'orch-plan-turn', 'orch-verify', 'orch-trouble']);
    const steady = orchestratorSteady(templates);
    /* His core rule stays whole in his instructions; the others are files his program reads when a step needs one. */
    expect(steady.text).toContain('<!-- hh:skill orch-outside-is-data -->');
    expect(steady.skills.map(f => f.name)).toEqual(['orch-interview', 'orch-plan-turn', 'orch-verify', 'orch-trouble']);
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
    for (const r of roles) if (r.kind === 'head') expect(r.gate, r.id).toBeNull();
  });

  it('teaches the task tools by their names', () => {
    const flow = templates.skills.get('hh-task-flow')!.body;
    for (const tool of ['task', 'submit', 'verdict', 'blocked', 'ask_person']) expect(flow, tool).toContain(`"${tool}"`);
    const lead = templates.skills.get('hh-lead-tasks')!.body;
    for (const tool of ['create_task', 'update_task', 'report', 'cancel_task', 'ask_person']) expect(lead, tool).toContain(`"${tool}"`);
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
    expect(dev.filter(r => !r.inDefault).map(r => r.id)).toEqual(['DEV-ARCH', 'DEV-BE', 'DEV-FE', 'DEV-TEST', 'DEV-OPS', 'DEV-RED', 'DEV-QA', 'DEV-DOCS', 'DEV-PERF']);
    expect(templates.roles.get('DSN-UI')!.perProduct).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
    for (const id of ['DEV-HEAD', 'DEV-ARCH', 'DEV-SEC']) expect(templates.roles.get(id)!.tier, id).toBe('deep');
  });

  it('takes ub-mode whole, with the tools it runs', () => {
    const rules = templates.skills.get('dev-engineering-rules')!.body;
    for (const words of ['Every time you are asked to make a change follow:', '* Use the crapper tool', '* Use the dryer tool to eliminate duplication that rank 0.8 or above.', '* Kill the survivors.', '* Push to the main line at the end.']) {
      expect(rules).toContain(words);
    }
    expect(rules).toContain('crapper, dryer and mutator are installed on your machine');
    expect(rules).toContain('Push your branch, not the main line');
    /* A submitted branch is committed, and --changed sees only what is not: the gates check what the branch changed. */
    const changed = 'git diff --name-only --diff-filter=d';
    for (const id of ['dev-engineering-rules', 'dev-review-diff', 'dev-test-gaps']) expect(templates.skills.get(id)!.body, id).toContain(changed);
    expect(templates.skills.get('dev-review-diff')!.body).toMatch(/crapper[\s\S]*dryer/);
    /* They are as objective as a failing test, so they block; the developer runs them before submitting. */
    expect(templates.skills.get('dev-review-diff')!.body).toMatch(/0\.8 or more is blocking, like a failing test/);
    expect(templates.skills.get('dev-review-diff')!.body).toMatch(/runs them before submitting/);
    expect(templates.skills.get('dev-review-verdict')!.body).toMatch(/CRAP 10 or more[\s\S]*counts as a failing test/);
    expect(templates.skills.get('dev-test-gaps')!.body).toContain('mutator');
    for (const s of skills.filter(x => x.id.startsWith('dev-'))) expect(s.body, s.id).not.toMatch(/(crapper|dryer|mutator) --changed/);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-TEST', 'DEV-SEC', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-language-rules')?.on, id).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV', 'DEV-TEST', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
  });

  it("runs the reviewer's program's own review on what the branch changed, besides the tools and the checklists", () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    for (const words of ['code-review skill at high effort', 'codex review --base <main line>', 'review-agent', 'Kimi Code has none']) expect(body('dev-review-diff'), words).toContain(words);
    for (const words of ['security-review skill', 'codex review --base <main line>', 'review-agent']) expect(body('dev-security-review'), words).toContain(words);
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
    expect(textOf('DEV-RED')).not.toMatch(/attack|hostile|exploit|secur|threat|inject|token|secret|атак|враждеб|безопасн|угроз|взлом/i);
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
    const texts = { 'dev-gates': templates.skills.get('dev-gates')!.body, 'dev-ci-release': templates.skills.get('dev-ci-release')!.body };
    for (const [id, text] of Object.entries(texts)) {
      expect(text, id).toContain('run_tests');
      expect(text, id).toMatch(/free machine/);
      expect(text, id).toMatch(/in parts/);
    }
  });

  it('lays each goal out whole, for one department, with new asks in the next turn', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(body('orch-plan-turn')).toMatch(/one task for the one department that owns it end to end/);
    expect(body('orch-plan-turn')).toMatch(/next turn[\s\S]*"now"/);
    for (const id of ['orch-plan-turn', 'hh-break-down']) expect(body(id), id).toMatch(/plans, contracts or proofs/);
    expect(body('hh-break-down')).toMatch(/two to four/);
    expect(body('hh-break-down')).not.toMatch(/a few hours of work/);
  });

  it('has heads give out big pieces at once, answer in comments and leave the work and the status to others', () => {
    const body = (id: string) => templates.skills.get(id)!.body;
    for (const id of ['hh-lead-tasks', 'hh-break-down']) expect(body(id), id).toMatch(/two to four/);
    for (const id of ['hh-lead-tasks', 'hh-brief-members']) expect(body(id), id).toMatch(/once/);
    /* A comment by whoever gave a blocked task out opens it again and wakes its executor, so a body is written once. */
    for (const id of ['hh-lead-tasks', 'hh-brief-members', 'hh-handle-reports']) expect(body(id), id).toMatch(/"comment"/);
    for (const id of ['hh-lead-tasks', 'hh-brief-members']) expect(body(id), id).toMatch(/only when the goal (itself )?changes/);
    expect(body('hh-lead-tasks')).not.toMatch(/rewrite the body as the current truth/);
    expect(body('hh-lead-tasks')).toMatch(/switches off members with no work in the turn/);
    expect(body('hh-lead-tasks')).toMatch(/notebook only when something it holds changes/);
    expect(body('hh-status-update')).toMatch(/one line/);
    for (const r of roles.filter(x => x.kind === 'head')) expect(r.body, r.id).not.toMatch(/status to the orchestrator|keep the orchestrator informed/);
    expect(templates.roles.get('DEV-HEAD')!.body).toMatch(/all at once/);
  });

  it('runs developers as a pool that each own a whole feature, with a short architect step before large work', () => {
    const role = (id: string) => templates.roles.get(id)!;
    const body = (id: string) => templates.skills.get(id)!.body;
    expect(role('DEV-ENG').body).toMatch(/whole feature: its plan, server, interface, tests and docs, on one branch/);
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
    expect(body('dev-review-diff')).toMatch(/write to nobody while you review/);
    expect(body('dev-review-diff')).toMatch(/you do not run mutator/);
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
    expect(gates).toMatch(/one review/);
    expect(gates).toMatch(/access, sign-in, secrets or permissions/);
    expect(gates).toMatch(/one reviewer of each provider/);
    expect(gates).toMatch(/once per turn, on the turn's branch/);
    expect(gates).toMatch(/risky or public-facing/);
    expect(templates.roles.get('DEV-QA')!.gate).toBeNull();
    expect(body('dev-review-diff')).toMatch(/[Oo]bvious security problems/);
    expect(body('hh-task-flow')).toMatch(/only if you sent it back/);
    expect(templates.roles.get('DEV-RED')!.body).toMatch(/risky or public-facing/);
    expect([...roles, ...skills].map(x => x.body).join('\n')).not.toMatch(/[Ee]very (employee|one) of a gate's role/);
    expect(gates).not.toMatch(/doubled/i);
    for (const id of ['dev-gates', 'dev-review-verdict', 'dev-review-diff']) expect(body(id), id).toMatch(/only the fixes/);
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
    expect(body('hh-task-flow')).not.toMatch(/run_tests/);
    const test = templates.roles.get('DEV-TEST')!;
    expect(test.gate).toBeNull();
    expect(test.body).toMatch(/never a gate on a task/);
    const gates = body('dev-gates');
    expect(gates).toMatch(/to the test engineer, or to the DevOps engineer when there is none, or runs run_tests itself when there is neither, never to a developer/);
    expect(gates).toMatch(/only what failed and the tests around it/);
    for (const id of ['dev-review-diff', 'dev-review-verdict']) expect(body(id), id).toMatch(/old complexity/);
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
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/touch(es)? the same files or records goes to the same member, as one batch/);
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/between different members is only for a finished result/);
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
    for (const id of ['dev-engineering-rules', 'dev-language-rules']) {
      const text = templates.skills.get(id)!.body;
      expect(text, id).toMatch(/do not install .* locally or work around .* tell the head of Development/i);
      for (const example of ['@vitest/coverage-v8', 'same version as vitest', 'pytest-cov', 'cargo-llvm-cov', 'Go has coverage built in', 'typescript-eslint', 'ruff', 'clippy', 'golangci-lint']) {
        expect(text, `${id}: ${example}`).toContain(example);
      }
    }
    const lead = templates.skills.get('hh-lead-tasks')!.body;
    expect(lead).toMatch(/first turn on a new project and when a new repository arrives/);
    expect(lead).toMatch(/one task that adds everything missing to the project itself/);
  });

  it.each(['DEV-ENG', 'DEV-REV', 'DEV-SEC'])('gives %s the project dependency setup before its checks', roleId => {
    const role = templates.roles.get(roleId)!;
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Bruno', roleKey: roleId, skills: role.skills.filter(s => s.on).map(s => s.id), overrides: {}, templateHashes: {} };
    const rendered = renderInstructions(templates, agent as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null });
    const rules = rendered.skills.find(s => s.name === 'dev-language-rules')!.body;
    expect(rules).toMatch(/dependencies before checks/);
    expect(rules).toMatch(/fresh clone or worktree/);
    expect(rules).toMatch(/after its lockfile changes/);
    expect(rules).toMatch(/from its lockfile with the project's standard command/);
    expect(rules).toMatch(/in any language/);
    for (const example of ['ESLint', 'Vite', 'Vitest', 'Playwright', 'npm ci', 'npm scripts', 'npx --no-install']) expect(rules, example).toContain(example);
    expect(rules).toMatch(/temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies/);
    expect(rules).toMatch(/imports resolve its `node_modules`/);
    expect(rules).toMatch(/ERR_MODULE_NOT_FOUND` before installing dependencies is not an application defect/);
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
});
