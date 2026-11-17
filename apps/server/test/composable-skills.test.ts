import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));

describe('standalone employee abilities', () => {
  it("keeps work that calls Hornhoof's tools inside the answer, never with a helper left running after it, and never asks to write again", () => {
    const body = templates.skills.get('hh-hornhoof')!.body;
    expect(body).toMatch(/Hornhoof's tools work only until your answer ends; a helper still running then, such as a background agent, loses them\./);
    expect(body).toMatch(/Finish work that calls them in this answer, yourself or with helpers you wait for\. A request does not end with your answer: what is yours to do you finish in a later turn of yours\. Never ask a person to write again so a tool works\./);
  });

  it('defines any numbered local policy label within the ability that uses it', () => {
    for (const skill of templates.skills.values()) {
      const labels = new Set(skill.body.match(/\bT\d+\b/g) ?? []);
      for (const label of labels) expect(skill.body, `${skill.id}: ${label}`).toMatch(new RegExp(`\\*\\*${label}:`));
    }
  });

  it('gives every department one-sentence identities instead of role workflows', () => {
    expect(new Set([...templates.roles.values()].map(r => r.department)).size).toBe(10);
    for (const role of templates.roles.values()) {
      expect(role.body, role.id).toMatch(/^You are [^\n.!?]+\.$/);
      expect(role.body, role.id).not.toMatch(/\b(?:must|never|always|submit|run_tests|after|before|then)\b|\b(?:hh|dev|dsn|fin|sup|ops|sal|mkt|biz|home|orch)-[a-z]+/i);
    }
  });

  it('has no generalist role or catch-all skill that replaces a skill selection', () => {
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    for (const item of [...templates.roles.values(), ...templates.skills.values()]) {
      expect(`${item.title.en}\n${item.title.ru}`, item.id).not.toMatch(/\b(?:generalist|universal)\b|универсал/i);
    }
  });

  it('keeps unconditional turn workflows out of role descriptions as well as their bodies', () => {
    const route = /\b(?:each turn|whole turn|before a new or large feature|at once)\b|всего хода|работу хода один раз|до того, как строят|частями одновременно/i;
    const violations = [...templates.roles.values()].filter(role => route.test(`${role.description.en}\n${role.description.ru}`));
    expect(violations.map(role => role.id)).toEqual([]);
  });

  it('keeps the orchestrator identity free of a workflow or skill dependency', () => {
    expect(ORCHESTRATOR_INSTRUCTIONS).toMatch(/^You are [^\n.!?]+\.$/);
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/hh-lead-tasks|Your skills|Call departments/);
  });

  it('does not assign downstream checking merely because a skill is selected', () => {
    for (const skill of templates.skills.values()) {
      expect(skill.body, skill.id).not.toMatch(/then hand it to a tester|the test engineer or QA owns all (?:remaining|other|final) checks|the turn's review and testing gates still follow/i);
    }
  });

  it('delivers assignment-scoped descriptions rather than a mandatory route', () => {
    const role = templates.roles.get('SUP-T2')!;
    const selected = ['dev-gates', 'dev-ci-release', 'dev-qa-acceptance'];
    const packet = renderInstructions(templates, {
      id: 'a', companyId: 'c', kind: 'worker', name: 'Alex', roleKey: role.id,
      skills: selected, overrides: {}, templateHashes: {},
    } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Support', product: null });
    for (const id of selected) {
      const ability = packet.skills.find(file => file.name === id)!;
      expect(ability.description, id).toMatch(/assign(?:ed|ment)|authoriz(?:ed|ation)|task/i);
      expect(packet.text, id).toContain(ability.description);
      expect(ability.description, id).not.toMatch(/each turn through four gates|review and testing run once per turn/i);
    }
    expect(templates.skills.get('dev-lead')!.description.en).not.toMatch(/generalist/i);
    expect(templates.skills.get('dev-lead')!.description.ru).not.toMatch(/универсал/i);
  });

  it('requires the exact-candidate approval of the department owner or the CEO in the standalone delivered release ability', () => {
    const packet = renderInstructions(templates, {
      id: 'a', companyId: 'c', kind: 'worker', name: 'Alex', roleKey: 'SUP-T2',
      skills: ['dev-ci-release'], overrides: {}, templateHashes: {},
    } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Support', product: null });
    const release = packet.skills.find(file => file.name === 'dev-ci-release')!;
    expect(release.body).toMatch(/its owner, or the CEO when it has none\. Obtain their explicit yes for that exact candidate/);
  });

  it('renders one selected ability intact across department identities', () => {
    const roles = [...new Map([...templates.roles.values()].map(role => [role.department, role])).values()];
    for (const role of roles) {
      for (const skill of templates.skills.values()) {
        const packet = renderInstructions(templates, {
          id: 'a', companyId: 'c', kind: role.kind === 'head' ? 'head' : 'worker', name: 'Alex', roleKey: role.id,
          skills: [skill.id], overrides: {}, templateHashes: {},
        } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: role.department, product: null });
        expect(packet.parts.find(part => part.id === skill.id)?.text, `${role.id} ${skill.id}`).toContain(skill.body);
      }
    }
  });
});
