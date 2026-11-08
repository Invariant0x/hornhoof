import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));

describe('standalone skills of the forward route', () => {
  it.each([['DEV-REV', 'dev-review-fix'], ['DEV-SEC', 'dev-security-fix']])('gives %s an independent %s ability', (roleId, skillId) => {
    const role = templates.roles.get(roleId)!;
    expect(role.skills.find(skill => skill.id === skillId)).toMatchObject({ on: true });
    expect(templates.skills.has(skillId)).toBe(true);
    expect(role.body.length).toBeLessThan(400);
  });
  it('starts the default reviewer at the deep capability tier', () => {
    expect(templates.roles.get('DEV-REV')?.tier).toBe('deep');
  });
});
