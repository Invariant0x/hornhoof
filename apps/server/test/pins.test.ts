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

  /* A tag can point at another image tomorrow; a digest is the one image the build was checked with. */
  it('builds every image from a base image pinned by digest', () => {
    const from = ['Dockerfile', 'apps/node/Dockerfile', 'apps/updater/Dockerfile'].flatMap(f => read(f).split('\n').filter(l => l.startsWith('FROM ')));
    expect(from).toHaveLength(9);
    for (const line of from) expect(line).toMatch(/ [\w.-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
  });

  it('runs the database from an image pinned by digest', () => {
    expect(read('compose.yaml')).toMatch(/^ {4}image: postgres:17\.\d+@sha256:[0-9a-f]{64}$/m);
  });

  /* install.sh writes them into .env: by digest from the updater, which checked them, or by the build's tag. */
  it("runs Hornhoof's own images as .env names them", () => {
    const images = read('compose.yaml').split('\n').filter(l => /^ {4}image: /.test(l)).map(l => l.trim());
    expect(images).toEqual([
      'image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}',
      expect.stringMatching(/^image: postgres:/),
      'image: ${HORNHOOF_NODE_REF:-ghcr.io/invariant0x/hornhoof-node:latest}',
      'image: ${HORNHOOF_UPDATER_REF:-ghcr.io/invariant0x/hornhoof-updater:latest}',
    ]);
  });
});
