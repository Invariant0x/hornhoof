import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));

describe('standalone employee abilities', () => {
  it('ships each skill without calls to another catalog skill', () => {
    const edges: string[] = [];
    for (const skill of templates.skills.values()) {
      for (const other of templates.skills.keys()) {
        if (other !== skill.id && new RegExp(`(?<![a-z0-9-])${other}(?![a-z0-9-])`).test(skill.body)) edges.push(`${skill.id} -> ${other}`);
      }
    }
    expect(edges).toEqual([]);
  });

  it('gives every department short identities instead of role workflows', () => {
    expect(new Set([...templates.roles.values()].map(r => r.department)).size).toBe(10);
    for (const role of templates.roles.values()) {
      expect(role.body, role.id).toMatch(/^You are [^\n.!?]+\.$/);
      expect(role.body.length, role.id).toBeLessThanOrEqual(180);
      expect(role.body, role.id).not.toMatch(/\b(?:must|never|always|submit|run_tests|after|before|then)\b|\b(?:hh|dev|dsn|fin|sup|ops|sal|mkt|biz|home|orch)-[a-z]+/i);
    }
  });

  it('has no generalist role or catch-all skill that replaces a skill selection', () => {
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    for (const item of [...templates.roles.values(), ...templates.skills.values()]) {
      expect(`${item.title.en}\n${item.title.ru}`, item.id).not.toMatch(/\b(?:generalist|universal)\b|универсал/i);
    }
  });

  it('does not assign downstream checking merely because a skill is selected', () => {
    for (const skill of templates.skills.values()) {
      expect(skill.body, skill.id).not.toMatch(/then hand it to a tester|the test engineer or QA owns all (?:remaining|other|final) checks|the turn's review and testing gates still follow/i);
    }
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
