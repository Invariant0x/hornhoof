import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('what the build runs', () => {
  /* The workflow can write packages, so a moved tag of an action would publish whatever that action now does. */
  it('pins every GitHub action to a full commit and names its version', () => {
    const uses = read('.github/workflows/images.yml').split('\n').filter(l => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});
