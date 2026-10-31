import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_INSTRUCTIONS, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_SKILLS, orchestratorSteady } from '../src/modules/agents/instructions.js';
import { NOTEBOOK_MAX, NOTES_MAX } from '../src/modules/notebook/book.js';
import { CORE_SKILLS, HEAD_SKILLS, loadTemplates, MEMBER_SKILLS } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];
/* What the rendered header around a role may take; Task 9 renders it. */
const HEADER_ALLOWANCE = 1500;

describe('templates', () => {
  it('loads every role and skill', () => {
    expect(roles.length).toBeGreaterThanOrEqual(30);
    expect(skills.length).toBeGreaterThanOrEqual(40);
    for (const s of skills) expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const r of roles) expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps roles short and skills small', () => {
    for (const r of roles) expect(r.body.length, r.id).toBeLessThanOrEqual(600);
    /* ub-mode is taken whole. */
    for (const s of skills) expect(s.body.length, s.id).toBeLessThanOrEqual(s.id === 'dev-engineering-rules' ? 4500 : 2500);
    for (const s of skills) expect(s.body.length, s.id).toBeGreaterThan(80);
  });

  it('renders every role with all skills under 19,000 characters', () => {
    for (const r of roles) {
      const total = HEADER_ALLOWANCE + r.body.length + r.skills.reduce((n, s) => n + templates.skills.get(s.id)!.body.length + 60, 0);
      expect(total, r.id).toBeLessThanOrEqual(19000);
    }
  });

  it("gives the orchestrator his own skills, which fit his instructions with a full notebook", () => {
    expect(ORCHESTRATOR_SKILLS).toEqual(['orch-interview', 'orch-plan-turn', 'orch-verify', 'orch-trouble']);
    const steady = orchestratorSteady(templates);
    for (const id of ORCHESTRATOR_SKILLS) expect(steady).toContain(`<!-- hh:skill ${id} -->`);
    /* The notebook's heading and a "[#30] " before each note come on top of its text. */
    expect(steady.length + NOTEBOOK_MAX + NOTES_MAX * 8 + 300).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
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

  it('names each role after its department code', () => {
    const codes: Record<string, string> = { operations: 'OPS', development: 'DEV', design: 'DSN', marketing: 'MKT', sales: 'SAL', business_development: 'BIZ', support: 'SUP', finance: 'FIN' };
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
    expect(gates('development')).toEqual(['DEV-REV', 'DEV-TEST', 'DEV-SEC', 'DEV-RED', 'DEV-QA']);
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

  it('follows the copy rules: no em dashes and no ё', () => {
    for (const x of [...roles, ...skills]) {
      const text = [x.body, x.title.en, x.title.ru, x.description.en, x.description.ru].join('\n');
      expect(text, x.id).not.toMatch(/[—ёЁ]/);
    }
  });

  it('has a task watchdog and a failure collector in operations, each waking on its own timer with the tools to watch', () => {
    const ops = templates.roster('operations');
    expect(ops.filter(r => r.inDefault).map(r => r.id)).toEqual(['OPS-HEAD', 'OPS-INTEG', 'OPS-ACCT', 'OPS-FIX', 'OPS-WATCH', 'OPS-BUGS']);
    const watch = templates.roles.get('OPS-WATCH')!;
    const bugs = templates.roles.get('OPS-BUGS')!;
    expect([watch.timer?.minutes, bugs.timer?.minutes]).toEqual([10, 180]);
    /* Neither goes on a round while nothing is open or failed. */
    expect([watch.timer?.forWork, bugs.timer?.forWork]).toEqual([true, true]);
    expect(watch.skills.find(s => s.id === 'ops-task-watch')?.on).toBe(true);
    expect(bugs.skills.find(s => s.id === 'ops-failure-review')?.on).toBe(true);
    expect(templates.skills.get('ops-task-watch')!.grants).toEqual(['agents', 'message_employee']);
    expect(templates.skills.get('ops-failure-review')!.grants).toEqual(['failures', 'agents', 'message_employee']);
    for (const r of roles) if (r.timer) expect(r.timer.order.length, r.id).toBeLessThanOrEqual(2000);
    expect(roles.filter(r => r.timer).map(r => r.id).sort()).toEqual(['OPS-BUGS', 'OPS-WATCH']);
  });

  it('has the full development roster', () => {
    const dev = templates.roster('development');
    const ids = dev.filter(r => r.inDefault).map(r => r.id);
    expect(ids).toEqual(['DEV-HEAD', 'DEV-ARCH', 'DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-TEST', 'DEV-OPS', 'DEV-SEC', 'DEV-RED', 'DEV-QA']);
    expect(dev.filter(r => !r.inDefault).map(r => r.id)).toEqual(['DEV-DOCS', 'DEV-PERF']);
    expect(templates.roles.get('DSN-UI')!.perProduct).toBe(true);
    for (const id of ['DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
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
    expect(templates.skills.get('dev-test-gaps')!.body).toContain('mutator');
    for (const s of skills.filter(x => x.id.startsWith('dev-'))) expect(s.body, s.id).not.toMatch(/(crapper|dryer|mutator) --changed/);
    for (const id of ['DEV-BE', 'DEV-FE', 'DEV-REV', 'DEV-TEST', 'DEV-SEC', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-language-rules')?.on, id).toBe(true);
    for (const id of ['DEV-BE', 'DEV-FE', 'DEV-ARCH', 'DEV-REV', 'DEV-TEST', 'DEV-PERF']) expect(templates.roles.get(id)!.skills.find(s => s.id === 'dev-engineering-rules')?.on, id).toBe(true);
  });

  it('writes development for any language and any kind of product', () => {
    const dev = [...roles.filter(r => r.department === 'development'), ...skills.filter(s => s.id.startsWith('dev-'))];
    for (const x of dev) expect(`${x.title.en} ${x.description.en} ${x.body}`, x.id).not.toMatch(/\b(Russian|English)\b/);
    const check = templates.skills.get('dev-browser-check')!.body;
    for (const surface of ['command-line tool', 'public API', 'library', 'Playwright']) expect(check).toContain(surface);
  });

  it('credits every source a skill names in SOURCES.md', () => {
    const credits = readFileSync(`${DIR}/SOURCES.md`, 'utf8');
    for (const s of skills) for (const src of s.sources) expect(credits, `${s.id} ${src}`).toContain(src.split(' ')[0]);
  });
});
