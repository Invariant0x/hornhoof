import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)?.body ?? '';
const repairs = [['DEV-REV', 'dev-review-fix'], ['DEV-SEC', 'dev-security-fix']] as const;

describe('development echelon abilities', () => {
  it.each(repairs)('gives %s separate selected abilities to check and repair', (roleId, skillId) => {
    const role = templates.roles.get(roleId)!;
    expect(role.skills.find(skill => skill.id === skillId)).toMatchObject({ on: true, locked: false });
    expect(role.skills.find(skill => skill.id === (roleId === 'DEV-REV' ? 'dev-review-diff' : 'dev-security-review'))?.on).toBe(true);
    expect(templates.skills.get(skillId)).toMatchObject({ kind: 'procedure', grants: [] });
  });

  it.each(repairs)('delivers the repair ability of %s alone across department identities', (_, skillId) => {
    for (const roleKey of ['DEV-ENG', 'SUP-T2']) {
      const packet = renderInstructions(templates, {
        id: 'a', companyId: 'c', kind: 'worker', name: 'Ari', roleKey,
        skills: [skillId], overrides: {}, templateHashes: {},
      } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Work', product: null });
      expect(packet.skills.map(skill => skill.name)).toContain(skillId);
      const repair = packet.skills.find(skill => skill.name === skillId)!.body;
      expect(repair).toContain(body(skillId));
      expect(repair).toMatch(/current (?:stage )?owner/i);
      expect(repair).toMatch(/failing (?:regression )?test[\s\S]*run_tests/);
      expect(repair).toMatch(/exact (?:candidate|commit|SHA)/i);
      expect(repair).toMatch(/forward[\s\S]*never return[\s\S]*author/i);
      expect(repair).toMatch(/wrong goal[\s\S]*head/i);
      expect(repair).toMatch(/scope[\s\S]*branch[\s\S]*one writer/i);
      expect(repair).toMatch(/independent Security[\s\S]*shared branch/i);
    }
  });

  it('offers a deeper review tier without inventing an echelon role', () => {
    expect(templates.roles.get('DEV-ENG')!.tier).toBe('standard');
    expect(templates.roles.get('DEV-REV')!.tier).toBe('deep');
    expect(templates.roster('development').filter(role => role.inDefault).map(role => role.id)).toEqual(['DEV-HEAD', 'DEV-ENG', 'DEV-REV', 'DEV-SEC']);
  });

  it('teaches the assigned route without installing it merely by selecting a skill', () => {
    const route = body('dev-gates');
    expect(route).toMatch(/task\.echelons/);
    expect(route).toMatch(/Architecture[\s\S]*Development[\s\S]*Review[\s\S]*Security[\s\S]*Tests/);
    expect(route).toMatch(/small[\s\S]*skip Architecture/i);
    expect(route).toMatch(/Review is always required/);
    expect(route).toMatch(/head[\s\S]*risk[\s\S]*Review[\s\S]*add Security/i);
    expect(route).toMatch(/different models[\s\S]*stronger/);
    expect(route).toMatch(/Claude reviews Codex[\s\S]*Codex never reviews Claude/);
    expect(route).toMatch(/unknown[\s\S]*waiting[\s\S]*head/i);
    expect(route).toMatch(/same-model[\s\S]*fallback/i);
    expect(route).toMatch(/Matrix and Performance[\s\S]*outside/);
    expect(route).toMatch(/metrics[\s\S]*evidence[\s\S]*head[\s\S]*never automatically/i);
  });

  it('keeps echelon repairs forward while preserving immutable legacy gate reviews', () => {
    for (const id of ['dev-review-verdict', 'hh-fix-loop']) {
      expect(body(id), id).toMatch(/task\.echelons[\s\S]*current (?:stage )?owner[\s\S]*forward/);
      expect(body(id), id).toMatch(/wrong goal[\s\S]*head/i);
      expect(body(id), id).toMatch(/legacy/i);
    }
    expect(body('dev-review-verdict')).toContain('Never approve your own independent gate or edit the change you are assigned to judge');
  });
});
