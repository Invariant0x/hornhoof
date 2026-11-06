import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_KEYS, type TemplateKey } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, departments } from '../src/db/schema.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';
import { as, setUpCompany, TEST_API_KEY, testApp } from './helpers.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);

/* The one pipeline skill of each department. The two home departments serve one family under the same rules. */
const PIPELINES: Record<TemplateKey, string> = {
  operations: 'ops-work-pipeline',
  development: 'dev-work-pipeline',
  design: 'dsn-work-pipeline',
  marketing: 'mkt-work-pipeline',
  sales: 'sal-work-pipeline',
  business_development: 'biz-work-pipeline',
  support: 'sup-work-pipeline',
  finance: 'fin-work-pipeline',
  home_devices: 'home-work-pipeline',
  household: 'home-work-pipeline',
};
const SKILL_IDS = [...new Set(Object.values(PIPELINES))];
const bodyOf = (id: string) => templates.skills.get(id)?.body ?? '';

const HEADINGS = {
  item: '## Item by item',
  batch: '## In a batch',
  sample: '## By sample',
  code: '## By code',
  model: '## By a model',
  about: '## Descriptions and measures',
} as const;
type Part = keyof typeof HEADINGS;
const PARTS = Object.keys(HEADINGS) as Part[];

/* What every department's skill says in the same words, and under which heading. */
const RULE = 'Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top.';
const SHARED: Record<'code' | 'model' | 'about', string[]> = {
  code: ['Each code check has fast tests, including cases it must reject.', 'A check named here that your tools do not run yet stays with a person, item by item, until they do.'],
  model: [
    'A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets.',
    'Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart.',
    'Every miss found in real work becomes a new example.',
    'Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass.',
    'An action that cannot be undone keeps its approval item by item, whatever a set shows.',
  ],
  about: ['A new company has these rules from its start and writes its descriptions on its first turn.', 'The pipeline report of a turn says when a department has none.'],
};

/* The sets a skill may link to; a check without one says that it has none. The set itself is private to the company. */
const SET_KINDS = ['outbound_review', 'support_reply_review', 'support_classification'];
const SET_LINKS: Record<string, string[]> = {
  'sup-work-pipeline': ['support_classification', 'support_reply_review'],
  'sal-work-pipeline': ['outbound_review'],
  'mkt-work-pipeline': ['outbound_review'],
  'biz-work-pipeline': ['outbound_review'],
};
const NO_SET = 'has no example set yet';
const WITHOUT_A_SET = ['dev-work-pipeline', 'dsn-work-pipeline', 'fin-work-pipeline', 'ops-work-pipeline', 'home-work-pipeline', 'mkt-work-pipeline'];

/* What each department's skill has to settle, where a reader looks for it. */
const OUTBOUND_CODE = [/price list/, /approved links/, /do-not-contact/, /consent/, /unsubscribe/, /daily limits/];
const POINTS: Record<string, Partial<Record<Part, RegExp[]>>> = {
  'sup-work-pipeline': {
    item: [/refund/, /legal question/, /personal data/, /sup-support-policy/],
    batch: [/knowledge base/, /sup-docs-from-tickets/],
    sample: [/sample/, /rate the department owner set/],
    code: [/Response targets/, /hours/, /reply gate/, /refund/, /personal data/],
    model: [/[Cc]lassifying[^.]*separate[^.]*draft/, /model-check-set:support_classification/, /model-check-set:support_reply_review/],
    about: [/SUP-HEAD/, /queue/, /share of replies/, /time to first reply/],
  },
  'fin-work-pipeline': {
    item: [/fin-spend-approval/, /every key number/],
    batch: [/maker/, /fin-close-management/],
    sample: [/fin-controls-testing/],
    code: [/fin-independent-recompute/, /SQL or a script/, /not a model/],
    about: [/FIN-HEAD/, /reconciliation accuracy/],
  },
  'dsn-work-pipeline': {
    item: [/author checks[^.]*before[^.]*Development/, /dsn-handoff/, /dsn-system-governance/],
    batch: [/DSN-QA/, /dsn-visual-qa/],
    sample: [/one product against the system/],
    model: [/dsn-design-critique/, /dsn-brand-consistency/],
    about: [/DSN-UI/, /DSN-SYS/, /product/],
  },
  'ops-work-pipeline': {
    item: [/blast radius/, /rollback plan/, /check/, /ops-change-request/],
    batch: [/one request/],
    code: [/ops-node-health/],
    about: [/OPS-HEAD/],
  },
  'home-work-pipeline': {
    item: [/every physical action/i, /home-real-world-approval/, /a person/],
    batch: [/one clear request/],
    about: [/HOM-HEAD/, /HHD-HEAD/],
  },
  'sal-work-pipeline': {
    item: [/outbound gate/, /sal-outbound-approval/, /fresh context/, /another provider/, /price, contract/, /one member/],
    batch: [/template/, /segment/],
    sample: [/stops the channel/],
    code: OUTBOUND_CODE,
    model: [/model-check-set:outbound_review/],
    about: [/SAL-HEAD/, /channel/],
  },
  'mkt-work-pipeline': {
    item: [/outbound gate/, /mkt-publish-approval/, /fresh context/, /another provider/],
    sample: [/stops the channel/],
    code: OUTBOUND_CODE,
    model: [/model-check-set:outbound_review/, /[Bb]rand/],
    about: [/MKT-HEAD/, /channel/],
  },
  'biz-work-pipeline': {
    item: [/outbound gate/, /signs/, /one member/],
    batch: [/biz-opportunity-scoring/],
    code: [/total/],
    model: [/model-check-set:outbound_review/],
    about: [/BIZ-HEAD/],
  },
  'dev-work-pipeline': {
    item: [/gate of its own/, /migration/, /money, access, security or data/, /exact commit/],
    batch: [/dev-gates/, /review of the turn/, /pinned commit/, /whole suite/],
    sample: [/[Mm]utation/, /pure logic/, /fast tests/],
    code: [/selected by impact/, /types/, /lint/, /crapper/, /dryer/],
    about: [/dev-test-environment/, /DEV-TEST/, /first turn/],
  },
};

/* One part of a skill, without its heading. */
function partOf(body: string, part: Part): string {
  const start = body.indexOf(`${HEADINGS[part]}\n`);
  if (start < 0) return '';
  const rest = body.slice(start + HEADINGS[part].length);
  const next = rest.indexOf('\n## ');
  return next < 0 ? rest : rest.slice(0, next);
}

const missing = (text: string, sentences: string[], where: string) => sentences.filter(s => !text.includes(s)).map(s => `${where} does not say: ${s}`);

function shapeProblems(body: string): string[] {
  const headings = [...body.matchAll(/^## .*$/gm)].map(m => m[0]);
  const wrong = headings.join() === Object.values(HEADINGS).join() ? [] : [`its headings are ${headings.join(', ')}`];
  return [...wrong, ...PARTS.filter(part => !/^- /m.test(partOf(body, part))).map(part => `nothing is listed under ${HEADINGS[part]}`)];
}

function ruleProblems(body: string): string[] {
  return [...missing(body, [RULE], 'the skill'), ...(['code', 'model', 'about'] as const).flatMap(part => missing(partOf(body, part), SHARED[part], HEADINGS[part]))];
}

const pointProblems = (id: string, body: string) =>
  (Object.entries(POINTS[id] ?? {}) as [Part, RegExp[]][]).flatMap(([part, wanted]) => wanted.filter(point => !point.test(partOf(body, part))).map(point => `${HEADINGS[part]} lacks ${point}`));

function setProblems(id: string, body: string): string[] {
  const named = [...body.matchAll(/model-check-set:([^\s`.,;:]*)/g)].map(m => m[1]!).sort();
  const expected = [...(SET_LINKS[id] ?? [])].sort();
  return [
    ...(named.join() === expected.join() ? [] : [`it links to the sets ${named.join(', ') || 'none'}, not ${expected.join(', ') || 'none'}`]),
    ...named.filter(kind => !SET_KINDS.includes(kind)).map(kind => `there is no set kind ${kind}`),
    ...(WITHOUT_A_SET.includes(id) && !partOf(body, 'model').includes(NO_SET) ? [`it does not say that a check ${NO_SET}`] : []),
  ];
}

/* Any company, project, language and channel: no task or rule numbers, dates, fixed amounts or names of one company. */
function abstractProblems(body: string): string[] {
  const found: string[] = [];
  if (/\d/.test(body)) found.push('it holds a number or a date');
  if (/[Ѐ-ӿ]/.test(body)) found.push('it is not in English');
  const named = body.match(/\b(Hornhoof|Ivan|David|GitHub|Anthropic|OpenAI|Google|Claude|Codex|Gemini|Kimi|Slack|Telegram|LinkedIn|Stripe)\b/);
  if (named) found.push(`it names ${named[0]}`);
  return found;
}

/* A skill it points to has to exist, or the reader finds nothing there. */
const unknownSkills = (body: string) =>
  [...new Set(body.match(/\b(?:dev|dsn|fin|sup|ops|sal|mkt|biz|home)-[a-z]+(?:-[a-z]+)*\b/g) ?? [])].filter(id => !templates.skills.has(id)).map(id => `it points to the skill ${id}, which does not exist`);

const problemsOf = (id: string, body: string) => [...shapeProblems(body), ...ruleProblems(body), ...pointProblems(id, body), ...setProblems(id, body), ...abstractProblems(body), ...unknownSkills(body)];

describe('the pipeline skill of a department', () => {
  it.each(TEMPLATE_KEYS)('is listed on, once, in the role of the head of %s and of no member', key => {
    const [head, ...members] = templates.roster(key);
    const listed = (skills: { id: string }[]) => skills.filter(s => s.id.endsWith('-work-pipeline'));
    expect(listed(head!.skills)).toEqual([{ id: PIPELINES[key], on: true, locked: false }]);
    for (const member of members) expect(listed(member.skills), member.id).toEqual([]);
  });

  it.each(SKILL_IDS)('%s says where work is checked by item, batch, sample and code, in the rules of its department', id => {
    expect(templates.skills.get(id)?.kind).toBe('procedure');
    expect(templates.skills.get(id)?.grants).toEqual([]);
    expect(problemsOf(id, bodyOf(id))).toEqual([]);
  });

  it.each([
    ['a heading gone', (b: string) => b.replace(HEADINGS.sample, '## Spot checks')],
    ['nothing listed under a heading', (b: string) => `${b.slice(0, b.indexOf(HEADINGS.batch))}${HEADINGS.batch}\n\nNone.\n\n${b.slice(b.indexOf(HEADINGS.sample))}`],
    ['the rule turned around', (b: string) => b.replace('only where', 'also where')],
    ['a person left out of a refund', (b: string) => b.replaceAll('refund', 'return of goods')],
    ['a made-up link to a set', (b: string) => `${b} \`model-check-set:brand_review\``],
    ['a link to a set dropped', (b: string) => b.replace('model-check-set:support_reply_review', 'its set')],
    ['a set that runs on every item', (b: string) => b.replace('not on every item', 'on every item')],
    ['a task number', (b: string) => `${b} See #323.`],
    ['a date', (b: string) => `${b} Since 2026-11-04.`],
    ['the name of a provider', (b: string) => `${b} Ask Claude.`],
    ['Russian text', (b: string) => `${b} Проверить.`],
    ['a skill that does not exist', (b: string) => `${b} See sup-no-such-skill.`],
  ])('is refused with %s', (_, broken) => {
    const body = bodyOf('sup-work-pipeline');
    expect(problemsOf('sup-work-pipeline', body)).toEqual([]);
    expect(problemsOf('sup-work-pipeline', broken(body))).not.toEqual([]);
  });

  it('goes through the one loader: a head that names it without its file does not load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-pipeline-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DIR, dir, { recursive: true });
    rmSync(join(dir, 'skills', 'sup-work-pipeline.md'), { force: true });
    expect(() => loadTemplates(dir)).toThrow(/SUP-HEAD\.md names the skill sup-work-pipeline/);
  });

  it('reaches a head hired from the roster of each department, as a file and whole on a node that writes none', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: TEMPLATE_KEYS.map(template => ({ template })) }, ...as(ceo) });
    expect(built.statusCode).toBeLessThan(300);
    const plan = await app.inject({ method: 'POST', url: '/api/subscriptions', payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Team key', apiKey: TEST_API_KEY, target: { kind: 'any' } }, ...as(ceo) });
    const subscription = plan.json().subscription.id as string;
    const seen = new Set<string>();
    for (const dept of await db.select().from(departments).where(isNull(departments.parentId))) {
      const key = dept.templateKey as TemplateKey;
      const { people } = (await app.inject({ url: `/api/departments/${dept.id}/roster`, ...as(ceo) })).json() as { people: object[] };
      const hired = await app.inject({ method: 'POST', url: `/api/departments/${dept.id}/staff`, payload: { people: people.map(line => ({ ...line, subscription })) }, ...as(ceo) });
      expect(hired.statusCode, `${key}: ${hired.body}`).toBe(201);
      const [head] = await db.select().from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head')));
      const id = PIPELINES[key];
      const asFile = await instructionsOf(app.ctx, head!);
      expect(asFile.skills.find(f => f.name === id)?.body, key).toContain(bodyOf(id));
      expect(asFile.text, key).toContain(`\n- ${id}: `);
      const whole = await instructionsOf(app.ctx, head!, false);
      expect(whole.text, key).toContain(bodyOf(id));
      seen.add(key);
    }
    expect([...seen].sort()).toEqual([...TEMPLATE_KEYS].sort());
  });
});
