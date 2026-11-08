import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';
import { fixture } from './development-echelons-fixture.js';

describe('optional Cleanup from instruction 207', () => {
  it('has no Cleanup stage by default, including risky work', async () => {
    const f = await fixture({ riskClass: 'security' });
    expect((await f.detail()).echelons.stages.map(step => step.stage)).toEqual(['architecture', 'development', 'review', 'security', 'tests']);
  });

  it('inserts Cleanup only after Review when the head requests it', async () => {
    const f = await fixture({ cleanup: true });
    expect((await f.detail()).echelons.stages.map(step => step.stage)).toEqual(['architecture', 'development', 'review', 'cleanup', 'security', 'tests']);
  });

  it('does not let a worker add an optional stage', async () => {
    await expect(fixture({ cleanup: true, creator: 'author' }).then(() => null)).rejects.toMatchObject({ status: 403 });
  });

  it('offers the existing cleanup ability off by default to developers and reviewers', () => {
    const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
    expect(templates.skills.has('dev-cleanup')).toBe(true);
    for (const id of ['DEV-ENG', 'DEV-BE', 'DEV-FE', 'DEV-REV']) {
      expect(templates.roles.get(id)?.skills.find(skill => skill.id === 'dev-cleanup'), id).toMatchObject({ on: false, locked: false });
    }
  });
});
