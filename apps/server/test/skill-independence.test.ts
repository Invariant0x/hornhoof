import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const names = [...templates.skills.keys()];

function references(text: string, ownId?: string): string[] {
  return names.filter(id => id !== ownId && new RegExp(`(?<![a-z0-9-])${id}(?![a-z0-9-])`).test(text));
}

describe('independent skill bricks', () => {
  it('gives every skill a body that needs no other catalog skill', () => {
    const violations = [...templates.skills.values()]
      .map(skill => ({ id: skill.id, references: references(skill.body, skill.id) }))
      .filter(skill => skill.references.length > 0);
    expect(violations, `${violations.length} skills name other skills`).toEqual([]);
  });

  it('keeps references to skills out of every role body', () => {
    const violations = [...templates.roles.values()]
      .map(role => ({ id: role.id, references: references(role.body) }))
      .filter(role => role.references.length > 0);
    expect(violations, `${violations.length} roles name skills`).toEqual([]);
  });
});
