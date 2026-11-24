import { fileURLToPath } from 'node:url';
import { LOCALES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { copyTemplates, loadTemplates, type Role, type Skill, type Templates } from '../src/modules/templates/load.js';

/* The product's policy for every text Hornhoof ships to an agent, written once: each rule names what no skill and no role
   may say in its id, titles, descriptions or body, with an example it catches. What one text must say stays with the test
   of that text, how the texts are read with templates-load.test.ts and how they reach an agent with instructions.test.ts. */
type Rule = { id: string; forbids: [RegExp, string][]; spares?: ReadonlySet<string> };

const PRODUCT_POLICY: Rule[] = [
  {
    /* Only an irreversible deletion needs the CEO: what goes out of the company waits for nobody unless its department
       set a rule for it. A shared operations change keeps its own approval. */
    id: 'what goes out waits for nobody',
    spares: new Set(['ops-change-request']),
    forbids: [
      [/\b(?:each|every) (?:exact )?public (?:item|post|variant|reply|change)\b[^.!?]*\b(?:requires?|needs?|retains?)\b[^.!?]*\bapproval\b/i, 'Each public post requires approval.'],
      [/\bpublic (?:items?|content|changes|use|proposals|publishing|russian content)\b[^.!?]*\b(?:requires?|retains?|needs?|waits? for(?! nobody| no one))\b[^.!?]*\bapproval\b/i, 'Public content waits for approval.'],
      [/\bper-item approval\b/i, 'Ask for per-item approval.'],
      [/\bexplicit (?:human )?approval of\b/i, 'Get explicit human approval of the reply.'],
      [/\bexact (?:human )?approval\b/i, 'It needs exact approval.'],
      [/\bapplicable (?:exact )?approval\b/i, 'Keep the applicable approval.'],
      [/\bexact (?:item or approach|message) approval\b/i, 'Wait for exact message approval.'],
      [/\b(?:Creating accounts|New accounts)[^.!?]*\bCEO's approval\b/i, "New accounts wait for the CEO's approval."],
    ],
  },
  /* The one Security rule, external checkers only in echelon tasks, took the place of the old scope. */
  { id: 'the old Security scope nowhere', forbids: [[/urgent work, small tasks, direct named orders/i, 'This applies to urgent work, small tasks, direct named orders and review fixes.']] },
  /* No node gives an agent obra/superpowers any more. */
  { id: 'no superpowers', forbids: [[/superpowers/i, 'Use the superpowers skills.']] },
];

const textsOf = (item: Skill | Role): string[] => [item.id, ...Object.values(item.title), ...Object.values(item.description), item.body].filter((text): text is string => text !== undefined);

function policyProblems(templates: Templates): string[] {
  const shipped = [...templates.skills.values(), ...templates.roles.values()];
  return PRODUCT_POLICY.flatMap(rule =>
    shipped
      .filter(item => !rule.spares?.has(item.id))
      .flatMap(item => rule.forbids.filter(([pattern]) => textsOf(item).some(text => pattern.test(text))).map(([pattern]) => `${item.id}: ${rule.id} ${pattern}`)),
  );
}

const shipped = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const examples = PRODUCT_POLICY.flatMap(rule => rule.forbids.map(([pattern, example]) => ({ rule, pattern, example })));
const said = (rule: Rule, pattern: RegExp) => (problems: string[], id: string) => problems.includes(`${id}: ${rule.id} ${pattern}`);

describe('the product policy over every skill and role Hornhoof ships', () => {
  it('holds for every skill and every role', () => {
    expect(policyProblems(shipped)).toEqual([]);
  });

  it.each(examples)('catches "$example" in a skill and in a role', ({ rule, pattern, example }) => {
    expect(example).toMatch(pattern);
    const copy = copyTemplates(shipped);
    const skill = copy.skills.get('hh-tasks')!;
    const role = copy.roles.get('DEV-ENG')!;
    copy.skills.set(skill.id, { ...skill, body: `${skill.body}\n${example}` });
    copy.roles.set(role.id, { ...role, body: `${role.body} ${example}` });
    const problems = policyProblems(copy);
    expect(said(rule, pattern)(problems, 'hh-tasks'), String(problems)).toBe(true);
    expect(said(rule, pattern)(problems, 'DEV-ENG'), String(problems)).toBe(true);
  });

  it.each(['title', 'description'] as const)('reads the %s of a skill in every language of the registry too', field => {
    const [{ rule, pattern, example }] = examples;
    for (const { id: lang } of LOCALES) {
      const copy = copyTemplates(shipped);
      const skill = copy.skills.get('hh-mail')!;
      copy.skills.set(skill.id, { ...skill, [field]: { ...skill[field], [lang]: example } });
      expect(said(rule!, pattern!)(policyProblems(copy), 'hh-mail'), `${field} ${lang}`).toBe(true);
    }
  });

  it('spares only the skill a rule names', () => {
    const rule = PRODUCT_POLICY.find(r => r.spares)!;
    const [pattern, example] = rule.forbids[0]!;
    const copy = copyTemplates(shipped);
    for (const id of ['ops-change-request', 'ops-intake']) {
      const skill = copy.skills.get(id)!;
      copy.skills.set(id, { ...skill, body: `${skill.body}\n${example}` });
    }
    const problems = policyProblems(copy);
    expect(said(rule, pattern)(problems, 'ops-change-request')).toBe(false);
    expect(said(rule, pattern)(problems, 'ops-intake')).toBe(true);
  });
});
